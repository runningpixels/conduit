/** A single suggested prompt shown in the chat empty / follow-up states. */
export interface SuggestedPrompt {
  id: string;
  label: string;
  text: string;
}

/** Starter prompts for empty chat / first open. */
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
