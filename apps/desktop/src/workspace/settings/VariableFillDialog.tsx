import { useState } from 'react';
import type { Prompt } from '../../ipc/contracts';

interface VariableFillDialogProps {
  prompt: Prompt;
  onConfirm: (filledBody: string) => void;
  onCancel: () => void;
}

/** Substitutes {{varName}} tokens with provided values. Leaves unfilled tokens as-is. */
function substituteVariables(body: string, values: Record<string, string>): string {
  let result = body;
  for (const [key, val] of Object.entries(values)) {
    if (val) {
      result = result.replaceAll(`{{${key}}}`, val);
    }
  }
  return result;
}

export function VariableFillDialog({ prompt, onConfirm, onCancel }: VariableFillDialogProps) {
  const variables = prompt.variables ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const v of variables) {
      init[v] = '';
    }
    return init;
  });

  if (variables.length === 0) {
    // No variables — insert directly
    return null; // caller should handle this case
  }

  return (
    <div
      className="variable-fill-overlay"
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
    >
      <div
        className="variable-fill-dialog"
        style={{
          background: 'var(--card)',
          borderRadius: 'var(--r-lg)',
          padding: 20,
          maxWidth: 420,
          width: '90%',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: '14px' }}>Fill in variables</h3>
        <p style={{ margin: '0 0 12px', fontSize: '12px', color: 'var(--ink-2)' }}>
          Prompt: <strong>{prompt.title}</strong>
        </p>

        <div style={{ display: 'grid', gap: 10 }}>
          {variables.map((varName) => (
            <label key={varName} style={{ display: 'grid', gap: 3, fontSize: '12px' }}>
              <span style={{ fontWeight: 500 }}>{varName}</span>
              <input
                autoFocus={varName === variables[0]}
                placeholder={`Value for ${varName}`}
                value={values[varName] ?? ''}
                onChange={(e) => setValues({ ...values, [varName]: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onConfirm(substituteVariables(prompt.body, values));
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
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => onConfirm(substituteVariables(prompt.body, values))}
          >
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}