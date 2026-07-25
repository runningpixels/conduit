/** A single suggested prompt shown in chat or the welcome artifact. */
export interface SuggestedPrompt {
  id: string;
  label: string;
  text: string;
}

/** Starter prompts for empty chat / first open — shared with the welcome artifact. */
export const STARTER_SUGGESTED_PROMPTS: readonly SuggestedPrompt[] = [
  {
    id: 'starter-markdown',
    label: 'Markdown',
    text: 'Draft a triage note summarizing our open GitHub issues.',
  },
  {
    id: 'starter-html',
    label: 'HTML',
    text: 'Create a one-page HTML overview of our API for new developers.',
  },
  {
    id: 'starter-json',
    label: 'JSON',
    text: 'Write a JSON schema for a customer profile with address fields.',
  },
  {
    id: 'starter-code',
    label: 'Code',
    text: 'Generate a Python script that parses log files and groups errors.',
  },
] as const;

function escapeHtmlAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Build the prompt-card HTML fragment for the welcome artifact from shared data. */
export function buildWelcomePromptCardsHtml(prompts: readonly SuggestedPrompt[]): string {
  return prompts
    .map(
      (p) => `    <div class="prompt-card">
      <span class="prompt-label">${escapeHtmlAttr(p.label)}</span>
      <p class="prompt-text">"${escapeHtmlAttr(p.text)}"</p>
    </div>`,
    )
    .join('\n');
}
