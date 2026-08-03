import type { AppPaths } from '../../ipc/contracts';

interface AboutSectionProps {
  paths: AppPaths | null;
}

/** About section: app root paths display (read-only). */
export function AboutSection({ paths }: AboutSectionProps) {
  if (!paths) return null;

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>About</span>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <div className="status-item" style={{ display: 'grid', gap: 4, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--card)' }}>
          <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>App root</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', wordBreak: 'break-all' }}>{paths.root}</span>
        </div>
        <div className="status-item" style={{ display: 'grid', gap: 4, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--card)' }}>
          <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Settings file</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', wordBreak: 'break-all' }}>{paths.settingsFile}</span>
        </div>
        <div className="status-item" style={{ display: 'grid', gap: 4, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--card)' }}>
          <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Database</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', wordBreak: 'break-all' }}>{paths.database}</span>
        </div>
      </div>
    </div>
  );
}
