import type { AppSettings } from '../../ipc/contracts';

interface AppearanceSectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
}

/** Appearance settings: theme selection and artifact styled preview toggle. */
export function AppearanceSection({ settings, onUpdate }: AppearanceSectionProps) {
  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>Appearance</span>
      </div>
      <div className="form-grid" style={{ display: 'grid', gap: 12 }}>
        <label className="field" style={{ display: 'grid', gap: 6 }}>
          <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Theme</span>
          <select
            value={settings.theme}
            onChange={(e) => onUpdate({ ...settings, theme: e.target.value as AppSettings['theme'] })}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '10px 12px' }}
          >
            <option value="system">System</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
          <input
            type="checkbox"
            checked={settings.artifactStyledPreview ?? true}
            onChange={(e) => onUpdate({ ...settings, artifactStyledPreview: e.target.checked })}
          />
          Apply app-like styling to rendered artifacts (typography, spacing, code blocks)
        </label>
      </div>
    </div>
  );
}
