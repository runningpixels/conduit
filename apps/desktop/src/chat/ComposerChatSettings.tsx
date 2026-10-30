import { useEffect, useState } from 'react';
import type { GenerationControls } from '@conduit/config-schema';
import {
  draftFromControls,
  emptyGenerationDraft,
  GenerationFields,
  parseGenerationDraft,
} from './GenerationFields';
import { useT } from '../i18n';
import type { ConversationProject } from '../ipc/contracts';
import { projectHasSettings } from './projectSummary';
import { fitPopover } from './fitPopover';

interface ComposerChatSettingsProps {
  open: boolean;
  streaming: boolean;
  defaults: { generationControls?: GenerationControls | null; userInstructions?: string | null };
  override: { generationControls?: GenerationControls | null; userInstructions?: string | null };
  /** The project the chat is in; what it adds is listed. */
  project?: ConversationProject | null;
  onOpenProjectSettings?: (folderId: string) => void;
  onClose: () => void;
  onSave: (
    generationControls: GenerationControls | null,
    userInstructions: string | null,
  ) => void;
  onOpenSettingsDefaults?: () => void;
}

/** Per-conversation generation + instructions popover (t0-6).
 *
 * Generation controls fall back to the Settings defaults, so the form starts
 * from them. Instructions stack instead (Settings, then the project, then the
 * chat), so the field holds only the chat's own and the others are listed:
 * starting it from the Settings text would send that text twice once saved. */
export function ComposerChatSettings({
  open,
  streaming,
  defaults,
  override,
  project = null,
  onOpenProjectSettings,
  onClose,
  onSave,
  onOpenSettingsDefaults,
}: ComposerChatSettingsProps) {
  const t = useT();
  const [draft, setDraft] = useState(() =>
    draftFromControls(
      override.generationControls ?? defaults.generationControls,
      override.userInstructions ?? null,
    ),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDraft(
      draftFromControls(
        override.generationControls ?? defaults.generationControls,
        override.userInstructions ?? null,
      ),
    );
  }, [open, override.generationControls, override.userInstructions, defaults.generationControls]);

  if (!open) return null;

  const hasOverride = Boolean(override.generationControls || override.userInstructions);
  const fromSettings = Boolean(defaults.userInstructions?.trim());
  const fromProject = project && projectHasSettings(project) ? project : null;

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
      ref={fitPopover}
    >
      <p className="chat-settings-pop-lead">
        {hasOverride ? t('chat.composerSettings.overrideLead') : t('chat.composerSettings.defaultLead')}
      </p>
      <GenerationFields draft={draft} onChange={setDraft} idPrefix="chat-gen" />
      {fromSettings || fromProject ? (
        <div className="chat-settings-pop-also">
          <p>{t('chat.composerSettings.alsoUsed')}</p>
          <ul>
            {fromSettings ? <li>{t('chat.composerSettings.fromSettings')}</li> : null}
            {fromProject?.userInstructions?.trim() ? (
              <li>{t('chat.composerSettings.projectInstructions', { name: fromProject.name })}</li>
            ) : null}
            {fromProject && fromProject.collectionIds.length > 0 ? (
              <li>
                {t('chat.composerSettings.projectCollections', {
                  name: fromProject.name,
                  count: fromProject.collectionIds.length,
                })}
              </li>
            ) : null}
            {fromProject && fromProject.skillIds.length > 0 ? (
              <li>
                {t('chat.composerSettings.projectSkills', { name: fromProject.name, count: fromProject.skillIds.length })}
              </li>
            ) : null}
          </ul>
          {fromProject && onOpenProjectSettings ? (
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                onClose();
                onOpenProjectSettings(fromProject.folderId);
              }}
            >
              {t('shell.sidebar.folder.projectSettings')}
            </button>
          ) : null}
        </div>
      ) : null}
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
