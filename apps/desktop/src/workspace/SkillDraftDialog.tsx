import { useEffect, useId, useRef, useState } from 'react';
import type { SkillSummary } from '../ipc/contracts';
import { cancelSkillDraft, draftSkillFromChat, saveSkillDraft, type SkillDraft } from '../ipc/client';
import { useT } from '../i18n';
import { useFocusTrap } from '../shell/useFocusTrap';
import { skillExistsName } from './settings/skillExists';

interface SkillDraftDialogProps {
  /** The chat the skill is drafted from, and turned on for once saved. */
  conversationId: string;
  onClose: () => void;
  onSaved: (skill: SkillSummary) => void;
}

type Phase =
  | { kind: 'drafting' }
  | { kind: 'failed'; error: string }
  | { kind: 'editing'; error: string | null; conflict: string | null; saving: boolean };

/**
 * "Make a skill from this chat": the chat's model drafts a SKILL.md, the user
 * edits its name, description and instructions, and Save writes it and turns
 * it on for the chat. Nothing is saved before Save.
 */
export function SkillDraftDialog({ conversationId, onClose, onSaved }: SkillDraftDialogProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'drafting' });
  const [draft, setDraft] = useState<SkillDraft>({ name: '', description: '', body: '' });
  const [attempt, setAttempt] = useState(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useFocusTrap(dialogRef, true);

  useEffect(() => {
    let live = true;
    setPhase({ kind: 'drafting' });
    draftSkillFromChat(conversationId)
      .then((drafted) => {
        if (!live) return;
        setDraft(drafted);
        setPhase({ kind: 'editing', error: null, conflict: null, saving: false });
      })
      .catch((e: unknown) => {
        if (live) setPhase({ kind: 'failed', error: String(e) });
      });
    return () => {
      live = false;
    };
  }, [conversationId, attempt]);

  const close = () => {
    if (phaseRef.current.kind === 'drafting') void cancelSkillDraft().catch(() => undefined);
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  async function save(replace: boolean) {
    setPhase({ kind: 'editing', error: null, conflict: null, saving: true });
    try {
      const skill = await saveSkillDraft(
        { name: draft.name.trim(), description: draft.description.trim(), body: draft.body },
        conversationId,
        replace,
      );
      onSaved(skill);
    } catch (e) {
      const taken = replace ? null : skillExistsName(e);
      setPhase(
        taken !== null
          ? { kind: 'editing', error: null, conflict: taken, saving: false }
          : { kind: 'editing', error: String(e), conflict: null, saving: false },
      );
    }
  }

  const edit = (patch: Partial<SkillDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (phase.kind === 'editing' && (phase.error || phase.conflict)) {
      setPhase({ ...phase, error: null, conflict: null });
    }
  };

  let content: React.ReactNode;
  if (phase.kind === 'drafting') {
    content = (
      <>
        <div className="cu-dialog-body" role="status">
          {t('workspace.skillDraft.drafting')}
        </div>
        <div className="cu-dialog-actions">
          <button className="btn ghost" type="button" onClick={close}>
            {t('common.actions.cancel')}
          </button>
        </div>
      </>
    );
  } else if (phase.kind === 'failed') {
    content = (
      <>
        <div className="cu-dialog-body skill-error" role="alert">
          {t('workspace.skillDraft.failed', { error: phase.error })}
        </div>
        <div className="cu-dialog-actions">
          <button className="btn ghost" type="button" onClick={close}>
            {t('common.actions.close')}
          </button>
          <button className="btn primary" type="button" onClick={() => setAttempt((n) => n + 1)}>
            {t('workspace.skillDraft.retry')}
          </button>
        </div>
      </>
    );
  } else {
    const ready = Boolean(draft.name.trim() && draft.description.trim() && draft.body.trim());
    content = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !phase.saving && phase.conflict === null) void save(false);
        }}
      >
        <label className="cu-dialog-phrase">
          <span>{t('workspace.skillDraft.nameLabel')}</span>
          <input
            type="text"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            value={draft.name}
            disabled={phase.saving}
            onChange={(e) => edit({ name: e.target.value })}
          />
          <small className="skill-draft-hint">{t('workspace.skillDraft.nameHint')}</small>
        </label>
        <label className="cu-dialog-phrase">
          <span>{t('workspace.skillDraft.descriptionLabel')}</span>
          <textarea
            rows={3}
            maxLength={1024}
            value={draft.description}
            disabled={phase.saving}
            onChange={(e) => edit({ description: e.target.value })}
          />
        </label>
        <label className="cu-dialog-phrase">
          <span>{t('workspace.skillDraft.bodyLabel')}</span>
          <textarea
            className="skill-draft-body"
            rows={12}
            value={draft.body}
            disabled={phase.saving}
            onChange={(e) => edit({ body: e.target.value })}
          />
        </label>
        {phase.error ? (
          <p className="cu-dialog-body skill-error" role="alert">
            {phase.error}
          </p>
        ) : null}
        {phase.conflict !== null ? (
          <>
            <p className="cu-dialog-body" role="alert">
              {t('settings.skills.replace.prompt', { name: phase.conflict })}
            </p>
            <div className="cu-dialog-actions">
              <button className="btn ghost" type="button" onClick={() => setPhase({ ...phase, conflict: null })}>
                {t('common.actions.cancel')}
              </button>
              <button className="btn primary" type="button" onClick={() => void save(true)}>
                {t('settings.skills.replace.confirm')}
              </button>
            </div>
          </>
        ) : (
          <div className="cu-dialog-actions">
            <button className="btn ghost" type="button" onClick={close} disabled={phase.saving}>
              {t('common.actions.cancel')}
            </button>
            <button className="btn primary" type="submit" disabled={!ready || phase.saving}>
              {phase.saving ? t('workspace.skillDraft.saving') : t('common.actions.save')}
            </button>
          </div>
        )}
      </form>
    );
  }

  return (
    <div
      className="cu-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && phaseRef.current.kind !== 'editing') close();
      }}
    >
      <div ref={dialogRef} className="cu-dialog skill-draft-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 className="cu-dialog-title" id={titleId}>
          {t('workspace.skillDraft.title')}
        </h2>
        {content}
      </div>
    </div>
  );
}
