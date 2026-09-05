//! Connector runtime commands: lifecycle, tool invocation, consent, grants,
//! and the local-connector registration flow.

use crate::{
    connector_runtime::{execution, ConnectorRuntimeManager},
    db::repository::connectors::{
        self, ConnectorCapability, ConnectorDefinition, ConnectorGrant, ConnectorRuntimeState,
        ConnectorVersion,
    },
    mcp_registry::RegistryServer,
    state::AppState,
    stream_manager::StreamHandle,
};
use mcp_runtime::{HttpSseConfig, McpTransport, StdioConfig};
use provider_core::schema::{ConnectorRuntimeEvent, ConsentDecision};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, State};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/// A request to invoke a connector tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvokeConnectorToolRequest {
    pub connector_version_id: String,
    pub tool_call_id: String,
    pub request_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
}

/// A request to register a local stdio connector.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddLocalConnectorRequest {
    pub name: String,
    pub description: Option<String>,
    pub command: String,
    pub args: Vec<String>,
    pub env: std::collections::HashMap<String, String>,
    pub consent_copy: Option<String>,
    pub capability_allowlist: Option<Vec<String>>,
}

/// The result of registering a local connector.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddLocalConnectorResult {
    pub connector_id: String,
    pub connector_version_id: String,
}

/// One row of the connectors rail snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorRuntimeSnapshot {
    pub connector_version_id: String,
    pub connector_id: String,
    pub connector_name: String,
    pub version: String,
    pub transport: String,
    pub health: Option<String>,
    pub last_error: Option<String>,
    pub last_started_at: Option<String>,
    pub restart_count: i64,
    pub support_state: Option<String>,
    pub grant_status: Option<String>,
    pub running: bool,
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_connector(
    state: State<'_, AppState>,
    runtime: State<'_, ConnectorRuntimeManager>,
    connector_version_id: String,
) -> Result<serde_json::Value, String> {
    let server = runtime
        .start_connector(state.inner(), &connector_version_id)
        .await?;
    Ok(serde_json::json!({ "name": server.name, "version": server.version }))
}

#[tauri::command]
pub async fn stop_connector(
    state: State<'_, AppState>,
    runtime: State<'_, ConnectorRuntimeManager>,
    connector_version_id: String,
) -> Result<(), String> {
    runtime
        .stop_connector(state.inner(), &connector_version_id)
        .await
}

#[tauri::command]
pub async fn discover_connector(
    state: State<'_, AppState>,
    runtime: State<'_, ConnectorRuntimeManager>,
    connector_version_id: String,
) -> Result<Vec<ConnectorCapability>, String> {
    runtime
        .discover_capabilities(state.inner(), &connector_version_id)
        .await
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_connector_capabilities(
    state: State<'_, AppState>,
    connector_version_id: String,
) -> Result<Vec<ConnectorCapability>, String> {
    connectors::list_capabilities(&state.db, &connector_version_id)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_connector_runtime_states(
    state: State<'_, AppState>,
    runtime: State<'_, ConnectorRuntimeManager>,
) -> Result<Vec<ConnectorRuntimeSnapshot>, String> {
    let pool = &state.db;
    let defs = connectors::list_definitions(pool)
        .await
        .map_err(|e| e.to_string())?;
    let states = connectors::list_runtime_states(pool)
        .await
        .map_err(|e| e.to_string())?;
    let grants = connectors::list_grants(pool, None)
        .await
        .map_err(|e| e.to_string())?;

    // Index runtime states + grants by version id for O(1) join.
    use std::collections::HashMap;
    let state_by_ver: HashMap<String, ConnectorRuntimeState> = states
        .into_iter()
        .map(|s| (s.connector_version_id.clone(), s))
        .collect();
    // First grant per version (an active grant wins over revoked/pending).
    let mut grant_by_ver: HashMap<String, ConnectorGrant> = HashMap::new();
    for g in grants {
        match grant_by_ver.get(&g.connector_version_id) {
            Some(existing) if existing.status == "active" => {}
            _ => {
                grant_by_ver.insert(g.connector_version_id.clone(), g);
            }
        }
    }
    let running = runtime.active_version_ids();

    let mut rows = Vec::new();
    for def in &defs {
        let versions = connectors::list_versions(pool, &def.id)
            .await
            .map_err(|e| e.to_string())?;
        for v in versions {
            let st = state_by_ver.get(&v.id);
            let g = grant_by_ver.get(&v.id);
            rows.push(ConnectorRuntimeSnapshot {
                connector_version_id: v.id.clone(),
                connector_id: def.id.clone(),
                connector_name: def.name.clone(),
                version: v.version.clone(),
                transport: def.transport.clone(),
                health: st.map(|s| s.health.clone()),
                last_error: st.and_then(|s| s.last_error.clone()),
                last_started_at: st.and_then(|s| s.last_started_at.clone()),
                restart_count: st.map(|s| s.restart_count).unwrap_or(0),
                support_state: v.support_state.clone(),
                grant_status: g.map(|g| g.status.clone()),
                running: running.contains(&v.id) && st.is_none_or(|s| s.health != "down"),
            });
        }
    }
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Tool invocation
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn invoke_connector_tool(
    state: State<'_, AppState>,
    runtime: State<'_, ConnectorRuntimeManager>,
    request: InvokeConnectorToolRequest,
    channel: Channel<ConnectorRuntimeEvent>,
) -> Result<StreamHandle, String> {
    // Validate the connector is running before we accept the call.
    if runtime
        .active_connector(&request.connector_version_id)
        .is_none()
    {
        return Err("connector is not running; start it first".to_string());
    }

    let tool_call_id = if request.tool_call_id.trim().is_empty() {
        Uuid::new_v4().to_string()
    } else {
        request.tool_call_id.trim().to_string()
    };
    let state = state.inner().clone();
    let mgr = runtime.inner().clone();
    let connector_version_id = request.connector_version_id.clone();
    let request_id = request.request_id.clone();
    let tool_name = request.tool_name.clone();
    let arguments = request.arguments.clone();
    let tcid = tool_call_id.clone();

    let sink: execution::EventSink = std::sync::Arc::new(move |ev| {
        let _ = channel.send(ev);
    });

    tauri::async_runtime::spawn(async move {
        let req = execution::ToolCallRequest {
            connector_version_id: &connector_version_id,
            tool_call_id: &tcid,
            request_id: &request_id,
            tool_name: &tool_name,
            arguments: &arguments,
            conversation_id: None,
        };
        let _ = execution::execute_tool_call(&state, &mgr, &req, &sink).await;
    });

    Ok(StreamHandle {
        request_id: tool_call_id,
    })
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn approve_connector_tool_call(
    state: State<'_, AppState>,
    runtime: State<'_, ConnectorRuntimeManager>,
    tool_call_id: String,
    remember: Option<String>,
    conversation_id: Option<String>,
) -> Result<(), String> {
    let meta = runtime.resolve_consent(&tool_call_id, ConsentDecision::Approved)?;
    if let (Some(scope_str), Some(meta)) = (remember.as_deref(), meta) {
        use crate::db::repository::tool_approval_memory::{self, ApprovalScope};
        use mcp_runtime::protocol::PermissionLevel;
        // Sensitive tools are never rememberable.
        if matches!(meta.permission_level, PermissionLevel::Sensitive) {
            return Ok(());
        }
        let scope = ApprovalScope::parse(scope_str).map_err(|e| e.to_string())?;
        let cid = conversation_id
            .or(meta.conversation_id.clone())
            .filter(|s| !s.trim().is_empty());
        let _ = tool_approval_memory::remember(
            &state.db,
            &meta.connector_version_id,
            &meta.tool_name,
            scope,
            cid.as_deref(),
        )
        .await;
    }
    Ok(())
}

#[tauri::command]
pub async fn deny_connector_tool_call(
    runtime: State<'_, ConnectorRuntimeManager>,
    tool_call_id: String,
) -> Result<(), String> {
    let _ = runtime.resolve_consent(&tool_call_id, ConsentDecision::Denied)?;
    Ok(())
}

#[tauri::command]
pub async fn list_tool_approval_memory(
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::repository::tool_approval_memory::ApprovalMemoryRow>, String> {
    crate::db::repository::tool_approval_memory::list_all(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn revoke_tool_approval_memory(
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    crate::db::repository::tool_approval_memory::revoke(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_connector_definitions(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectorDefinition>, String> {
    connectors::list_definitions(&state.db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_connector_versions(
    state: State<'_, AppState>,
    connector_id: String,
) -> Result<Vec<ConnectorVersion>, String> {
    connectors::list_versions(&state.db, &connector_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_connector_grants(
    state: State<'_, AppState>,
    status: Option<String>,
) -> Result<Vec<ConnectorGrant>, String> {
    connectors::list_grants(&state.db, status.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn revoke_connector_grant(
    state: State<'_, AppState>,
    runtime: State<'_, ConnectorRuntimeManager>,
    grant_id: String,
    _connector_version_id: Option<String>,
) -> Result<(), String> {
    revoke_connector_grant_inner(state.inner(), runtime.inner(), &grant_id).await
}

pub async fn revoke_connector_grant_inner(
    state: &AppState,
    runtime: &ConnectorRuntimeManager,
    grant_id: &str,
) -> Result<(), String> {
    // Always resolve the version from the grant so revocation guarantees stop
    // even if the renderer omits connector_version_id.
    let grants = connectors::list_grants(&state.db, None)
        .await
        .map_err(|e| e.to_string())?;
    let vid = grants
        .iter()
        .find(|g| g.id == grant_id)
        .map(|g| g.connector_version_id.clone());
    if let Some(vid) = vid.as_deref() {
        let _ = runtime.stop_connector(state, vid).await;
    }
    connectors::revoke_grant(&state.db, grant_id, None)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Local connector registration
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn add_local_connector(
    state: State<'_, AppState>,
    request: AddLocalConnectorRequest,
) -> Result<AddLocalConnectorResult, String> {
    // Validate the untrusted transport config server-side before persisting.
    let transport_config = serde_json::json!({
        "command": request.command,
        "args": request.args,
        "env": request.env,
    });
    StdioConfig::from_value(&transport_config).map_err(|e| e.message)?;

    let now = crate::time::now_iso8601();
    let connector_id = format!("local:{}", slugify(&request.name));
    let version_id = format!("{connector_id}:1.0.0");

    let def = ConnectorDefinition {
        id: connector_id.clone(),
        name: request.name.clone(),
        description: request.description.unwrap_or_default(),
        transport: "stdio".to_string(),
        owner: "local".to_string(),
        icon: None,
        support_url: None,
        consent_copy: request.consent_copy.clone(),
        policy_metadata: None,
        cloud_id: None,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    connectors::upsert_definition(&state.db, &def)
        .await
        .map_err(|e| e.to_string())?;

    let capability_allowlist = request.capability_allowlist.map(|names| {
        serde_json::Value::Array(names.into_iter().map(serde_json::Value::String).collect())
    });
    let version = ConnectorVersion {
        id: version_id.clone(),
        connector_id: connector_id.clone(),
        version: "1.0.0".to_string(),
        transport_config,
        scope_grants: None,
        capability_allowlist,
        rollout_channel: None,
        support_state: Some("available".to_string()),
        created_at: now.clone(),
    };
    connectors::insert_version(&state.db, &version)
        .await
        .map_err(|e| e.to_string())?;

    let grant = ConnectorGrant {
        id: format!("grant:{version_id}"),
        connector_version_id: version_id.clone(),
        scope: "user".to_string(),
        status: "active".to_string(),
        credential_ref: None,
        approved_by: Some("local".to_string()),
        revoked_at: None,
        notes: None,
        created_at: now,
    };
    connectors::upsert_grant(&state.db, &grant)
        .await
        .map_err(|e| e.to_string())?;

    Ok(AddLocalConnectorResult {
        connector_id,
        connector_version_id: version_id,
    })
}

// ---------------------------------------------------------------------------
// Remote / registry connectors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRemoteConnectorRequest {
    pub name: String,
    pub description: Option<String>,
    pub url: String,
    pub version: Option<String>,
    pub consent_copy: Option<String>,
}

#[tauri::command]
pub async fn search_mcp_registry(query: String) -> Result<Vec<RegistryServer>, String> {
    crate::mcp_registry::search_official_registry(&query).await
}

#[tauri::command]
pub async fn add_remote_connector(
    state: State<'_, AppState>,
    request: AddRemoteConnectorRequest,
) -> Result<AddLocalConnectorResult, String> {
    add_remote_connector_inner(state.inner(), request).await
}

pub async fn add_remote_connector_inner(
    state: &AppState,
    request: AddRemoteConnectorRequest,
) -> Result<AddLocalConnectorResult, String> {
    let transport_config = serde_json::json!({ "url": request.url });
    HttpSseConfig::from_value(&transport_config).map_err(|e| e.message)?;

    let now = crate::time::now_iso8601();
    let version_label = request
        .version
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("1.0.0");
    let connector_id = format!("remote:{}", slugify(&request.name));
    let version_id = format!("{connector_id}:{version_label}");

    let def = ConnectorDefinition {
        id: connector_id.clone(),
        name: request.name.clone(),
        description: request.description.unwrap_or_default(),
        transport: "httpSse".to_string(),
        owner: "remote".to_string(),
        icon: None,
        support_url: None,
        consent_copy: request.consent_copy.clone(),
        policy_metadata: None,
        cloud_id: None,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    connectors::upsert_definition(&state.db, &def)
        .await
        .map_err(|e| e.to_string())?;

    if connectors::get_version(&state.db, &version_id)
        .await
        .map_err(|e| e.to_string())?
        .is_none()
    {
        let version = ConnectorVersion {
            id: version_id.clone(),
            connector_id: connector_id.clone(),
            version: version_label.to_string(),
            transport_config,
            scope_grants: None,
            capability_allowlist: None,
            rollout_channel: None,
            support_state: Some("available".to_string()),
            created_at: now.clone(),
        };
        connectors::insert_version(&state.db, &version)
            .await
            .map_err(|e| e.to_string())?;
    }

    let grant = ConnectorGrant {
        id: format!("grant:{version_id}"),
        connector_version_id: version_id.clone(),
        scope: "user".to_string(),
        status: "active".to_string(),
        credential_ref: None,
        approved_by: Some("local".to_string()),
        revoked_at: None,
        notes: None,
        created_at: now,
    };
    connectors::upsert_grant(&state.db, &grant)
        .await
        .map_err(|e| e.to_string())?;

    Ok(AddLocalConnectorResult {
        connector_id,
        connector_version_id: version_id,
    })
}

#[tauri::command]
#[allow(deprecated)]
pub async fn signin_remote_connector(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    runtime: State<'_, ConnectorRuntimeManager>,
    connector_version_id: String,
) -> Result<(), String> {
    signin_remote_connector_inner(
        state.inner(),
        runtime.inner(),
        &connector_version_id,
        |url| {
            use tauri_plugin_shell::ShellExt;
            let validated = crate::validation::validate_external_open_url(url)
                .ok_or_else(|| "Invalid authorization URL".to_string())?;
            app.shell().open(validated, None).map_err(|e| e.to_string())
        },
    )
    .await
}

pub async fn signin_remote_connector_inner(
    state: &AppState,
    runtime: &ConnectorRuntimeManager,
    connector_version_id: &str,
    open_browser: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    let version = connectors::get_version(&state.db, connector_version_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("connector version {connector_version_id} not found"))?;
    let url = version
        .transport_config
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "remote connector is missing a URL".to_string())?;
    let cfg = HttpSseConfig::from_value(&version.transport_config).map_err(|e| e.message)?;
    let mut transport = mcp_runtime::HttpSseTransport::new(
        cfg,
        mcp_runtime::ClientInfo {
            name: "Conduit".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        },
    );
    let cancel = tokio_util::sync::CancellationToken::new();
    let www_authenticate = match transport.initialize(&cancel).await {
        Ok(_) => {
            runtime.start_connector(state, connector_version_id).await?;
            return Ok(());
        }
        Err(e) if e.category == mcp_runtime::ErrorCategory::AuthExpired => e.www_authenticate,
        Err(e) => return Err(e.message),
    };

    let token =
        crate::mcp_oauth::authorize_connector(url, www_authenticate.as_deref(), open_browser)
            .await?;
    let cred_ref = crate::mcp_oauth::persist_token(state, connector_version_id, &token)?;
    let mut grants = connectors::list_grants_for_version(&state.db, connector_version_id)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(grant) = grants.iter_mut().find(|g| g.status == "active") {
        grant.credential_ref = Some(cred_ref);
        connectors::upsert_grant(&state.db, grant)
            .await
            .map_err(|e| e.to_string())?;
    }
    runtime.start_connector(state, connector_version_id).await?;
    Ok(())
}

/// Lowercase + replace non-alphanumerics with `-` for a stable connector id.
pub(crate) fn slugify(s: &str) -> String {
    let slug: String = s
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "connector".to_string()
    } else {
        trimmed.to_string()
    }
}

// ---------------------------------------------------------------------------
// Tenant / license (display state)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_tenant_config(
    state: State<'_, AppState>,
    tenant_id: String,
) -> Result<Option<crate::db::repository::tenant_cache::TenantConfigCache>, String> {
    crate::db::repository::tenant_cache::get_tenant_config(&state.db, &state.encryption, &tenant_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_license_state(
    state: State<'_, AppState>,
) -> Result<Option<crate::db::repository::licenses::License>, String> {
    crate::db::repository::licenses::get_active_license(&state.db, &state.encryption)
        .await
        .map_err(|e| e.to_string())
}
