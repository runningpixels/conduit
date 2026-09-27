/// The ways to add a connector: install from the official MCP registry, add a
/// remote streamable-HTTP URL, or register a local stdio command. Transport
/// config is untrusted renderer input — the add commands validate it
/// server-side before persisting. Used by the Connectors page ("Add
/// connector") and by the compact `ConnectorsSection`.
import { useState } from 'react';
import type { RegistryServer } from '../../../ipc/contracts';
import { addLocalConnector, addRemoteConnector, searchMcpRegistry } from '../../../ipc/client';
import { useT } from '../../../i18n';

export function ConnectorAddPanel({
  onStatus,
  onAdded,
}: {
  onStatus: (message: string) => void;
  /** Called after a successful add with the new version id. */
  onAdded: (connectorVersionId: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [consentCopy, setConsentCopy] = useState('');
  const [registryQuery, setRegistryQuery] = useState('');
  const [registryHits, setRegistryHits] = useState<RegistryServer[]>([]);
  const [registryBusy, setRegistryBusy] = useState(false);
  const [remoteName, setRemoteName] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');

  async function handleAdd() {
    if (!name.trim() || !command.trim()) {
      onStatus(t('settings.connectors.addValidation'));
      return;
    }
    const argList = args.split(/\s+/).filter(Boolean);
    const envMap: Record<string, string> = {};
    for (const pair of env.split('\n')) {
      const i = pair.indexOf('=');
      if (i > 0) envMap[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    try {
      const result = await addLocalConnector({
        name: name.trim(),
        command: command.trim(),
        args: argList,
        env: envMap,
        consentCopy: consentCopy.trim() || undefined,
      });
      onStatus(t('settings.connectors.added', { id: result.connectorId }));
      setName('');
      setCommand('');
      setArgs('');
      setEnv('');
      setConsentCopy('');
      onAdded(result.connectorVersionId);
    } catch (e) {
      onStatus(t('settings.connectors.addFailed', { error: String(e) }));
    }
  }

  async function handleRegistrySearch() {
    setRegistryBusy(true);
    try {
      const hits = await searchMcpRegistry(registryQuery.trim());
      setRegistryHits(hits);
      onStatus(t('settings.connectors.registrySearch.results', { count: hits.length }));
    } catch (e) {
      onStatus(t('settings.connectors.registrySearchFailed', { error: String(e) }));
    } finally {
      setRegistryBusy(false);
    }
  }

  async function handleInstallRegistry(hit: RegistryServer) {
    if (!hit.installable || !hit.remoteUrl) {
      onStatus(hit.reason ?? t('settings.connectors.needsStreamableHttp'));
      return;
    }
    setRegistryBusy(true);
    try {
      const result = await addRemoteConnector({
        name: hit.title || hit.name,
        description: hit.description,
        url: hit.remoteUrl,
        version: hit.version,
      });
      onStatus(t('settings.connectors.installedRegistry', { id: result.connectorId }));
      onAdded(result.connectorVersionId);
    } catch (e) {
      onStatus(t('settings.connectors.installFailed', { error: String(e) }));
    } finally {
      setRegistryBusy(false);
    }
  }

  async function handleAddRemote() {
    if (!remoteName.trim() || !remoteUrl.trim()) {
      onStatus(t('settings.connectors.addRemoteValidation'));
      return;
    }
    try {
      const result = await addRemoteConnector({ name: remoteName.trim(), url: remoteUrl.trim() });
      onStatus(t('settings.connectors.addedRemote', { id: result.connectorId }));
      setRemoteName('');
      setRemoteUrl('');
      onAdded(result.connectorVersionId);
    } catch (e) {
      onStatus(t('settings.connectors.addRemoteFailed', { error: String(e) }));
    }
  }

  return (
    <div className="cx-add">
      <section className="cx-add-block" aria-label={t('settings.connectors.registry.heading')}>
        <div className="grp-label">{t('settings.connectors.registry.heading')}</div>
        <div className="cx-field-row">
          <input
            className="cx-input"
            aria-label={t('settings.connectors.registry.searchPlaceholder')}
            placeholder={t('settings.connectors.registry.searchPlaceholder')}
            value={registryQuery}
            onChange={(e) => setRegistryQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleRegistrySearch();
            }}
          />
          <button className="btn" type="button" disabled={registryBusy} onClick={() => void handleRegistrySearch()}>
            {t('common.actions.search')}
          </button>
        </div>
        {registryHits.length > 0 ? (
          <ul className="cx-rows">
            {registryHits.map((hit) => (
              <li key={`${hit.name}:${hit.version}`} className="cx-row">
                <span className="cx-row-text">
                  <b>{hit.title || hit.name}</b>
                  <small>
                    {hit.description}
                    {hit.reason ? ` — ${hit.reason}` : ''}
                  </small>
                </span>
                <button
                  className="btn"
                  type="button"
                  disabled={registryBusy || !hit.installable}
                  onClick={() => void handleInstallRegistry(hit)}
                >
                  {hit.installable ? t('settings.connectors.installButton') : t('settings.connectors.unavailableButton')}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="cx-add-block" aria-label={t('settings.connectors.add.remoteHeading')}>
        <div className="grp-label">{t('settings.connectors.add.remoteHeading')}</div>
        <input
          className="cx-input"
          aria-label={t('settings.connectors.registry.remoteNamePlaceholder')}
          placeholder={t('settings.connectors.registry.remoteNamePlaceholder')}
          value={remoteName}
          onChange={(e) => setRemoteName(e.target.value)}
        />
        <input
          className="cx-input"
          aria-label={t('settings.connectors.registry.remoteUrlPlaceholder')}
          placeholder={t('settings.connectors.registry.remoteUrlPlaceholder')}
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
        />
        <div className="cx-add-actions">
          <button className="btn" type="button" onClick={() => void handleAddRemote()}>
            {t('settings.connectors.registry.addRemoteButton')}
          </button>
        </div>
      </section>

      <section className="cx-add-block" aria-label={t('settings.connectors.add.localHeading')}>
        <div className="grp-label">{t('settings.connectors.add.localHeading')}</div>
        <input
          className="cx-input"
          aria-label={t('settings.connectors.form.namePlaceholder')}
          placeholder={t('settings.connectors.form.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="cx-input"
          aria-label={t('settings.connectors.form.commandPlaceholder')}
          placeholder={t('settings.connectors.form.commandPlaceholder')}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <input
          className="cx-input"
          aria-label={t('settings.connectors.form.argsPlaceholder')}
          placeholder={t('settings.connectors.form.argsPlaceholder')}
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
        <textarea
          className="cx-input cx-mono"
          aria-label={t('settings.connectors.form.envPlaceholder')}
          placeholder={t('settings.connectors.form.envPlaceholder')}
          value={env}
          onChange={(e) => setEnv(e.target.value)}
          rows={2}
        />
        <input
          className="cx-input"
          aria-label={t('settings.connectors.form.consentPlaceholder')}
          placeholder={t('settings.connectors.form.consentPlaceholder')}
          value={consentCopy}
          onChange={(e) => setConsentCopy(e.target.value)}
        />
        <div className="cx-add-actions">
          <button className="btn primary" type="button" onClick={() => void handleAdd()}>
            {t('settings.connectors.form.addButton')}
          </button>
        </div>
      </section>
    </div>
  );
}
