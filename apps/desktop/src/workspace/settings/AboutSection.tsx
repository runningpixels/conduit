import type { AppPaths } from '../../ipc/contracts';
import { useT } from '../../i18n';

interface AboutSectionProps {
  paths: AppPaths | null;
}

/** About section: app root paths display (read-only). */
export function AboutSection({ paths }: AboutSectionProps) {
  const t = useT();
  if (!paths) return null;

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>{t('settings.about.header.title')}</span>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <div className="status-item">
          <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>{t('settings.about.appRoot.label')}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', wordBreak: 'break-all' }}>{paths.root}</span>
        </div>
        <div className="status-item">
          <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>{t('settings.about.settingsFile.label')}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', wordBreak: 'break-all' }}>{paths.settingsFile}</span>
        </div>
        <div className="status-item">
          <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>{t('settings.about.database.label')}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', wordBreak: 'break-all' }}>{paths.database}</span>
        </div>
      </div>
    </div>
  );
}
