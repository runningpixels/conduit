//! Stored values for an app's declared launch inputs (ADR-013): `app_inputs`,
//! one row per app, `values_json` encrypted like other content columns.
//! Declaration shape and value validation live in
//! `provider_core::app_inputs`; this module is the DB-backed "effective
//! values" resolution and the replace-all write.
//!
//! There is no principal split here (unlike `page_storage`): inputs are an
//! app-only feature (ADR-013 §6 — a page in a chat gets its declared defaults
//! and no form), so every row is keyed directly by `app_id`.

use serde_json::{Map, Value};
use sqlx::SqlitePool;

use provider_core::app_inputs::{effective_value, validate_value};
use provider_core::schema::AppInput;

use crate::{db::DbError, encryption::Encryption, time::now_iso8601};

/// Why a launch-input operation was refused. `Display` renders the bridge
/// error code and a colon, matching `PageStorageError`.
#[derive(Debug)]
pub enum AppInputsError {
    Invalid(String),
    /// Something below the contract itself failed (the database, or
    /// decrypting/decoding a row already known to exist).
    Unavailable(DbError),
}

impl std::fmt::Display for AppInputsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(msg) => write!(f, "invalid: {msg}"),
            Self::Unavailable(_) => {
                write!(
                    f,
                    "unavailable: This app's inputs aren't available right now."
                )
            }
        }
    }
}

impl std::error::Error for AppInputsError {}

impl From<DbError> for AppInputsError {
    fn from(err: DbError) -> Self {
        Self::Unavailable(err)
    }
}

impl From<sqlx::Error> for AppInputsError {
    fn from(err: sqlx::Error) -> Self {
        Self::Unavailable(DbError::from(err))
    }
}

/// Fold into `DbError` for callers (`apps.rs`) that only need "did this
/// work", not the bridge error code.
impl From<AppInputsError> for DbError {
    fn from(err: AppInputsError) -> Self {
        match err {
            AppInputsError::Unavailable(inner) => inner,
            other => DbError::Query(other.to_string()),
        }
    }
}

/// The raw stored values for `app_id`, or an empty map when there's no row
/// (never saved, or already cleared back to empty).
async fn stored_values(
    pool: &SqlitePool,
    enc: &Encryption,
    app_id: &str,
) -> Result<Map<String, Value>, AppInputsError> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT values_json FROM app_inputs WHERE app_id = ?")
            .bind(app_id)
            .fetch_optional(pool)
            .await
            .map_err(DbError::from)?;
    let Some((stored,)) = row else {
        return Ok(Map::new());
    };
    let json = enc.decrypt(&stored).map_err(AppInputsError::Unavailable)?;
    match serde_json::from_str::<Value>(&json) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Ok(Map::new()),
    }
}

async fn write_values(
    pool: &SqlitePool,
    enc: &Encryption,
    app_id: &str,
    values: &Map<String, Value>,
) -> Result<(), AppInputsError> {
    let json = serde_json::to_string(values).map_err(|e| {
        AppInputsError::Unavailable(DbError::Query(format!("encode app inputs: {e}")))
    })?;
    let encrypted = enc.encrypt(&json).map_err(AppInputsError::Unavailable)?;
    sqlx::query(
        "INSERT INTO app_inputs (app_id, values_json, updated_at) VALUES (?, ?, ?) \
         ON CONFLICT(app_id) DO UPDATE SET \
           values_json = excluded.values_json, \
           updated_at = excluded.updated_at",
    )
    .bind(app_id)
    .bind(&encrypted)
    .bind(now_iso8601())
    .execute(pool)
    .await
    .map_err(DbError::from)?;
    Ok(())
}

/// Effective values for every input in `inputs`: a stored-and-valid value,
/// else the input's default, else omitted from the returned map entirely.
pub async fn get_values(
    pool: &SqlitePool,
    enc: &Encryption,
    app_id: &str,
    inputs: &[AppInput],
) -> Result<Map<String, Value>, AppInputsError> {
    let stored = stored_values(pool, enc, app_id).await?;
    let mut out = Map::new();
    for input in inputs {
        if let Some(value) = effective_value(input, stored.get(&input.id)) {
            out.insert(input.id.clone(), value);
        }
    }
    Ok(out)
}

/// Replace every stored value for `app_id` with `values`. Every key must name
/// a declared input (else refused whole, nothing written); a `null` value
/// clears that input (the default applies from then on); every other value
/// must fit its input's declared kind. Returns the effective values after the
/// write, same shape as [`get_values`].
pub async fn set_values(
    pool: &SqlitePool,
    enc: &Encryption,
    app_id: &str,
    inputs: &[AppInput],
    values: Map<String, Value>,
) -> Result<Map<String, Value>, AppInputsError> {
    let mut to_store = Map::new();
    for (id, value) in &values {
        let Some(input) = inputs.iter().find(|i| &i.id == id) else {
            return Err(AppInputsError::Invalid(format!(
                "{id:?} isn't a declared input on this app."
            )));
        };
        if value.is_null() {
            continue;
        }
        validate_value(input, value).map_err(AppInputsError::Invalid)?;
        to_store.insert(id.clone(), value.clone());
    }
    write_values(pool, enc, app_id, &to_store).await?;
    get_values(pool, enc, app_id, inputs).await
}

/// Delete the stored values for `app_id`, if any. Called from `apps::delete`.
pub async fn delete(pool: &SqlitePool, app_id: &str) -> Result<(), DbError> {
    sqlx::query("DELETE FROM app_inputs WHERE app_id = ?")
        .bind(app_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Drop stored values whose input is no longer declared or no longer fits,
/// keeping the rest (ADR-013: "updating an app from its source keeps stored
/// values for inputs that are still declared; values for removed inputs are
/// dropped"). A no-op — no read, no write — when nothing is stored.
pub async fn prune_to_declaration(
    pool: &SqlitePool,
    enc: &Encryption,
    app_id: &str,
    inputs: &[AppInput],
) -> Result<(), AppInputsError> {
    let stored = stored_values(pool, enc, app_id).await?;
    if stored.is_empty() {
        return Ok(());
    }
    let mut kept = Map::new();
    for input in inputs {
        if let Some(value) = stored.get(&input.id) {
            if validate_value(input, value).is_ok() {
                kept.insert(input.id.clone(), value.clone());
            }
        }
    }
    write_values(pool, enc, app_id, &kept).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use provider_core::schema::AppInputKind;
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::MIGRATOR.run(&pool).await.unwrap();
        pool
    }

    fn city_input() -> AppInput {
        AppInput {
            id: "city".to_string(),
            label: "City".to_string(),
            kind: AppInputKind::String,
            required: true,
            default: Some(json!("Paris")),
            options: None,
        }
    }

    fn units_input() -> AppInput {
        AppInput {
            id: "units".to_string(),
            label: "Units".to_string(),
            kind: AppInputKind::Enum,
            required: false,
            default: Some(json!("metric")),
            options: Some(vec!["metric".to_string(), "imperial".to_string()]),
        }
    }

    #[tokio::test]
    async fn get_values_starts_as_the_defaults() {
        let pool = pool().await;
        let enc = Encryption::off();
        let inputs = vec![city_input(), units_input()];
        let values = get_values(&pool, &enc, "app-1", &inputs).await.unwrap();
        assert_eq!(values.get("city"), Some(&json!("Paris")));
        assert_eq!(values.get("units"), Some(&json!("metric")));
    }

    #[tokio::test]
    async fn set_values_validates_and_replaces() {
        let pool = pool().await;
        let enc = Encryption::off();
        let inputs = vec![city_input(), units_input()];

        let mut edits = Map::new();
        edits.insert("city".to_string(), json!("Lisbon"));
        edits.insert("units".to_string(), json!("imperial"));
        let values = set_values(&pool, &enc, "app-1", &inputs, edits)
            .await
            .unwrap();
        assert_eq!(values.get("city"), Some(&json!("Lisbon")));
        assert_eq!(values.get("units"), Some(&json!("imperial")));

        let refetched = get_values(&pool, &enc, "app-1", &inputs).await.unwrap();
        assert_eq!(refetched, values);
    }

    #[tokio::test]
    async fn set_values_refuses_an_undeclared_id() {
        let pool = pool().await;
        let enc = Encryption::off();
        let inputs = vec![city_input()];
        let mut edits = Map::new();
        edits.insert("bogus".to_string(), json!("x"));
        let err = set_values(&pool, &enc, "app-1", &inputs, edits)
            .await
            .unwrap_err();
        assert!(matches!(err, AppInputsError::Invalid(_)));
        assert!(err.to_string().starts_with("invalid:"));
    }

    #[tokio::test]
    async fn set_values_refuses_a_value_that_does_not_fit() {
        let pool = pool().await;
        let enc = Encryption::off();
        let inputs = vec![units_input()];
        let mut edits = Map::new();
        edits.insert("units".to_string(), json!("kelvin"));
        let err = set_values(&pool, &enc, "app-1", &inputs, edits)
            .await
            .unwrap_err();
        assert!(matches!(err, AppInputsError::Invalid(_)));
    }

    #[tokio::test]
    async fn a_null_value_clears_back_to_the_default() {
        let pool = pool().await;
        let enc = Encryption::off();
        let inputs = vec![city_input()];

        let mut edits = Map::new();
        edits.insert("city".to_string(), json!("Lisbon"));
        set_values(&pool, &enc, "app-1", &inputs, edits)
            .await
            .unwrap();

        let mut clear = Map::new();
        clear.insert("city".to_string(), Value::Null);
        let values = set_values(&pool, &enc, "app-1", &inputs, clear)
            .await
            .unwrap();
        assert_eq!(
            values.get("city"),
            Some(&json!("Paris")),
            "back to the default"
        );
    }

    #[tokio::test]
    async fn delete_removes_the_row() {
        let pool = pool().await;
        let enc = Encryption::off();
        let inputs = vec![city_input()];
        let mut edits = Map::new();
        edits.insert("city".to_string(), json!("Lisbon"));
        set_values(&pool, &enc, "app-1", &inputs, edits)
            .await
            .unwrap();

        delete(&pool, "app-1").await.unwrap();
        let values = get_values(&pool, &enc, "app-1", &inputs).await.unwrap();
        assert_eq!(
            values.get("city"),
            Some(&json!("Paris")),
            "back to defaults"
        );
    }

    #[tokio::test]
    async fn prune_drops_removed_inputs_and_keeps_the_rest() {
        let pool = pool().await;
        let enc = Encryption::off();
        let both = vec![city_input(), units_input()];
        let mut edits = Map::new();
        edits.insert("city".to_string(), json!("Lisbon"));
        edits.insert("units".to_string(), json!("imperial"));
        set_values(&pool, &enc, "app-1", &both, edits)
            .await
            .unwrap();

        // `units` is dropped from the new declaration.
        let city_only = vec![city_input()];
        prune_to_declaration(&pool, &enc, "app-1", &city_only)
            .await
            .unwrap();

        let values = get_values(&pool, &enc, "app-1", &city_only).await.unwrap();
        assert_eq!(values.get("city"), Some(&json!("Lisbon")), "kept");
        assert_eq!(values.get("units"), None, "no longer declared");
    }

    #[tokio::test]
    async fn prune_is_a_no_op_when_nothing_is_stored() {
        let pool = pool().await;
        let enc = Encryption::off();
        // No panics, no row created.
        prune_to_declaration(&pool, &enc, "app-1", &[city_input()])
            .await
            .unwrap();
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM app_inputs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn round_trip_with_encryption_on() {
        let pool = pool().await;
        let enc = Encryption::on_with_key(crate::encryption::generate_key(), 1);
        let inputs = vec![city_input()];
        let mut edits = Map::new();
        edits.insert("city".to_string(), json!("Lisbon"));
        set_values(&pool, &enc, "app-1", &inputs, edits)
            .await
            .unwrap();
        let (raw,): (String,) =
            sqlx::query_as("SELECT values_json FROM app_inputs WHERE app_id = ?")
                .bind("app-1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(raw.starts_with("enc:v1:"), "on tier encrypts the value");
        let values = get_values(&pool, &enc, "app-1", &inputs).await.unwrap();
        assert_eq!(values.get("city"), Some(&json!("Lisbon")));
    }
}
