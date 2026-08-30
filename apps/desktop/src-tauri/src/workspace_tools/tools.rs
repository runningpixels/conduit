//! Workspace tool executors.

use super::path_policy::{
    assert_allowed, is_denied, resolve_existing, resolve_for_write, should_skip_dir, PolicyError,
    WorkspaceRoot,
};
use super::secret_redact::redact_json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

pub const DEFAULT_READ_MAX_BYTES: u64 = 256 * 1024;
pub const DEFAULT_GLOB_MAX: usize = 500;
pub const DEFAULT_GREP_MAX: usize = 100;
pub const DEFAULT_GREP_LINE_MAX: usize = 2_000;

#[derive(Debug, Clone)]
pub struct WorkspaceToolConfig {
    pub root: PathBuf,
}

impl WorkspaceToolConfig {
    pub fn open(&self) -> Result<WorkspaceRoot, PolicyError> {
        WorkspaceRoot::try_new(&self.root)
    }
}

#[derive(Debug, Deserialize)]
pub struct ReadInput {
    pub path: String,
    pub offset: Option<u64>,
    pub limit: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct WriteInput {
    pub path: String,
    pub content: String,
    pub create_dirs: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct EditInput {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct GlobInput {
    pub pattern: String,
    pub max_results: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct GrepInput {
    pub pattern: String,
    pub path: Option<String>,
    pub glob: Option<String>,
    pub max_matches: Option<u32>,
    pub case_insensitive: Option<bool>,
}

fn err_json(err: PolicyError) -> Value {
    json!({
        "ok": false,
        "error": err.message(),
        "code": err.code(),
    })
}

fn ok_redacted(value: Value) -> Value {
    let mut v = redact_json(value);
    if let Some(obj) = v.as_object_mut() {
        obj.insert("ok".into(), json!(true));
    }
    v
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8_192).any(|&b| b == 0)
}

pub fn execute_workspace_read(
    config: &WorkspaceToolConfig,
    input: ReadInput,
) -> Result<Value, Value> {
    let root = config.open().map_err(err_json)?;
    let path = resolve_existing(&root, &input.path).map_err(err_json)?;
    if !path.is_file() {
        return Err(err_json(PolicyError::NotAFile));
    }
    let meta = fs::metadata(&path).map_err(|e| err_json(PolicyError::Io(e.to_string())))?;
    let max = input
        .limit
        .unwrap_or(DEFAULT_READ_MAX_BYTES)
        .min(DEFAULT_READ_MAX_BYTES);
    if meta.len() > DEFAULT_READ_MAX_BYTES
        && input.offset.unwrap_or(0) == 0
        && input.limit.is_none()
    {
        return Err(err_json(PolicyError::TooLarge));
    }
    let bytes = fs::read(&path).map_err(|e| err_json(PolicyError::Io(e.to_string())))?;
    if looks_binary(&bytes) {
        return Err(err_json(PolicyError::Binary));
    }
    let offset = input.offset.unwrap_or(0) as usize;
    let end = if let Some(limit) = input.limit {
        offset.saturating_add(limit as usize).min(bytes.len())
    } else {
        (offset.saturating_add(max as usize)).min(bytes.len())
    };
    let slice = if offset >= bytes.len() {
        &[][..]
    } else {
        &bytes[offset..end]
    };
    let content = String::from_utf8_lossy(slice).into_owned();
    let truncated = end < bytes.len();
    Ok(ok_redacted(json!({
        "path": rel_display(root.path(), &path),
        "content": content,
        "bytes": slice.len(),
        "truncated": truncated,
        "total_bytes": bytes.len(),
    })))
}

pub fn execute_workspace_write(
    config: &WorkspaceToolConfig,
    input: WriteInput,
) -> Result<Value, Value> {
    let root = config.open().map_err(err_json)?;
    let path = resolve_for_write(&root, &input.path).map_err(err_json)?;
    if let Some(parent) = path.parent() {
        if input.create_dirs.unwrap_or(false) {
            fs::create_dir_all(parent).map_err(|e| err_json(PolicyError::Io(e.to_string())))?;
            let canonical_parent =
                fs::canonicalize(parent).map_err(|e| err_json(PolicyError::Io(e.to_string())))?;
            if !super::path_policy::is_within(root.path(), &canonical_parent) {
                return Err(err_json(PolicyError::OutsideWorkspace));
            }
        } else if !parent.exists() {
            return Err(err_json(PolicyError::Io(
                "parent directory does not exist (set create_dirs=true to create it)".into(),
            )));
        }
    }
    assert_allowed(&path).map_err(err_json)?;
    fs::write(&path, input.content.as_bytes())
        .map_err(|e| err_json(PolicyError::Io(e.to_string())))?;
    Ok(ok_redacted(json!({
        "path": rel_display(root.path(), &path),
        "bytes_written": input.content.len(),
    })))
}

pub fn execute_workspace_edit(
    config: &WorkspaceToolConfig,
    input: EditInput,
) -> Result<Value, Value> {
    let root = config.open().map_err(err_json)?;
    let path = resolve_existing(&root, &input.path).map_err(err_json)?;
    if !path.is_file() {
        return Err(err_json(PolicyError::NotAFile));
    }
    fs::write(&path, input.content.as_bytes())
        .map_err(|e| err_json(PolicyError::Io(e.to_string())))?;
    Ok(ok_redacted(json!({
        "path": rel_display(root.path(), &path),
        "bytes_written": input.content.len(),
    })))
}

pub fn execute_workspace_glob(
    config: &WorkspaceToolConfig,
    input: GlobInput,
) -> Result<Value, Value> {
    let root = config.open().map_err(err_json)?;
    let pattern = input.pattern.trim();
    if pattern.is_empty() {
        return Err(err_json(PolicyError::EmptyPath));
    }
    if Path::new(pattern).is_absolute() {
        return Err(err_json(PolicyError::AbsolutePath));
    }
    let max = input
        .max_results
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_GLOB_MAX)
        .min(DEFAULT_GLOB_MAX);

    let full_pattern = root.path().join(pattern);
    let walker = glob::glob(full_pattern.to_string_lossy().as_ref())
        .map_err(|e| err_json(PolicyError::Io(format!("invalid glob pattern: {e}"))))?;

    let mut matches = Vec::new();
    let mut truncated = false;
    for entry in walker {
        let path = match entry {
            Ok(p) => p,
            Err(_) => continue,
        };
        if let Ok(canonical) = fs::canonicalize(&path) {
            if !path_under_root(root.path(), &canonical) {
                continue;
            }
            if is_denied(&canonical) {
                continue;
            }
            if skipped_ancestor(&canonical) {
                continue;
            }
            if matches.len() >= max {
                truncated = true;
                break;
            }
            matches.push(rel_display(root.path(), &canonical));
        }
    }
    matches.sort();
    Ok(ok_redacted(json!({
        "pattern": pattern,
        "matches": matches,
        "truncated": truncated,
    })))
}

pub fn execute_workspace_grep(
    config: &WorkspaceToolConfig,
    input: GrepInput,
) -> Result<Value, Value> {
    let root = config.open().map_err(err_json)?;
    let pattern = input.pattern;
    if pattern.is_empty() {
        return Err(err_json(PolicyError::Io(
            "grep pattern must not be empty".into(),
        )));
    }
    let max = input
        .max_matches
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_GREP_MAX)
        .min(DEFAULT_GREP_MAX);

    let regex = if input.case_insensitive.unwrap_or(false) {
        regex::RegexBuilder::new(&pattern)
            .case_insensitive(true)
            .build()
    } else {
        regex::Regex::new(&pattern)
    }
    .map_err(|e| err_json(PolicyError::Io(format!("invalid regex: {e}"))))?;

    let search_root = if let Some(sub) = input.path.as_deref() {
        resolve_existing(&root, sub).map_err(err_json)?
    } else {
        root.path().to_path_buf()
    };

    let file_glob = input.glob.as_deref();
    let mut hits = Vec::new();
    let mut truncated = false;

    let mut stack = vec![search_root];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if ft.is_dir() {
                if should_skip_dir(&name) || is_denied(&path) {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            if is_denied(&path) {
                continue;
            }
            if let Some(g) = file_glob {
                let name_path = Path::new(&name);
                if !glob_match(g, name_path) {
                    continue;
                }
            }
            if let Ok(canonical) = fs::canonicalize(&path) {
                if !path_under_root(root.path(), &canonical) {
                    continue;
                }
                match grep_file(
                    &regex,
                    &canonical,
                    root.path(),
                    max.saturating_sub(hits.len()),
                ) {
                    Ok((file_hits, hit_truncated)) => {
                        hits.extend(file_hits);
                        if hit_truncated || hits.len() >= max {
                            truncated = true;
                            hits.truncate(max);
                            break;
                        }
                    }
                    Err(_) => continue,
                }
            }
        }
        if truncated {
            break;
        }
    }

    Ok(ok_redacted(json!({
        "pattern": pattern,
        "matches": hits,
        "truncated": truncated,
    })))
}

fn grep_file(
    regex: &regex::Regex,
    path: &Path,
    root: &Path,
    remaining: usize,
) -> Result<(Vec<Value>, bool), PolicyError> {
    if remaining == 0 {
        return Ok((Vec::new(), true));
    }
    // Binary sniff
    {
        let mut file = fs::File::open(path).map_err(|e| PolicyError::Io(e.to_string()))?;
        let mut buf = vec![0u8; 8_192];
        let n = file
            .read(&mut buf)
            .map_err(|e| PolicyError::Io(e.to_string()))?;
        if looks_binary(&buf[..n]) {
            return Err(PolicyError::Binary);
        }
    }
    let file = fs::File::open(path).map_err(|e| PolicyError::Io(e.to_string()))?;
    let reader = BufReader::new(file);
    let mut hits = Vec::new();
    let mut truncated = false;
    for (idx, line) in reader.lines().enumerate() {
        let Ok(line) = line else { continue };
        if regex.is_match(&line) {
            let mut display = line;
            if display.len() > DEFAULT_GREP_LINE_MAX {
                display.truncate(DEFAULT_GREP_LINE_MAX);
                display.push('…');
            }
            hits.push(json!({
                "path": rel_display(root, path),
                "line": idx + 1,
                "text": display,
            }));
            if hits.len() >= remaining {
                truncated = true;
                break;
            }
        }
    }
    Ok((hits, truncated))
}

fn glob_match(pattern: &str, name: &Path) -> bool {
    glob::Pattern::new(pattern)
        .map(|p| p.matches_path(name))
        .unwrap_or(false)
}

fn path_under_root(root: &Path, candidate: &Path) -> bool {
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

fn skipped_ancestor(path: &Path) -> bool {
    path.components().any(|c| match c {
        std::path::Component::Normal(name) => should_skip_dir(&name.to_string_lossy()),
        _ => false,
    })
}

fn rel_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn cfg(dir: &Path) -> WorkspaceToolConfig {
        WorkspaceToolConfig {
            root: dir.to_path_buf(),
        }
    }

    #[test]
    fn read_write_round_trip() {
        let dir = tempdir().unwrap();
        let c = cfg(dir.path());
        let w = execute_workspace_write(
            &c,
            WriteInput {
                path: "hello.txt".into(),
                content: "hello world".into(),
                create_dirs: Some(false),
            },
        )
        .unwrap();
        assert_eq!(w["ok"], true);
        let r = execute_workspace_read(
            &c,
            ReadInput {
                path: "hello.txt".into(),
                offset: None,
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(r["content"], "hello world");
    }

    #[test]
    fn edit_requires_existing() {
        let dir = tempdir().unwrap();
        let c = cfg(dir.path());
        let err = execute_workspace_edit(
            &c,
            EditInput {
                path: "missing.txt".into(),
                content: "x".into(),
            },
        )
        .unwrap_err();
        assert_eq!(err["code"], "not_found");
    }

    #[test]
    fn glob_finds_file() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.rs"), "fn main() {}").unwrap();
        fs::write(dir.path().join("b.txt"), "x").unwrap();
        let c = cfg(dir.path());
        let out = execute_workspace_glob(
            &c,
            GlobInput {
                pattern: "*.rs".into(),
                max_results: None,
            },
        )
        .unwrap();
        let matches = out["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0], "a.rs");
    }

    #[test]
    fn grep_finds_line() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "alpha\nsecret token here\nbeta\n").unwrap();
        let c = cfg(dir.path());
        let out = execute_workspace_grep(
            &c,
            GrepInput {
                pattern: "token".into(),
                path: None,
                glob: Some("*.txt".into()),
                max_matches: None,
                case_insensitive: None,
            },
        )
        .unwrap();
        let matches = out["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["line"], 2);
        // secret-ish line may be redacted
        assert!(
            matches[0]["text"].as_str().unwrap().contains("[REDACTED]")
                || matches[0]["text"].as_str().unwrap().contains("token")
        );
    }

    #[test]
    fn blocks_env_read() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(".env"), "API_KEY=abc").unwrap();
        let c = cfg(dir.path());
        let err = execute_workspace_read(
            &c,
            ReadInput {
                path: ".env".into(),
                offset: None,
                limit: None,
            },
        )
        .unwrap_err();
        assert_eq!(err["code"], "denied_path");
    }
}
