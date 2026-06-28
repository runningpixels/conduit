import { useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';

interface ArtifactSecuritySectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
}

/** Artifact Security: remote allowlist management for rendered HTML artifacts. */
export function ArtifactSecuritySection({ settings, onUpdate }: ArtifactSecuritySectionProps) {
  const [allowlistInput, setAllowlistInput] = useState('');

  function handleAdd() {
    const v = allowlistInput.trim();
    if (!v) return;
    if (settings.artifactRemoteAllowlist.includes(v)) {
      setAllowlistInput('');
      return;
    }
    onUpdate({ ...settings, artifactRemoteAllowlist: [...settings.artifactRemoteAllowlist, v] });
    setAllowlistInput('');
  }

  function handleRemove(origin: string) {
    onUpdate({
      ...settings,
      artifactRemoteAllowlist: settings.artifactRemoteAllowlist.filter((o) => o !== origin),
    });
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>Artifact Security</span>
      </div>
      <div className="status-item" style={{ display: 'grid', gap: 6, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
        <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>
          Artifact remote allowlist
        </span>
        <span style={{ fontSize: '12px', color: 'var(--text-2)', lineHeight: 1.5 }}>
          Trusted origins rendered HTML artifacts may load images, fonts, and styles from. Scripts and network API calls (fetch/XHR) are blocked regardless. Empty = artifacts are fully offline.
        </span>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <input
            value={allowlistInput}
            onChange={(e) => setAllowlistInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
            placeholder="https://fonts.example.com"
            style={{ flex: 1, borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: '12px' }}
          />
          <button className="btn" type="button" onClick={handleAdd}>
            Add
          </button>
        </div>
        {settings.artifactRemoteAllowlist.length === 0 ? (
          <span style={{ fontSize: '12px', color: 'var(--text-3)' }}>No origins allowlisted — artifacts are offline.</span>
        ) : (
          <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'grid', gap: 4 }}>
            {settings.artifactRemoteAllowlist.map((origin) => (
              <li key={origin} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
                <span style={{ flex: 1, wordBreak: 'break-all' }}>{origin}</span>
                <button
                  className="btn ghost"
                  type="button"
                  style={{ padding: '2px 8px' }}
                  onClick={() => handleRemove(origin)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <span style={{ fontSize: '11px', color: 'var(--text-3)' }}>Invalid origins are rejected by Rust on save.</span>
      </div>
    </div>
  );
}
