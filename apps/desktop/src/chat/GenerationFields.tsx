import type { GenerationControls } from '@conduit/config-schema';
import { useRef } from 'react';

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

export function parseGenerationDraft(draft: GenerationFieldDraft): {
  controls: GenerationControls | null;
  userInstructions: string | null;
  error?: string;
} {
  const controls: GenerationControls = {};
  const tempRaw = draft.temperature.trim();
  if (tempRaw) {
    const temperature = Number.parseFloat(tempRaw);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      return { controls: null, userInstructions: null, error: 'Temperature must be between 0 and 2.' };
    }
    controls.temperature = temperature;
  }
  const topRaw = draft.topP.trim();
  if (topRaw) {
    const topP = Number.parseFloat(topRaw);
    if (!Number.isFinite(topP) || topP < 0 || topP > 1) {
      return { controls: null, userInstructions: null, error: 'Top P must be between 0 and 1.' };
    }
    controls.topP = topP;
  }
  const maxRaw = draft.maxTokens.trim();
  if (maxRaw) {
    const maxTokens = Number.parseInt(maxRaw, 10);
    if (!Number.isFinite(maxTokens) || maxTokens < 1) {
      return { controls: null, userInstructions: null, error: 'Max tokens must be greater than 0.' };
    }
    controls.maxTokens = maxTokens;
  }
  const stopSequences = draft.stopSequences
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (stopSequences.length > 8) {
    return { controls: null, userInstructions: null, error: 'At most 8 stop sequences.' };
  }
  if (stopSequences.some((s) => s.length > 64)) {
    return { controls: null, userInstructions: null, error: 'Stop sequences cannot exceed 64 characters.' };
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
        Temperature
        <input
          id={`${idPrefix}-temp`}
          type="number"
          min={0}
          max={2}
          step={0.1}
          placeholder="Provider default"
          value={draft.temperature}
          onChange={(e) => patch({ temperature: e.target.value })}
          onBlur={commit}
        />
        <span className="gen-hint">0–2. Empty uses the provider default.</span>
      </label>
      <label htmlFor={`${idPrefix}-topp`}>
        Top P
        <input
          id={`${idPrefix}-topp`}
          type="number"
          min={0}
          max={1}
          step={0.05}
          placeholder="Provider default"
          value={draft.topP}
          onChange={(e) => patch({ topP: e.target.value })}
          onBlur={commit}
        />
        <span className="gen-hint">0–1. Empty uses the provider default.</span>
      </label>
      <label htmlFor={`${idPrefix}-max`}>
        Max tokens
        <input
          id={`${idPrefix}-max`}
          type="number"
          min={1}
          step={1}
          placeholder="Provider default"
          value={draft.maxTokens}
          onChange={(e) => patch({ maxTokens: e.target.value })}
          onBlur={commit}
        />
        <span className="gen-hint">Empty uses the provider default.</span>
      </label>
      <label htmlFor={`${idPrefix}-stops`}>
        Stop sequences
        <textarea
          id={`${idPrefix}-stops`}
          rows={3}
          placeholder="One per line"
          value={draft.stopSequences}
          onChange={(e) => patch({ stopSequences: e.target.value })}
          onBlur={commit}
        />
        <span className="gen-hint">Up to 8 sequences. Generation stops if the model emits one.</span>
      </label>
      <label htmlFor={`${idPrefix}-instr`}>
        User instructions
        <textarea
          id={`${idPrefix}-instr`}
          rows={5}
          placeholder="Appended to the system prompt. Cannot replace built-in safety or tool rules."
          value={draft.userInstructions}
          onChange={(e) => patch({ userInstructions: e.target.value })}
          onBlur={commit}
        />
        <span className="gen-hint">
          Added under a reserved “User instructions” heading after Conduit’s auto-composed prompt.
        </span>
      </label>
    </div>
  );
}
