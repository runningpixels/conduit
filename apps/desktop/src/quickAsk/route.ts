/** Whether this window is the quick-ask box (Rust opens it at `index.html?ask=1`). */
export function isQuickAskRoute(search: string): boolean {
  return new URLSearchParams(search).get('ask') === '1';
}
