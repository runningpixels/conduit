import type { GenerationControls } from '@conduit/config-schema';
import { useRef } from 'react';
import { useT } from '../i18n';

export interface GenerationFieldDraft {
  temperature: string;
  topP: string;
  maxTokens: string;
  stopSequences: string;
  userInstructions: string;
}

export function emptyGenerationDraft(): GenerationFieldDraft {
  return {
    temperature: '',
    topP: '',
    maxTokens: '',
    stopSequences: '',
    userInstructions: '',
  };
}

export function draftFromControls(
  controls?: GenerationControls | null,
  userInstructions?: string | null,
): GenerationFieldDraft {
  return {
    temperature: controls?.temperature != null ? String(controls.temperature) : '',
    topP: controls?.topP != null ? String(controls.topP) : '',
    maxTokens: controls?.maxTokens != null ? String(controls.maxTokens) : '',
    stopSequences: (controls?.stopSequences ?? []).join('\n'),
    userInstructions: userInstructions ?? '',
  };
}

/**
 * Validate a draft, returning a message *id* rather than a sentence.
 *
 * This is a plain function with two component call sites, so it cannot reach
 * the catalog itself — and returning English would put untranslated prose in
 * front of a user at exactly the moment something they typed was rejected.
 * The id travels; the caller renders it with its own `t`. The plan singles
 * settings validation errors out as one of the three surfaces that get
 * native-speaker review, which is why they are worth this indirection.
 */
/** Mirrors `STOP_SEQUENCE_MAX_COUNT` / `_CHARS` in `src-tauri/src/validation.rs`. */
const STOP_SEQUENCE_MAX_COUNT = 8;
const STOP_SEQUENCE_MAX_CHARS = 64;

export function parseGenerationDraft(draft: GenerationFieldDraft): {
  controls: GenerationControls | null;
  userInstructions: string | null;
  errorId?: string;
  /**
   * Values the message interpolates. The bounds live here and in
   * `src-tauri/src/validation.rs`; they must not also live in the catalog,
   * or a changed constant leaves the sentence quietly claiming the old one.
   */
  errorParams?: Record<string, string>;
} {
  const controls: GenerationControls = {};
  const tempRaw = draft.temperature.trim();
  if (tempRaw) {
    const temperature = Number.parseFloat(tempRaw);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      return { controls: null, userInstructions: null, errorId: 'error.validation.temperatureRange' };
    }
    controls.temperature = temperature;
  }
  const topRaw = draft.topP.trim();
  if (topRaw) {
    const topP = Number.parseFloat(topRaw);
    if (!Number.isFinite(topP) || topP < 0 || topP > 1) {
      return { controls: null, userInstructions: null, errorId: 'error.validation.topPRange' };
    }
    controls.topP = topP;
  }
  const maxRaw = draft.maxTokens.trim();
  if (maxRaw) {
    const maxTokens = Number.parseInt(maxRaw, 10);
    if (!Number.isFinite(maxTokens) || maxTokens < 1) {
      return { controls: null, userInstructions: null, errorId: 'error.validation.maxTokensRange' };
    }
    controls.maxTokens = maxTokens;
  }
  const stopSequences = draft.stopSequences
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (stopSequences.length > STOP_SEQUENCE_MAX_COUNT) {
    return {
      controls: null,
      userInstructions: null,
      errorId: 'error.validation.stopSequenceCount',
      errorParams: { max: String(STOP_SEQUENCE_MAX_COUNT) },
    };
  }
  if (stopSequences.some((s) => s.length > STOP_SEQUENCE_MAX_CHARS)) {
    return {
      controls: null,
      userInstructions: null,
      errorId: 'error.validation.stopSequenceLength',
      errorParams: { max: String(STOP_SEQUENCE_MAX_CHARS) },
    };
  }
  if (stopSequences.length > 0) controls.stopSequences = stopSequences;

  const userInstructions = draft.userInstructions.trim() || null;
  const hasControls =
    controls.temperature != null ||
    controls.topP != null ||
    controls.maxTokens != null ||
    (controls.stopSequences?.length ?? 0) > 0;
  return {
    controls: hasControls ? controls : null,
    userInstructions,
  };
}

interface GenerationFieldsProps {
  draft: GenerationFieldDraft;
  onChange: (next: GenerationFieldDraft) => void;
  /** Called when a field blurs (Settings auto-save). */
  onCommit?: (draft: GenerationFieldDraft) => void;
  idPrefix: string;
}

/** Shared temperature / top-p / max-tokens / stops / instructions fields. */
export function GenerationFields({ draft, onChange, onCommit, idPrefix }: GenerationFieldsProps) {
  const t = useT();
  const draftRef = useRef(draft);
  draftRef.current = draft;

  function patch(partial: Partial<GenerationFieldDraft>) {
    const next = { ...draftRef.current, ...partial };
    draftRef.current = next;
    onChange(next);
  }

  function commit() {
    onCommit?.(draftRef.current);
  }

  return (
    <div className="gen-fields">
      <label htmlFor={`${idPrefix}-temp`}>
        {t('chat.generation.temperature.label')}
        <input
          id={`${idPrefix}-temp`}
          type="number"
          min={0}
          max={2}
          step={0.1}
          placeholder={t('chat.generation.providerDefaultPlaceholder')}
          value={draft.temperature}
          onChange={(e) => patch({ temperature: e.target.value })}
          onBlur={commit}
        />
        <span className="gen-hint">{t('chat.generation.temperature.hint')}</span>
      </label>
      <label htmlFor={`${idPrefix}-topp`}>
        {t('chat.generation.topP.label')}
        <input
          id={`${idPrefix}-topp`}
          type="number"
          min={0}
          max={1}
          step={0.05}
          placeholder={t('chat.generation.providerDefaultPlaceholder')}
          value={draft.topP}
          onChange={(e) => patch({ topP: e.target.value })}
          onBlur={commit}
        />
        <span className="gen-hint">{t('chat.generation.topP.hint')}</span>
      </label>
      <label htmlFor={`${idPrefix}-max`}>
        {t('chat.generation.maxTokens.label')}
        <input
          id={`${idPrefix}-max`}
          type="number"
          min={1}
          step={1}
          placeholder={t('chat.generation.providerDefaultPlaceholder')}
          value={draft.maxTokens}
          onChange={(e) => patch({ maxTokens: e.target.value })}
          onBlur={commit}
        />
        <span className="gen-hint">{t('chat.generation.maxTokens.hint')}</span>
      </label>
      <label htmlFor={`${idPrefix}-stops`}>
        {t('chat.generation.stopSequences.label')}
        <textarea
          id={`${idPrefix}-stops`}
          rows={3}
          placeholder={t('chat.generation.stopSequences.placeholder')}
          value={draft.stopSequences}
          onChange={(e) => patch({ stopSequences: e.target.value })}
          onBlur={commit}
        />
        <span className="gen-hint">{t('chat.generation.stopSequences.hint')}</span>
      </label>
      <label htmlFor={`${idPrefix}-instr`}>
        {t('chat.generation.userInstructions.label')}
        <textarea
          id={`${idPrefix}-instr`}
          rows={5}
          placeholder={t('chat.generation.userInstructions.placeholder')}
          value={draft.userInstructions}
          onChange={(e) => patch({ userInstructions: e.target.value })}
          onBlur={commit}
        />
        <span className="gen-hint">
          {t('chat.generation.userInstructions.hint')}
        </span>
      </label>
    </div>
  );
}
