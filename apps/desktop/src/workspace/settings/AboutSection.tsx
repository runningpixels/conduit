import { useEffect, useState, type CSSProperties } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import type { AppPaths } from '../../ipc/contracts';
import { openExternalUrl } from '../../ipc/client';
import { useT } from '../../i18n';

interface AboutSectionProps {
  paths: AppPaths | null;
  onStatus: (message: string) => void;
}

const LICENSE_NAME = 'AGPL-3.0';
const WEBSITE = 'https://conduitllm.com';
const REPO = 'https://github.com/runningpixels/conduit';

const LABEL: CSSProperties = {
  color: 'var(--ink-3)',
  fontSize: 'var(--fs-xl)',
  textTransform: 'uppercase',
  letterSpacing: '.08em',
};
const PATH: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xl)', wordBreak: 'break-all' };

/**
 * About: which version this is, where to find the project, and
 * where it keeps its files on this machine. Usage and updates have their own
 * sections; this one only says what the app is and where it lives.
 */
export function AboutSection({ paths, onStatus }: AboutSectionProps) {
  const t = useT();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getVersion()
      .then((v) => live && setVersion(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const open = (url: string) => {
    openExternalUrl(url).catch((e: unknown) => onStatus(e instanceof Error ? e.message : String(e)));
  };

  const links = [
    { label: t('settings.about.website.label'), text: 'conduitllm.com', url: WEBSITE },
    { label: t('settings.about.source.label'), text: 'github.com/runningpixels/conduit', url: REPO },
    { label: t('settings.about.issues.label'), text: t('settings.about.issues.link'), url: `${REPO}/issues` },
    { label: t('settings.about.license.label'), text: LICENSE_NAME, url: `${REPO}/blob/main/LICENSE` },
  ];

  return (
    <>
      <div className="settings-section" style={{ marginBottom: 24 }}>
        <div style={{ display: 'grid', gap: 8 }}>
          {version && (
            <div className="status-item">
              <span style={LABEL}>{t('settings.about.version.label')}</span>
              <span style={PATH}>{version}</span>
            </div>
          )}
          {links.map((link) => (
            <div className="status-item" key={link.url}>
              <span style={LABEL}>{link.label}</span>
              <button type="button" className="btn ghost" style={{ justifySelf: 'start' }} onClick={() => open(link.url)}>
                {link.text}
              </button>
            </div>
          ))}
        </div>
      </div>

      {paths && (
        <div className="settings-section">
          <div className="settings-section-header">
            <span>{t('settings.about.files.title')}</span>
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="status-item">
              <span style={LABEL}>{t('settings.about.appRoot.label')}</span>
              <span style={PATH}>{paths.root}</span>
            </div>
            <div className="status-item">
              <span style={LABEL}>{t('settings.about.settingsFile.label')}</span>
              <span style={PATH}>{paths.settingsFile}</span>
            </div>
            <div className="status-item">
              <span style={LABEL}>{t('settings.about.database.label')}</span>
              <span style={PATH}>{paths.database}</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
