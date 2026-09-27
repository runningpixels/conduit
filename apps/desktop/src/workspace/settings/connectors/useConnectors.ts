/// Connector state and actions shared by the Connectors page and the compact
/// `ConnectorsSection` (Settings sheet, onboarding). One place owns the IPC
/// calls, the 5s health poll and every status message, so the two layouts
/// cannot drift apart in what they allow.
import { useCallback, useEffect, useState } from 'react';
import type { ConnectorCapability, ConnectorRuntimeSnapshot } from '../../../ipc/contracts';
import {
  discoverConnector,
  getConnectorRuntimeStates,
  listConnectorCapabilities,
  listConnectorGrants,
  listToolApprovalMemory,
  revokeConnectorGrant,
  revokeToolApprovalMemory,
  signinRemoteConnector,
  startConnector,
  stopConnector,
  type ToolApprovalMemoryRow,
} from '../../../ipc/client';
import { useT } from '../../../i18n';

export type ConnectorTone = 'ok' | 'warn' | 'bad' | 'hold';

/** Compact health/support → label mapping. */
export function connectorLabel(s: ConnectorRuntimeSnapshot): { tone: ConnectorTone; labelId: string } {
  if (s.grantStatus === 'revoked') return { tone: 'bad', labelId: 'settings.connectors.status.revoked' };
  if (s.supportState === 'adminDisabled') return { tone: 'bad', labelId: 'settings.connectors.status.disabled' };
  if (s.supportState === 'revoked') return { tone: 'bad', labelId: 'settings.connectors.status.revoked' };
  if (s.health === 'authRequired') return { tone: 'warn', labelId: 'settings.connectors.status.signIn' };
  if (s.supportState === 'authRequired') return { tone: 'warn', labelId: 'settings.connectors.status.signIn' };
  if (s.supportState === 'unsupported') return { tone: 'bad', labelId: 'settings.connectors.status.unsupported' };
  if (s.running && s.health === 'healthy') return { tone: 'ok', labelId: 'settings.connectors.status.live' };
  if (s.health === 'down') return { tone: 'bad', labelId: 'settings.connectors.status.down' };
  if (s.health === 'degraded') return { tone: 'warn', labelId: 'settings.connectors.status.degraded' };
  return { tone: 'hold', labelId: 'settings.connectors.status.stopped' };
}

export function needsSignIn(s: ConnectorRuntimeSnapshot): boolean {
  return connectorLabel(s).labelId === 'settings.connectors.status.signIn';
}

/** Start/Stop is offered only for an active, supported grant that is signed in. */
export function canToggle(s: ConnectorRuntimeSnapshot): boolean {
  return (
    s.grantStatus === 'active' &&
    s.supportState !== 'adminDisabled' &&
    s.supportState !== 'revoked' &&
    !needsSignIn(s)
  );
}

/** Tool approval keys are `{connectorVersionId}::{toolName}`. */
export function approvalTool(row: ToolApprovalMemoryRow): string {
  return row.toolKey.includes('::') ? row.toolKey.slice(row.toolKey.indexOf('::') + 2) : row.toolKey;
}

export function approvalVersionId(row: ToolApprovalMemoryRow): string | null {
  return row.toolKey.includes('::') ? row.toolKey.slice(0, row.toolKey.indexOf('::')) : null;
}

export function useConnectors(onStatus: (message: string) => void) {
  const t = useT();
  const [rows, setRows] = useState<ConnectorRuntimeSnapshot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [capabilities, setCapabilities] = useState<Record<string, ConnectorCapability[]>>({});
  const [approvals, setApprovals] = useState<ToolApprovalMemoryRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshingDiscovery, setRefreshingDiscovery] = useState<string | null>(null);

  const refreshApprovals = useCallback(() => {
    void listToolApprovalMemory()
      .then(setApprovals)
      .catch(() => setApprovals([]));
  }, []);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const nextRows = await getConnectorRuntimeStates();
        setRows(nextRows);
        const capabilityEntries = await Promise.all(
          nextRows.map(async (row) => {
            try {
              return [row.connectorVersionId, await listConnectorCapabilities(row.connectorVersionId)] as const;
            } catch {
              return [row.connectorVersionId, []] as const;
            }
          }),
        );
        setCapabilities(Object.fromEntries(capabilityEntries));
      } catch {
        setRows([]);
        setCapabilities({});
      } finally {
        setLoaded(true);
      }
    })();
    refreshApprovals();
  }, [refreshApprovals]);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function toggle(s: ConnectorRuntimeSnapshot) {
    setBusy(s.connectorVersionId);
    try {
      if (s.running) {
        await stopConnector(s.connectorVersionId);
        onStatus(t('settings.connectors.toggle.stopped', { name: s.connectorName }));
      } else {
        await startConnector(s.connectorVersionId);
        onStatus(t('settings.connectors.toggle.started', { name: s.connectorName }));
      }
      refresh();
    } catch (e) {
      onStatus(t('settings.connectors.toggle.error', { error: String(e) }));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(s: ConnectorRuntimeSnapshot) {
    if (!confirm(t('settings.connectors.revokeConfirm', { name: s.connectorName }))) return;
    try {
      const grants = await listConnectorGrants();
      const g = grants.find((x) => x.connectorVersionId === s.connectorVersionId);
      if (!g) {
        onStatus(t('settings.connectors.noGrantFound'));
        return;
      }
      await revokeConnectorGrant(g.id, s.connectorVersionId);
      onStatus(t('settings.connectors.revokeSucceeded', { name: s.connectorName }));
      refresh();
    } catch (e) {
      onStatus(t('settings.connectors.revokeFailed', { error: String(e) }));
    }
  }

  async function refreshDiscovery(s: ConnectorRuntimeSnapshot) {
    setRefreshingDiscovery(s.connectorVersionId);
    try {
      const next = await discoverConnector(s.connectorVersionId);
      setCapabilities((current) => ({ ...current, [s.connectorVersionId]: next }));
      onStatus(t('settings.connectors.refreshedTools', { name: s.connectorName }));
      refresh();
    } catch (e) {
      onStatus(t('settings.connectors.discoveryFailed', { error: String(e) }));
    } finally {
      setRefreshingDiscovery(null);
    }
  }

  async function signIn(s: ConnectorRuntimeSnapshot) {
    setBusy(s.connectorVersionId);
    try {
      await signinRemoteConnector(
        s.connectorVersionId,
        t('settings.connectors.oauth.signedIn'),
        // `{detail}` is passed through untouched: only Rust, at callback time,
        // knows what the authorization server said.
        t('settings.connectors.oauth.signInFailed', { detail: '{detail}' }),
      );
      onStatus(t('settings.connectors.signedIn', { name: s.connectorName }));
      refresh();
    } catch (e) {
      onStatus(t('settings.connectors.signInFailed', { error: String(e) }));
    } finally {
      setBusy(null);
    }
  }

  async function forgetApproval(row: ToolApprovalMemoryRow) {
    await revokeToolApprovalMemory(row.id);
    refreshApprovals();
    onStatus(t('settings.connectors.approvals.forgotStatus', { tool: approvalTool(row) }));
  }

  return {
    rows,
    loaded,
    capabilities,
    approvals,
    busy,
    refreshingDiscovery,
    refresh,
    toggle,
    revoke,
    refreshDiscovery,
    signIn,
    forgetApproval,
  };
}

export type ConnectorsState = ReturnType<typeof useConnectors>;
