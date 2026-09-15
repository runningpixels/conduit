import { useState } from 'react';
import type { ConnectorPromptInfo } from '../ipc/contracts';
import { missingRequiredArguments } from './connectorCapabilities';
import { useT } from '../i18n';

interface McpPromptArgumentsDialogProps {
  prompt: ConnectorPromptInfo;
  onConfirm: (values: Record<string, string>) => void;
  onCancel: () => void;
}

/**
 * Argument-fill dialog for an MCP prompt that declares arguments (M4). Mirrors
 * the shape of VariableFillDialog: an overlay-centred card, one labeled input
 * per field. A prompt with no arguments is inserted directly — the caller
 * checks `needsArgumentDialog` and never mounts this component for it, but it
 * returns null defensively too.
 */
export function McpPromptArgumentsDialog({ prompt, onConfirm, onCancel }: McpPromptArgumentsDialogProps) {
  const t = useT();
  const args = prompt.arguments;
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const arg of args) init[arg.name] = '';
    return init;
  });

  if (args.length === 0) {
    // No arguments — caller inserts directly.
    return null;
  }

  const canConfirm = missingRequiredArguments(prompt, values).length === 0;
  const confirm = () => {
    if (canConfirm) onConfirm(values);
  };

  return (
    <div
      className="composer-mcp-args-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div
        className="composer-mcp-args-dialog"
        role="dialog"
        aria-label={t('chat.mcpPromptArgs.ariaLabel', { name: prompt.name })}
        style={{
          background: 'var(--card)',
          borderRadius: 'var(--r-lg)',
          padding: 20,
          maxWidth: 420,
          width: '90%',
          boxShadow: 'var(--shadow-modal-strong)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 'var(--fs-5xl)' }}>{t('chat.mcpPromptArgs.title')}</h3>
        <p style={{ margin: '0 0 12px', fontSize: 'var(--fs-xl)', color: 'var(--ink-2)' }}>
          {t('chat.mcpPromptArgs.promptLabel')} <strong>{prompt.name}</strong>
        </p>

        <div style={{ display: 'grid', gap: 10 }}>
          {args.map((arg) => (
            <label key={arg.name} style={{ display: 'grid', gap: 3, fontSize: 'var(--fs-xl)' }}>
              <span style={{ fontWeight: 500 }}>
                {arg.name}
                {arg.required ? ` ${t('chat.mcpPromptArgs.requiredMark')}` : ''}
              </span>
              {arg.description ? <small style={{ color: 'var(--ink-3)' }}>{arg.description}</small> : null}
              <input
                autoFocus={arg.name === args[0].name}
                aria-required={arg.required}
                placeholder={t('chat.mcpPromptArgs.valuePlaceholder', { name: arg.name })}
                value={values[arg.name] ?? ''}
                onChange={(e) => setValues({ ...values, [arg.name]: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    confirm();
                  } else if (e.key === 'Escape') {
                    onCancel();
                  }
                }}
                style={{
                  width: '100%',
                  borderRadius: 'var(--r-sm)',
                  border: '1px solid var(--line)',
                  background: 'var(--card)',
                  color: 'var(--ink)',
                  padding: '8px 10px',
                }}
              />
            </label>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn ghost" type="button" onClick={onCancel}>
            {t('common.actions.cancel')}
          </button>
          <button className="btn primary" type="button" disabled={!canConfirm} onClick={confirm}>
            {t('common.actions.insert')}
          </button>
        </div>
      </div>
    </div>
  );
}
