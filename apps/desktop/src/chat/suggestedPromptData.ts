/** A single suggested follow-up shown above the composer in an active thread. */
export interface SuggestedPrompt {
  id: string;
  /**
   * The prompt actually sent when the suggestion is picked. Written as a full
   * instruction, so it is far too long to render inside a follow-up chip.
   */
  text: string;
  /** Chip caption: a few words that fit on one line. */
  short: string;
}
