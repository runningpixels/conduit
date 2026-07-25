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

  return (
    <div className="suggested-prompts suggested-prompts-inline" aria-label="Suggested follow-ups">
      <span className="suggested-prompts-heading">Suggestions</span>
      <div className="suggested-prompt-chips">
        {prompts.map((prompt) => (
          <button
            key={prompt.id}
            type="button"
            className="suggested-prompt-chip"
            title={prompt.text}
            onClick={() => onSelect(prompt.text)}
          >
            <span className="suggested-prompt-chip-label">{prompt.label}</span>
            <span className="suggested-prompt-chip-text">{prompt.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
