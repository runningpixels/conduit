import type { SuggestedPrompt } from './suggestedPromptData';

export interface SuggestedPromptsProps {
  prompts: readonly SuggestedPrompt[];
  onSelect: (text: string) => void;
}

/**
 * Follow-up suggestions, shown directly above the composer once a thread has
 * turns in it. One line each: the short caption reads in full, and `text` — the
 * prompt that is actually sent — stays available as the tooltip. The group is
 * labelled, so the row needs no visible heading of its own.
 *
 * There is no empty-state variant. The empty thread is a greeting and the
 * composer (§10); the card grid that used to live there was removed with it.
 */
export function SuggestedPrompts({ prompts, onSelect }: SuggestedPromptsProps) {
  if (prompts.length === 0) return null;

  return (
    <div
      className="suggested-prompts suggested-prompts-inline"
      role="group"
      aria-label="Suggested follow-ups"
    >
      {prompts.map((prompt) => (
        <button
          key={prompt.id}
          type="button"
          className="suggested-prompt-chip"
          title={prompt.text}
          onClick={() => onSelect(prompt.text)}
        >
          {prompt.short}
        </button>
      ))}
    </div>
  );
}
