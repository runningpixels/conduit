import { useEffect, useState } from 'react';
import type { GenerationControls } from '@conduit/config-schema';
import {
  draftFromControls,
  emptyGenerationDraft,
  GenerationFields,
  parseGenerationDraft,
} from './GenerationFields';
import { useT } from '../i18n';

interface ComposerChatSettingsProps {
  open: boolean;
  streaming: boolean;
  defaults: { generationControls?: GenerationControls | null; userInstructions?: string | null };
  override: { generationControls?: GenerationControls | null; userInstructions?: string | null };
  onClose: () => void;
  onSave: (
    generationControls: GenerationControls | null,
    userInstructions: string | null,
  ) => void;
  onOpenSettingsDefaults?: () => void;
}

/** Per-conversation generation + instructions popover (t0-6). */
export function ComposerChatSettings({
  open,
  streaming,
  defaults,
  override,
  onClose,
  onSave,
  onOpenSettingsDefaults,
}: ComposerChatSettingsProps) {
  const t = useT();
  const [draft, setDraft] = useState(() =>
    draftFromControls(
      override.generationControls ?? defaults.generationControls,
      override.userInstructions ?? defaults.userInstructions,
    ),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDraft(
      draftFromControls(
        override.generationControls ?? defaults.generationControls,
        override.userInstructions ?? defaults.userInstructions,
      ),
    );
  }, [open, override.generationControls, override.userInstructions, defaults.generationControls, defaults.userInstructions]);

  if (!open) return null;

  const hasOverride = Boolean(override.generationControls || override.userInstructions);

  function save() {
    const parsed = parseGenerationDraft(draft);
    if (parsed.errorId) {
      setError(t(parsed.errorId, parsed.errorParams));
      return;
    }
    onSave(parsed.controls, parsed.userInstructions);
    onClose();
  }

  function useDefaults() {
    onSave(null, null);
    setDraft(emptyGenerationDraft());
    onClose();
  }

  return (
    <div
      id="composer-chat-settings"
      role="dialog"
      aria-label={t('chat.composerSettings.ariaLabel')}
      className="chat-settings-pop"
    >
      <p className="chat-settings-pop-lead">
        {hasOverride ? t('chat.composerSettings.overrideLead') : t('chat.composerSettings.defaultLead')}
      </p>
      <GenerationFields draft={draft} onChange={setDraft} idPrefix="chat-gen" />
      {error ? (
        <p className="chat-settings-pop-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="chat-settings-pop-actions">
        <button className="btn primary" type="button" disabled={streaming} onClick={save}>
          {t('chat.composerSettings.save')}
        </button>
        <button className="btn ghost" type="button" disabled={streaming} onClick={useDefaults}>
          {t('chat.composerSettings.useDefaults')}
        </button>
        <button className="btn ghost" type="button" onClick={onClose}>
          {t('common.actions.cancel')}
        </button>
        {onOpenSettingsDefaults ? (
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              onClose();
              onOpenSettingsDefaults();
            }}
          >
            {t('chat.composerSettings.defaultsInSettings')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
