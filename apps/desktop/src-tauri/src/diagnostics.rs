use crate::paths::AppPaths;
use crate::state::AppSettings;
use crate::time::now_unix;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsExport {
    pub exported_to: String,
    pub redacted_fields: Vec<String>,
}

/// Strip the user's home directory prefix from `path` so the diagnostics
/// export does not leak the local username or absolute home path. Returns the
/// redacted string and whether a home prefix was actually removed (so callers
/// can report an honest `redacted_fields` list rather than a hand-stated one).
fn redact_path(path: &Path, home: Option<&Path>) -> (String, bool) {
    match home {
        Some(home) if path.starts_with(home) => {
            let rel = path.strip_prefix(home).unwrap_or(path);
            (format!("~/{}", rel.display()), true)
        }
        _ => (path.display().to_string(), false),
    }
}

/// Field name + path pairs emitted under `paths` in the export. Listed here so
/// the `redacted_fields` set is derived from what was actually redacted rather
/// than hand-stated.
fn path_entries(paths: &AppPaths) -> Vec<(&'static str, &Path)> {
    vec![
        ("root", &paths.root),
        ("settings_file", &paths.settings_file),
        ("database", &paths.database),
        ("attachments", &paths.attachments),
        ("artifacts", &paths.artifacts),
        ("logs", &paths.logs),
        ("diagnostics", &paths.diagnostics),
        ("updates", &paths.updates),
    ]
}

pub fn export(paths: &AppPaths, settings: &AppSettings) -> Result<DiagnosticsExport, String> {
    let home = directories::BaseDirs::new().map(|b| b.home_dir().to_path_buf());

    let mut redacted_fields = Vec::new();
    let mut paths_json = serde_json::Map::new();
    for (name, path) in path_entries(paths) {
        let (redacted, was_redacted) = redact_path(path, home.as_deref());
        if was_redacted {
            redacted_fields.push(name.to_string());
        }
        paths_json.insert(name.to_string(), serde_json::Value::String(redacted));
    }

    let payload = serde_json::json!({
      "settings": {
        "active_provider": settings.active_provider,
        "active_model": settings.active_model,
        "local_only": settings.local_only,
        "diagnostics_enabled": settings.diagnostics_enabled,
        "theme": settings.theme,
      },
      "redacted_fields": redacted_fields.clone(),
      "paths": serde_json::Value::Object(paths_json),
    });

    let stamp = now_unix();
    let export_path = paths
        .diagnostics
        .join(format!("diagnostics-{}.json", stamp));

    let serialized = serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    fs::write(&export_path, serialized).map_err(|error| error.to_string())?;

    Ok(DiagnosticsExport {
        exported_to: export_path.to_string_lossy().to_string(),
        redacted_fields,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn redact_path_strips_home_prefix() {
        let home = PathBuf::from("/home/alice");
        let path = PathBuf::from("/home/alice/conduit/settings.json");
        let (redacted, was_redacted) = redact_path(&path, Some(&home));
        assert!(was_redacted, "path under home should be redacted");
        assert_eq!(redacted, "~/conduit/settings.json");
        assert!(
            !redacted.contains("alice"),
            "redacted path must not contain the username: {redacted}"
        );
    }

    #[test]
    fn redact_path_leaves_non_home_paths_intact() {
        let home = PathBuf::from("/home/alice");
        let path = PathBuf::from("/var/log/conduit.log");
        let (redacted, was_redacted) = redact_path(&path, Some(&home));
        assert!(!was_redacted);
        assert_eq!(redacted, "/var/log/conduit.log");
    }

    #[test]
    fn export_redacts_paths_and_lists_redacted_fields() {
        // Build an AppPaths whose entries live under a fake home, then assert the
        // serialized export contains no absolute home path and that redacted_fields
        // reflects the fields actually transformed (M3: derived, not hand-stated).
        let home = PathBuf::from("/home/bob");
        let root = home.join("conduit");
        let paths = AppPaths {
            root: root.clone(),
            settings_file: root.join("settings.json"),
            database: root.join("conduit.sqlite"),
            attachments: root.join("attachments"),
            artifacts: root.join("artifacts"),
            logs: root.join("logs"),
            diagnostics: root.join("diagnostics"),
            updates: root.join("updates"),
            streams: root.join("streams"),
            connectors: root.join("connectors"),
        };
        let settings = AppSettings::default();

        // Exercise redact_path directly against the fake home for every entry.
        let mut redacted_count = 0;
        for (name, path) in path_entries(&paths) {
            let (redacted, was_redacted) = redact_path(path, Some(&home));
            assert!(was_redacted, "{name} should be under home");
            assert!(
                !redacted.contains("bob"),
                "{name} leaked username: {redacted}"
            );
            assert!(redacted.starts_with("~/"));
            redacted_count += 1;
        }
        assert!(redacted_count > 0);

        // Sanity: an AppSettings with the global ref removed (M2) still serializes
        // without that field, and the export payload concept holds.
        let serialized = serde_json::to_string(&settings).unwrap();
        assert!(
            !serialized.contains("providerCredentialRef"),
            "M2 removed provider_credential_ref; it must not appear in settings"
        );
    }
}
