import { useEffect, useState } from 'react';
import type { AppSettings, DiagnosticsExport } from '../../ipc/contracts';
import {
  acknowledgeDiagnosticsDisclosure,
  exportDiagnostics,
  getDiagnosticsDisclosureAcknowledged,
  revealPath,
} from '../../ipc/client';
import { ConfirmDialog } from '@conduit/ui';
import { useT } from '../../i18n';

interface DiagnosticsSectionProps {
  settings: AppSettings;
  onStatus: (message: string) => void;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Diagnostics section: disclosure, export, reveal. */
export function DiagnosticsSection({ settings, onStatus }: DiagnosticsSectionProps) {
  const t = useT();
  const [diagnostics, setDiagnostics] = useState<DiagnosticsExport | null>(null);
  const [disclosureAcknowledged, setDisclosureAcknowledged] = useState(true);
  const [showDisclosure, setShowDisclosure] = useState(false);

  useEffect(() => {
    void getDiagnosticsDisclosureAcknowledged().then(setDisclosureAcknowledged);
  }, []);

  async function runExport() {
    try {
      const result = await exportDiagnostics();
      setDiagnostics(result);
      onStatus(t('settings.diagnostics.status.exported', { path: result.exportedTo }));
    } catch (err) {
      onStatus(t('settings.diagnostics.status.exportFailed', { error: String(err) }));
    }
  }

  async function handleExportDiagnostics() {
    if (!settings.diagnosticsEnabled) {
      onStatus(t('settings.diagnostics.status.disabled'));
      return;
    }
    if (!disclosureAcknowledged) {
      setShowDisclosure(true);
      return;
    }
    await runExport();
  }

  async function handleAcknowledgeAndExport() {
    setShowDisclosure(false);
    try {
      await acknowledgeDiagnosticsDisclosure();
      setDisclosureAcknowledged(true);
      await runExport();
    } catch (err) {
      onStatus(t('settings.diagnostics.status.exportFailed', { error: String(err) }));
    }
  }

  async function handleRevealExports() {
    if (!diagnostics) return;
    try {
      await revealPath();
    } catch (err) {
      onStatus(t('settings.diagnostics.status.revealFailed', { error: String(err) }));
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>{t('settings.diagnostics.header.title')}</span>
      </div>
      <div className="status-item">
        <p style={{ margin: '6px 0 0', fontSize: '12px', color: 'var(--ink-2)' }}>
          {t('settings.diagnostics.intro')}
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            className="btn primary"
            type="button"
            onClick={() => void handleExportDiagnostics()}
            disabled={!settings.diagnosticsEnabled}
            title={settings.diagnosticsEnabled ? undefined : t('settings.diagnostics.actions.exportDisabledTitle')}
          >
            {t('settings.diagnostics.actions.export')}
          </button>
          {!settings.diagnosticsEnabled && (
            <span style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{t('settings.diagnostics.disabledHint')}</span>
          )}
          {diagnostics && (
            <button className="btn" type="button" onClick={() => void handleRevealExports()}>
              {t('settings.diagnostics.actions.reveal')}
            </button>
          )}
        </div>
        {diagnostics && (
          <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
            <span style={{ color: 'var(--ink-3)', fontSize: '12px' }}>{t('settings.diagnostics.exportedToLabel')}</span>
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', wordBreak: 'break-all' }}>{diagnostics.exportedTo}</code>
            <pre className="code-block" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)', fontSize: '11.5px' }}>
              {prettyJson(diagnostics)}
            </pre>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showDisclosure}
        title={t('settings.diagnostics.disclosure.title')}
        description={t('settings.diagnostics.disclosure.body')}
        confirmLabel={t('settings.diagnostics.disclosure.confirmLabel')}
        cancelLabel={t('common.actions.cancel')}
        destructive={false}
        onCancel={() => {
          setShowDisclosure(false);
          onStatus(t('settings.diagnostics.status.cancelled'));
        }}
        onConfirm={() => void handleAcknowledgeAndExport()}
      />
    </div>
  );
}
