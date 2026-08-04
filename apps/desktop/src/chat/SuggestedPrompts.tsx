import type { SuggestedPrompt } from './suggestedPromptData';

export type SuggestedPromptsVariant = 'empty' | 'inline';

export interface SuggestedPromptsProps {
  prompts: readonly SuggestedPrompt[];
  variant: SuggestedPromptsVariant;
  onSelect: (text: string) => void;
}

export function SuggestedPrompts({ prompts, variant, onSelect }: SuggestedPromptsProps) {
  if (prompts.length === 0) return null;

  if (variant === 'empty') {
    return (
      <div className="suggested-prompts suggested-prompts-empty" aria-label="Suggested prompts">
        {prompts.map((prompt) => (
          <button
            key={prompt.id}
            type="button"
            className="suggested-prompt-card"
            onClick={() => onSelect(prompt.text)}
          >
            <span className="suggested-prompt-label">{prompt.label}</span>
            <span className="suggested-prompt-text">{prompt.text}</span>
          </button>
        ))}
      </div>
    );
  }

  // Inline follow-ups sit directly above the composer, so they get one line
  // each: the short caption reads in full, and `text` — the prompt that is
  // actually sent — stays available as the tooltip. The group is labelled, so
  // the row needs no visible heading of its own.
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
