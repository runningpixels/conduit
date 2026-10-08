/// A send the backend refused because a workflow holds the conversation's turn
/// ("The workflow “Weekly numbers” is updating this right now. Try again when
/// it has finished."). The refusal comes before anything is stored, so the
/// message never became part of the chat: the thread drops its bubble and the
/// composer gets the text back.

export function isWorkflowBusyRefusal(message: string): boolean {
  return /^The workflow\b[\s\S]*\bis updating this right now\b/.test(message.trim());
}
