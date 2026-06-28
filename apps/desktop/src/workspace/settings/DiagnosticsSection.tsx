import { useEffect, useState } from 'react';
import type { AppSettings, DiagnosticsExport } from '../../ipc/contracts';
import {
  acknowledgeDiagnosticsDisclosure,
  exportDiagnostics,
  getDiagnosticsDisclosureAcknowledged,
  revealPath,
} from '../../ipc/client';

interface DiagnosticsSectionProps {
  settings: AppSettings;
  onStatus: (message: string) => void;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Phase 6 M6.5: the one-time diagnostics-export disclosure copy. */
const DIAGNOSTICS_DISCLOSURE_TEXT =
  'Conduit diagnostics export includes:\n' +
  '  • active provider + model\n' +
  '  • local-only flag, diagnostics-enabled flag, theme\n' +
  '  • redacted app paths (your home folder prefix is stripped)\n\n' +
  'It NEVER includes:\n' +
  '  • secrets or API keys\n' +
  '  • provider base URLs\n' +
  '  • artifact remote allowlists\n' +
  '  • conversation or message content\n\n' +
  'The bundle is written to your local exports folder. Export?';

/** Diagnostics section: disclosure, export, reveal. */
export function DiagnosticsSection({ settings, onStatus }: DiagnosticsSectionProps) {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsExport | null>(null);
  const [disclosureAcknowledged, setDisclosureAcknowledged] = useState(true);

  useEffect(() => {
    void getDiagnosticsDisclosureAcknowledged().then(setDisclosureAcknowledged);
  }, []);

  async function handleExportDiagnostics() {
    if (!settings.diagnosticsEnabled) {
      onStatus('Diagnostics export is disabled. Enable it above to export a support bundle.');
      return;
    }
    if (!disclosureAcknowledged) {
      const ok = window.confirm(DIAGNOSTICS_DISCLOSURE_TEXT);
      if (!ok) {
        onStatus('Diagnostics export cancelled');
        return;
      }
      await acknowledgeDiagnosticsDisclosure();
      setDisclosureAcknowledged(true);
    }
    try {
      const result = await exportDiagnostics();
      setDiagnostics(result);
      onStatus(`Diagnostics exported to ${result.exportedTo}`);
    } catch (err) {
      onStatus(`Diagnostics export failed: ${String(err)}`);
    }
  }

  async function handleRevealExports() {
    if (!diagnostics) return;
    try {
      await revealPath();
    } catch (err) {
      onStatus(`Could not reveal folder: ${String(err)}`);
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>Diagnostics</span>
      </div>
      <div className="status-item" style={{ display: 'grid', gap: 4, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
        <p style={{ margin: '6px 0 0', fontSize: '12px', color: 'var(--text-2)' }}>
          A diagnostics bundle contains your active provider/model, flags, theme, and redacted app paths. It never contains secrets, base URLs, allowlists, or conversation content.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            className="btn primary"
            type="button"
            onClick={() => void handleExportDiagnostics()}
            disabled={!settings.diagnosticsEnabled}
            title={settings.diagnosticsEnabled ? undefined : 'Enable diagnostics in Privacy & Data to export a support bundle'}
          >
            Export diagnostics
          </button>
          {!settings.diagnosticsEnabled && (
            <span style={{ fontSize: '12px', color: 'var(--text-3)' }}>Enable diagnostics in Privacy & Data to export a support bundle.</span>
          )}
          {diagnostics && (
            <button className="btn" type="button" onClick={() => void handleRevealExports()}>Reveal in folder</button>
          )}
        </div>
        {diagnostics && (
          <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
            <span style={{ color: 'var(--text-3)', fontSize: '12px' }}>Exported to</span>
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', wordBreak: 'break-all' }}>{diagnostics.exportedTo}</code>
            <pre className="code-block" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontSize: '11.5px' }}>
              {prettyJson(diagnostics)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
