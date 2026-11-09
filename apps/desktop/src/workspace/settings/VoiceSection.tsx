/// Settings → Voice: who turns dictation into text. Automatic uses the active
/// provider when it can transcribe, else the first of OpenAI, OpenRouter and
/// Groq with a saved key; choosing one pins it. A provider without a key gets
/// a key field right here, saved for dictation without touching the chat
/// provider.

import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import {
  dictationStatus,
  saveProviderCredential,
  updateSettings,
  type DictationStatus,
} from '../../ipc/client';
import { translateError } from '../../ipc/errors';
import { useT } from '../../i18n';
import { ExternalLinkButton } from './WebSearchSection';

/** Where to get a key for each provider that can transcribe. */
export const DICTATION_KEY_PAGES: Record<string, string> = {
  openai: 'https://platform.openai.com/api-keys',
  openrouter: 'https://openrouter.ai/keys',
  groq: 'https://console.groq.com/keys',
};

const AUTOMATIC = '';

export function VoiceSection({
  settings,
  onSettingsChange,
  onStatus,
}: {
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  onStatus: (message: string) => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<DictationStatus | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    void Promise.resolve()
      .then(() => dictationStatus())
      .then((s) => setStatus(s ?? null))
      .catch(() => setStatus(null));
  }, []);

  useEffect(reload, [reload, settings.dictationProvider, settings.activeProvider, settings.localOnly]);

  const choose = async (value: string) => {
    setSaving(true);
    try {
      const persisted = await updateSettings({ dictationProvider: value === AUTOMATIC ? null : value });
      onSettingsChange(persisted);
    } catch (e) {
      onStatus(translateError(e, t));
    } finally {
      setSaving(false);
      reload();
    }
  };

  const options = status?.options ?? [];
  const chosen = settings.dictationProvider ?? AUTOMATIC;
  const chosenOption = options.find((o) => o.id === chosen);
  const nameOf = (id: string) => options.find((o) => o.id === id)?.name ?? id;

  let note: string;
  if (settings.localOnly) note = t('settings.voice.localOnly');
  else if (status?.provider && status.providerName) {
    const model = options.find((o) => o.id === status.provider)?.model ?? '';
    note = t('settings.voice.sendsTo', { provider: status.providerName, model });
  } else if (chosen === AUTOMATIC) note = t('settings.voice.noneAutomatic');
  else note = t('settings.voice.needsKey', { provider: nameOf(chosen) });

  return (
    <div className="settings-section voice-settings">
      <div className="srow">
        <span className="srow-text">
          <b>{t('settings.voice.provider.label')}</b>
          <small>{t('settings.voice.provider.help')}</small>
        </span>
        <select
          className="sel"
          aria-label={t('settings.voice.provider.label')}
          value={chosen}
          disabled={saving}
          onChange={(e) => void choose(e.target.value)}
        >
          <option value={AUTOMATIC}>{t('settings.voice.provider.automatic')}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.hasKey ? o.name : t('settings.voice.provider.noKeyOption', { provider: o.name })}
            </option>
          ))}
        </select>
      </div>
      <p className="voice-settings-note" role="status" data-ready={status?.provider ? 'true' : 'false'}>
        {note}
      </p>
      {chosenOption && !chosenOption.hasKey && !settings.localOnly ? (
        <DictationKeyField
          providerId={chosenOption.id}
          providerName={chosenOption.name}
          onStatus={onStatus}
          onSaved={reload}
        />
      ) : null}
    </div>
  );
}

function DictationKeyField({
  providerId,
  providerName,
  onStatus,
  onSaved,
}: {
  providerId: string;
  providerName: string;
  onStatus: (message: string) => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setSecret(''), [providerId]);

  async function save() {
    setBusy(true);
    try {
      await saveProviderCredential({ providerId, secret });
      setSecret('');
      onStatus(t('settings.voice.key.saved', { provider: providerName }));
      onSaved();
    } catch (e) {
      onStatus(t('settings.voice.key.saveFailed', { provider: providerName, error: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  const page = DICTATION_KEY_PAGES[providerId];
  return (
    <div className="form-grid voice-settings-key">
      <p className="voice-settings-hint">{t('settings.voice.key.onlyDictation', { provider: providerName })}</p>
      {page ? (
        <ExternalLinkButton url={page} onStatus={onStatus}>
          {t('settings.voice.key.getKey', { provider: providerName })}
        </ExternalLinkButton>
      ) : null}
      <label className="field">
        <span className="voice-settings-hint">{t('settings.voice.key.label', { provider: providerName })}</span>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={t('settings.voice.key.placeholder')}
          autoComplete="off"
        />
      </label>
      <button className="btn primary" type="button" disabled={busy || !secret.trim()} onClick={() => void save()}>
        {t('settings.voice.key.save')}
      </button>
    </div>
  );
}
