//! Path containment + sensitive-path deny list for workspace tools.

use std::path::{Component, Path, PathBuf};

/// Stable error codes returned to the model (also human-readable via Display).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyError {
    Disabled,
    EmptyPath,
    AbsolutePath,
    InvalidPath,
    OutsideWorkspace,
    DeniedPath,
    NotFound,
    NotAFile,
    NotADirectory,
    TooLarge,
    Binary,
    Io(String),
}

impl PolicyError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::EmptyPath => "empty_path",
            Self::AbsolutePath => "absolute_path",
            Self::InvalidPath => "invalid_path",
            Self::OutsideWorkspace => "outside_workspace",
            Self::DeniedPath => "denied_path",
            Self::NotFound => "not_found",
            Self::NotAFile => "not_a_file",
            Self::NotADirectory => "not_a_directory",
            Self::TooLarge => "too_large",
            Self::Binary => "binary",
            Self::Io(_) => "io_error",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Disabled => "Workspace tools are disabled or no workspace folder is set".into(),
            Self::EmptyPath => "Path must not be empty".into(),
            Self::AbsolutePath => "Paths must be relative to the workspace root".into(),
            Self::InvalidPath => "Path contains invalid characters or components".into(),
            Self::OutsideWorkspace => "Path resolves outside the workspace root".into(),
            Self::DeniedPath => "Access to this path is blocked by policy".into(),
            Self::NotFound => "Path not found".into(),
            Self::NotAFile => "Path is not a file".into(),
            Self::NotADirectory => "Path is not a directory".into(),
            Self::TooLarge => "File exceeds the maximum allowed size".into(),
            Self::Binary => "Binary files are not supported by workspace tools in v1".into(),
            Self::Io(msg) => msg.clone(),
        }
    }
}

/// Validated absolute workspace root.
#[derive(Debug, Clone)]
pub struct WorkspaceRoot {
    canonical: PathBuf,
}

impl WorkspaceRoot {
    pub fn try_new(path: impl AsRef<Path>) -> Result<Self, PolicyError> {
        let path = path.as_ref();
        if path.as_os_str().is_empty() {
            return Err(PolicyError::EmptyPath);
        }
        let canonical = std::fs::canonicalize(path)
            .map_err(|e| PolicyError::Io(format!("workspace root is not accessible: {e}")))?;
        if !canonical.is_dir() {
            return Err(PolicyError::NotADirectory);
        }
        Ok(Self { canonical })
    }

    pub fn path(&self) -> &Path {
        &self.canonical
    }
}

/// Resolve a relative path that must already exist (read/grep/edit).
pub fn resolve_existing(root: &WorkspaceRoot, user_path: &str) -> Result<PathBuf, PolicyError> {
    let joined = join_relative(root, user_path)?;
    let canonical = std::fs::canonicalize(&joined).map_err(|_| PolicyError::NotFound)?;
    assert_within(root, &canonical)?;
    assert_allowed(&canonical)?;
    Ok(canonical)
}

/// Resolve a path for write/create. Parent must exist (or be created by caller
/// after this returns a path still verified under root).
pub fn resolve_for_write(root: &WorkspaceRoot, user_path: &str) -> Result<PathBuf, PolicyError> {
    let joined = join_relative(root, user_path)?;
    // Deny-list check on the logical path before create.
    assert_allowed(&joined)?;

    if joined.exists() {
        let canonical =
            std::fs::canonicalize(&joined).map_err(|e| PolicyError::Io(e.to_string()))?;
        assert_within(root, &canonical)?;
        assert_allowed(&canonical)?;
        if !canonical.is_file() {
            return Err(PolicyError::NotAFile);
        }
        return Ok(canonical);
    }

    // Walk up to an existing ancestor, canonicalize it, then re-join the
    // remaining relative suffix so we never accept a symlink escape.
    let mut ancestor = joined.parent().map(Path::to_path_buf);
    let mut missing_tail: Vec<std::ffi::OsString> = Vec::new();
    missing_tail.push(
        joined
            .file_name()
            .ok_or(PolicyError::InvalidPath)?
            .to_os_string(),
    );

    while let Some(ref current) = ancestor {
        if current.exists() {
            break;
        }
        if let Some(name) = current.file_name() {
            missing_tail.push(name.to_os_string());
        }
        ancestor = current.parent().map(Path::to_path_buf);
    }

    let Some(existing_ancestor) = ancestor else {
        return Err(PolicyError::OutsideWorkspace);
    };

    let canonical_ancestor =
        std::fs::canonicalize(&existing_ancestor).map_err(|e| PolicyError::Io(e.to_string()))?;
    assert_within(root, &canonical_ancestor)?;

    let mut resolved = canonical_ancestor;
    for part in missing_tail.into_iter().rev() {
        resolved.push(part);
        assert_allowed(&resolved)?;
        assert_within_logical(root, &resolved)?;
    }
    Ok(resolved)
}

fn join_relative(root: &WorkspaceRoot, user_path: &str) -> Result<PathBuf, PolicyError> {
    let trimmed = user_path.trim();
    if trimmed.is_empty() {
        return Err(PolicyError::EmptyPath);
    }
    if trimmed.contains('\0') {
        return Err(PolicyError::InvalidPath);
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err(PolicyError::AbsolutePath);
    }
    // Reject Windows device / UNC quirks that Path::is_absolute may miss on
    // some inputs when run cross-platform in tests.
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("\\\\") || lower.starts_with("//") || lower.starts_with("\\\\?\\") {
        return Err(PolicyError::AbsolutePath);
    }

    for component in path.components() {
        match component {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                // ParentDir is allowed in the string but must still land inside
                // root after join+canonicalize. We still reject RootDir/Prefix.
                if matches!(component, Component::RootDir | Component::Prefix(_)) {
                    return Err(PolicyError::AbsolutePath);
                }
            }
            Component::Normal(name) => {
                let name = name.to_string_lossy();
                if name.contains('\0') {
                    return Err(PolicyError::InvalidPath);
                }
            }
            Component::CurDir => {}
        }
    }

    Ok(root.path().join(path))
}

fn assert_within(root: &WorkspaceRoot, candidate: &Path) -> Result<(), PolicyError> {
    if is_within(root.path(), candidate) {
        Ok(())
    } else {
        Err(PolicyError::OutsideWorkspace)
    }
}

/// Soft containment for not-yet-created paths under a canonical ancestor.
fn assert_within_logical(root: &WorkspaceRoot, candidate: &Path) -> Result<(), PolicyError> {
    if is_within(root.path(), candidate) {
        Ok(())
    } else {
        Err(PolicyError::OutsideWorkspace)
    }
}

pub(crate) fn is_within(root: &Path, candidate: &Path) -> bool {
    let root_comps: Vec<_> = root.components().collect();
    let cand_comps: Vec<_> = candidate.components().collect();
    if cand_comps.len() < root_comps.len() {
        return false;
    }
    cand_comps
        .iter()
        .zip(root_comps.iter())
        .all(|(a, b)| a == b)
}

pub fn assert_allowed(path: &Path) -> Result<(), PolicyError> {
    if is_denied(path) {
        Err(PolicyError::DeniedPath)
    } else {
        Ok(())
    }
}

/// True if any path component matches the sensitive-name deny list.
pub fn is_denied(path: &Path) -> bool {
    path.components().any(|c| match c {
        Component::Normal(name) => component_denied(&name.to_string_lossy()),
        _ => false,
    })
}

fn component_denied(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower == ".env" || lower.starts_with(".env.") {
        return true;
    }
    if matches!(
        lower.as_str(),
        ".ssh" | ".aws" | ".gnupg" | ".npmrc" | ".netrc" | "credentials" | "credentials.json"
    ) {
        return true;
    }
    if lower == "id_rsa" || lower == "id_ed25519" || lower.starts_with("id_rsa.") {
        return true;
    }
    if lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".p12")
        || lower.ends_with(".pfx")
    {
        return true;
    }
    if lower == "cookies" || lower.starts_with("cookie") {
        return true;
    }
    false
}

/// Skip heavy / VCS trees during glob/grep walks.
pub fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".git" | ".svn" | ".hg" | "target" | "dist" | "build" | ".next" | ".turbo"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn relative_read_inside_root() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        fs::write(&file, "hi").unwrap();
        let root = WorkspaceRoot::try_new(dir.path()).unwrap();
        let resolved = resolve_existing(&root, "notes.txt").unwrap();
        assert_eq!(resolved, fs::canonicalize(&file).unwrap());
    }

    #[test]
    fn rejects_parent_escape() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("ws");
        fs::create_dir(&nested).unwrap();
        fs::write(dir.path().join("secret.txt"), "x").unwrap();
        let root = WorkspaceRoot::try_new(&nested).unwrap();
        let err = resolve_existing(&root, "../secret.txt").unwrap_err();
        assert_eq!(err, PolicyError::OutsideWorkspace);
    }

    #[test]
    fn rejects_absolute() {
        let dir = tempdir().unwrap();
        let root = WorkspaceRoot::try_new(dir.path()).unwrap();
        let abs = dir.path().join("a.txt");
        fs::write(&abs, "x").unwrap();
        let err = resolve_existing(&root, &abs.to_string_lossy()).unwrap_err();
        assert_eq!(err, PolicyError::AbsolutePath);
    }

    #[test]
    fn denies_env_file() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(".env"), "SECRET=1").unwrap();
        let root = WorkspaceRoot::try_new(dir.path()).unwrap();
        let err = resolve_existing(&root, ".env").unwrap_err();
        assert_eq!(err, PolicyError::DeniedPath);
    }

    #[test]
    fn denies_pem_suffix() {
        assert!(component_denied("server.pem"));
        assert!(component_denied("ID_RSA"));
        assert!(!component_denied("readme.md"));
    }

    #[test]
    fn write_new_file_under_root() {
        let dir = tempdir().unwrap();
        let root = WorkspaceRoot::try_new(dir.path()).unwrap();
        let path = resolve_for_write(&root, "nested/out.txt").unwrap();
        assert!(is_within(root.path(), &path));
        assert!(path.ends_with("out.txt"));
    }

    #[test]
    fn write_denied_env() {
        let dir = tempdir().unwrap();
        let root = WorkspaceRoot::try_new(dir.path()).unwrap();
        let err = resolve_for_write(&root, ".env").unwrap_err();
        assert_eq!(err, PolicyError::DeniedPath);
    }
}
