//! Per-connector supervision: watch liveness and restart on crash with a
//! bounded backoff. Runs as a detached task per active connector; exits when
//! the connector's `CancellationToken` fires (stop / shutdown_all / revocation).

use std::sync::Arc;
use std::time::{Duration, Instant};

use mcp_runtime::McpError;
use tracing::{info, warn};

use super::{build_transport, persist_health, ActiveConnector, RESTART_MAX, RESTART_WINDOW};
use crate::db::DbPool;

/// Spawn the watch loop for a connector.
pub fn spawn(
    conn: Arc<ActiveConnector>,
    pool: DbPool,
    version_id: String,
    liveness_interval: Duration,
) {
    tokio::spawn(async move {
        supervise(conn, pool, version_id, liveness_interval).await;
    });
}

async fn supervise(
    conn: Arc<ActiveConnector>,
    pool: DbPool,
    version_id: String,
    liveness_interval: Duration,
) {
    let mut restart_times: Vec<Instant> = Vec::new();
    let mut restart_count: i64 = 0;

    loop {
        // Sleep until the next liveness tick, or exit on cancel.
        tokio::select! {
            _ = conn.cancel.cancelled() => break,
            _ = tokio::time::sleep(liveness_interval) => {}
        }

        let alive = {
            let mut t = conn.transport.lock().await;
            t.is_alive().await
        };
        if alive {
            continue;
        }

        // --- crash detected: apply restart/backoff policy -------------------
        restart_times.retain(|t| t.elapsed() < RESTART_WINDOW);
        if restart_times.len() >= RESTART_MAX as usize {
            warn!(
                target: "mcp_connector",
                %version_id,
                restarts = restart_times.len(),
                "connector crashed repeatedly; marking down and stopping supervisor"
            );
            let _ = persist_health(
                &pool,
                &version_id,
                "down",
                Some("repeated crashes; supervisor stopped retrying"),
                restart_count,
                false,
            )
            .await;
            break;
        }
        restart_times.push(Instant::now());
        restart_count += 1;
        let _ = persist_health(
            &pool,
            &version_id,
            "degraded",
            Some("connector process exited; restarting"),
            restart_count,
            false,
        )
        .await;

        match restart_connector(&conn).await {
            Ok(()) => {
                let _ = persist_health(&pool, &version_id, "healthy", None, restart_count, false).await;
                info!(target: "mcp_connector", %version_id, restart_count, "connector restarted");
            }
            Err(e) => {
                warn!(target: "mcp_connector", %version_id, error = %e.message, "restart failed");
                let _ = persist_health(&pool, &version_id, "degraded", Some(&e.message), restart_count, false).await;
            }
        }
    }
}

/// Rebuild + re-initialize the transport behind the mutex. Returns Ok if the
/// connector is alive again and re-initialized.
async fn restart_connector(conn: &Arc<ActiveConnector>) -> Result<(), McpError> {
    let mut new_transport = build_transport(&conn.spec, &conn.client)?;
    new_transport.initialize(&conn.cancel).await?;
    let mut guard = conn.transport.lock().await;
    *guard = new_transport;
    Ok(())
}