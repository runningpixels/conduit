//! Phase 4 connector runtime manager — owns launch, shutdown, process
//! supervision, restart/backoff, concurrency caps, timeouts, and runtime
//! health state. Mirrors `stream_manager.rs` in shape: a managed piece of
//! Tauri state whose methods take `&AppState` for DB/credential/path access.
//!
//! The transport-agnostic core (`McpTransport`, stdio, protocol, consent
//! policy, redaction) lives in the `mcp-runtime` crate. This module composes
//! that core with persistence, grant/support reconciliation, and the
//! supervised lifecycle.
//!
//! Trust boundary: connector `transport_config` is untrusted tenant/local
//! config — it is validated inside the transport before spawn, and a grant
//! must be `Active` with a non-disabling `support_state` before launch. No
//! connector child outlives `shutdown_all` (app quit / disable / sign-out /
//! revocation).

pub mod consent;
pub mod discovery;
pub mod execution;
pub mod supervisor;

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use mcp_runtime::{
    protocol::{ClientInfo, ServerInfo},
    HttpSseConfig, HttpSseTransport, McpError, McpTransport, StdioConfig, StdioTransport,
    ToolOutput,
};
use provider_core::schema::ConsentDecision;
use tokio::sync::Mutex as TokioMutex;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::db::repository::connectors as conn_repo;
use crate::db::DbPool;
use crate::state::AppState;
use crate::time::now_iso8601;

/// Inline-default supervision policy (04b may promote to a configurable table).
const DEFAULT_LIVENESS_INTERVAL: Duration = Duration::from_millis(500);
const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// Restart cap: at most 3 restarts within a 5-minute window before the
/// connector is marked `down` and the supervisor stops retrying.
pub const RESTART_WINDOW: Duration = Duration::from_secs(300);
pub const RESTART_MAX: u32 = 3;
/// Concurrency cap: at most this many connectors running at once.
const CONCURRENCY_CAP: usize = 8;

/// Which transport to build and the validated config for it.
#[derive(Clone)]
pub enum TransportSpec {
    Stdio(StdioConfig),
    HttpSse(HttpSseConfig),
}

impl TransportSpec {
    fn from_definition(transport: &str, transport_config: &serde_json::Value) -> Result<Self, McpError> {
        match transport {
            "stdio" => Ok(Self::Stdio(StdioConfig::from_value(transport_config)?)),
            "httpSse" => Ok(Self::HttpSse(HttpSseConfig::from_value(transport_config)?)),
            other => Err(McpError::protocol(format!("unknown transport '{other}'"))),
        }
    }
}

/// A running connector, shared between the supervisor task and command-driven
/// calls. The transport is behind a `tokio::Mutex` because both the liveness
/// watcher and tool invocations need `&mut` access and calls are sequential
/// per connector.
pub struct ActiveConnector {
    pub cancel: CancellationToken,
    pub transport: Arc<TokioMutex<Box<dyn McpTransport>>>,
    pub spec: TransportSpec,
    pub client: ClientInfo,
}

#[derive(Clone)]
pub struct ConnectorRuntimeManager {
    active: Arc<StdMutex<HashMap<String, Arc<ActiveConnector>>>>,
    pending: consent::PendingConsents,
    client: ClientInfo,
    liveness_interval: Duration,
    call_timeout: Duration,
}

impl ConnectorRuntimeManager {
    pub fn new() -> Self {
        Self::new_with(
            DEFAULT_LIVENESS_INTERVAL,
            DEFAULT_CALL_TIMEOUT,
        )
    }

    /// Test entry point with tighter supervision timings.
    pub fn new_with(liveness_interval: Duration, call_timeout: Duration) -> Self {
        Self {
            active: Arc::new(StdMutex::new(HashMap::new())),
            pending: Arc::new(StdMutex::new(HashMap::new())),
            client: ClientInfo {
                name: "Conduit".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            liveness_interval,
            call_timeout,
        }
    }

    pub fn call_timeout(&self) -> Duration {
        self.call_timeout
    }

    /// Re-discover capabilities for a running connector and refresh the cache
    /// (replace-batch). This is the invalidation hook Phase 8 calls when a
    /// connector version or grant changes; `start_connector` also calls it on
    /// boot.
    pub async fn discover_capabilities(
        &self,
        state: &AppState,
        connector_version_id: &str,
    ) -> Result<Vec<conn_repo::ConnectorCapability>, String> {
        let pool = state.db.clone();
        let version = conn_repo::get_version(&pool, connector_version_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("connector version {connector_version_id} not found"))?;
        let active = self
            .active_connector(connector_version_id)
            .ok_or_else(|| "connector is not running".to_string())?;
        discovery::discover(&active, &pool, &version).await
    }

    /// Classify a pending tool call against the connector's live declaration
    /// and either return `Auto` (proceed) or register a pending consent and
    /// return the prompt + a receiver the caller awaits. The approve/deny IPC
    /// command resolves the receiver via `resolve_consent`.
    pub async fn request_consent(
        &self,
        state: &AppState,
        connector_version_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        arguments: &serde_json::Value,
    ) -> Result<consent::ConsentRequirement, String> {
        let pool = state.db.clone();
        let version = conn_repo::get_version(&pool, connector_version_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("connector version {connector_version_id} not found"))?;
        let definition = conn_repo::get(&pool, &version.connector_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("connector definition {} not found", version.connector_id))?;
        let active = self
            .active_connector(connector_version_id)
            .ok_or_else(|| "connector is not running".to_string())?;
        consent::request_consent(
            &active,
            &self.pending,
            &version,
            &definition,
            tool_call_id,
            tool_name,
            arguments,
        )
        .await
        .map_err(|e| e.message)
    }

    /// Fulfill a pending consent decision (approve/deny IPC command).
    pub fn resolve_consent(
        &self,
        tool_call_id: &str,
        decision: ConsentDecision,
    ) -> Result<(), String> {
        consent::resolve_consent(&self.pending, tool_call_id, decision)
    }

    /// Look up an active connector for command-driven calls (M4.4/M4.5).
    pub fn active_connector(&self, version_id: &str) -> Option<Arc<ActiveConnector>> {
        self.active
            .lock()
            .ok()
            .and_then(|g| g.get(version_id).cloned())
    }

    /// The set of currently-running connector version ids (M4.6 rail snapshot
    /// marks a row `running` when its process is live).
    pub fn active_version_ids(&self) -> std::collections::HashSet<String> {
        self.active
            .lock()
            .map(|g| g.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Invoke a tool on a running connector with the supervisor's per-call
    /// timeout and cancellation. This is the raw execution path; the consent
    /// engine (M4.4) gates calls *before* this and persistence (M4.5) records
    /// the result *after*. On timeout the in-flight call is torn down (the
    /// stdio child is killed) so the supervisor restarts a fresh connector.
    pub async fn invoke_tool(
        &self,
        version_id: &str,
        name: &str,
        arguments: &serde_json::Value,
        cancel: &CancellationToken,
    ) -> Result<ToolOutput, McpError> {
        let active = self
            .active_connector(version_id)
            .ok_or_else(|| McpError::unavailable("connector is not running"))?;
        let mut guard = active.transport.lock().await;
        let call = guard.call_tool(name, arguments, cancel);
        match tokio::time::timeout(self.call_timeout, call).await {
            Ok(res) => res,
            Err(_) => {
                // Timeout: drop the in-flight call, then kill the child so the
                // supervisor restarts a clean connector. Cancel the token too
                // so any cooperative select! branches observe it.
                cancel.cancel();
                let _ = guard.shutdown().await;
                Err(McpError::timeout(format!(
                    "tool '{name}' exceeded the {:?} call timeout",
                    self.call_timeout
                )))
            }
        }
    }

    /// Launch (or relaunch) a connector version. Validates the grant +
    /// support state, spawns + initializes the transport, records healthy
    /// runtime state, and starts the supervision watch loop.
    pub async fn start_connector(
        &self,
        state: &AppState,
        connector_version_id: &str,
    ) -> Result<ServerInfo, String> {
        // Idempotent: stop any existing instance for this version first.
        let _ = self.stop_connector(state, connector_version_id).await;

        self.enforce_concurrency_cap()?;

        let pool = state.db.clone();
        let version = conn_repo::get_version(&pool, connector_version_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("connector version {connector_version_id} not found"))?;
        let definition = conn_repo::get(&pool, &version.connector_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("connector definition {} not found", version.connector_id))?;

        // Reconcile grant + support state before touching the transport.
        // `transport_config` is untrusted; it is validated inside the transport.
        let grants = conn_repo::list_grants_for_version(&pool, connector_version_id)
            .await
            .map_err(|e| e.to_string())?;
        let has_active_grant = grants.iter().any(|g| g.status == "active");
        if !has_active_grant {
            return Err("connector has no active grant; refusing to start".to_string());
        }
        if let Some(support) = &version.support_state {
            match support.as_str() {
                "adminDisabled" => {
                    return Err("connector is admin-disabled for this workspace".to_string());
                }
                "revoked" => return Err("connector is revoked".to_string()),
                "authRequired" => {
                    return Err("connector requires authentication before start".to_string());
                }
                _ => {}
            }
        }

        let spec = TransportSpec::from_definition(&definition.transport, &version.transport_config)
            .map_err(|e| e.to_string())?;
        let mut transport = build_transport(&spec, &self.client).map_err(|e| e.to_string())?;
        let cancel = CancellationToken::new();
        let init_fut = transport.initialize(&cancel);
        let server = match tokio::time::timeout(self.call_timeout, init_fut).await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                let _ = persist_health(&pool, connector_version_id, "down", Some(&e.message), 0, false).await;
                return Err(e.message);
            }
            Err(_) => {
                cancel.cancel();
                let msg = format!("initialize exceeded the {:?} timeout", self.call_timeout);
                let _ = persist_health(&pool, connector_version_id, "down", Some(&msg), 0, false).await;
                return Err(msg);
            }
        };

        let active = Arc::new(ActiveConnector {
            cancel: cancel.clone(),
            transport: Arc::new(TokioMutex::new(transport)),
            spec: spec.clone(),
            client: self.client.clone(),
        });
        self.insert_active(connector_version_id, active.clone());

        persist_health(&pool, connector_version_id, "healthy", None, 0, true)
            .await
            .map_err(|e| e.to_string())?;
        info!(target: "mcp_connector", %connector_version_id, name = %server.name, "connector started");

        // M4.3: discover capabilities and cache them (replace-batch). Best-effort
        // — a discovery failure leaves the connector healthy with an empty cache.
        if let Err(e) = discovery::discover(&active, &pool, &version).await {
            warn!(target: "mcp_connector", %connector_version_id, error = %e, "discovery failed");
        }

        // Start the supervision watch loop (restart/backoff on crash).
        supervisor::spawn(active, pool, connector_version_id.to_string(), self.liveness_interval);

        Ok(server)
    }

    /// Stop a connector: cancel, best-effort graceful shutdown, remove from
    /// the active map, record `down` runtime state.
    pub async fn stop_connector(
        &self,
        state: &AppState,
        connector_version_id: &str,
    ) -> Result<(), String> {
        let active = self.remove_active(connector_version_id);
        let Some(active) = active else {
            return Ok(());
        };
        active.cancel.cancel();
        let mut transport = active.transport.lock().await;
        let _ = transport.shutdown().await;
        drop(transport);
        // Best-effort health update.
        let _ = persist_health(&state.db, connector_version_id, "down", None, 0, false).await;
        Ok(())
    }

    /// Tear down every active connector. Called on app quit / sign-out so no
    /// child outlives the runtime.
    pub async fn shutdown_all(&self) {
        let entries: Vec<(String, Arc<ActiveConnector>)> = self
            .active
            .lock()
            .map(|mut g| g.drain().collect::<Vec<_>>())
            .unwrap_or_default();
        for (id, active) in entries {
            active.cancel.cancel();
            let mut transport = active.transport.lock().await;
            let _ = transport.shutdown().await;
            info!(target: "mcp_connector", %id, "connector shut down on app exit");
        }
    }

    fn enforce_concurrency_cap(&self) -> Result<(), String> {
        let len = self
            .active
            .lock()
            .map(|g| g.len())
            .map_err(|_| "connector registry lock poisoned".to_string())?;
        if len >= CONCURRENCY_CAP {
            return Err(format!(
                "connector concurrency cap reached ({CONCURRENCY_CAP}); stop one before starting another"
            ));
        }
        Ok(())
    }

    fn insert_active(&self, version_id: &str, conn: Arc<ActiveConnector>) {
        if let Ok(mut g) = self.active.lock() {
            g.insert(version_id.to_string(), conn);
        }
    }

    fn remove_active(&self, version_id: &str) -> Option<Arc<ActiveConnector>> {
        self.active
            .lock()
            .ok()
            .and_then(|mut g| g.remove(version_id))
    }
}

impl Default for ConnectorRuntimeManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Build (but do not initialize) a transport from a spec.
fn build_transport(spec: &TransportSpec, client: &ClientInfo) -> Result<Box<dyn McpTransport>, McpError> {
    match spec {
        TransportSpec::Stdio(cfg) => Ok(Box::new(StdioTransport::spawn(cfg.clone(), client.clone())?)),
        TransportSpec::HttpSse(cfg) => Ok(Box::new(HttpSseTransport::new(cfg.clone()))),
    }
}

/// Persist runtime health. `started` controls whether `last_started_at` is
/// bumped (only on a fresh start, not on restart/health-only updates).
pub(crate) async fn persist_health(
    pool: &DbPool,
    version_id: &str,
    health: &str,
    last_error: Option<&str>,
    restart_count: i64,
    started: bool,
) -> Result<(), crate::db::DbError> {
    let last_started_at = if started { Some(now_iso8601()) } else { None };
    conn_repo::upsert_runtime_state(
        pool,
        &conn_repo::ConnectorRuntimeState {
            connector_version_id: version_id.to_string(),
            health: health.to_string(),
            last_started_at,
            last_error: last_error.map(|s| s.to_string()),
            restart_count,
        },
    )
    .await
}