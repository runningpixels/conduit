/** A single suggested prompt shown in the chat empty / follow-up states. */
export interface SuggestedPrompt {
  id: string;
  label: string;
  /**
   * The prompt actually sent when the suggestion is picked. Written as a full
   * instruction, so it is far too long to render inside a follow-up chip.
   */
  text: string;
  /**
   * Chip caption for the inline (follow-up) variant: a few words that fit on
   * one line. The empty-state cards have room for `text` and use it directly.
   */
  short: string;
}

/** Starter prompts for empty chat / first open. */
export const STARTER_SUGGESTED_PROMPTS: readonly SuggestedPrompt[] = [
  {
    id: 'starter-markdown',
    label: 'Markdown',
    text: 'Draft a triage note summarizing our open GitHub issues.',
    short: 'Draft a triage note',
  },
  {
    id: 'starter-html',
    label: 'HTML',
    text: 'Create a one-page HTML overview of our API for new developers.',
    short: 'One-page API overview',
  },
  {
    id: 'starter-json',
    label: 'JSON',
    text: 'Write a JSON schema for a customer profile with address fields.',
    short: 'Write a JSON schema',
  },
  {
    id: 'starter-code',
    label: 'Code',
    text: 'Generate a Python script that parses log files and groups errors.',
    short: 'Parse and group log errors',
  },
] as const;
