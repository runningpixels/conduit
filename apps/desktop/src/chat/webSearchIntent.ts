/** Heuristic: does the user's message ask for live / internet information?
 *  Used to auto-opt-in to web search when globally enabled but the per-turn
 *  ⌕ toggle was left off — a common miss because the toggle defaults off. */
export function userWantsWebSearch(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  return /\b(search the (internet|web)|search online|look up online|search for|latest .{0,40}(news|market|headlines)|current .{0,40}(news|events|market)|this week'?s .{0,40}(news|market)|today'?s .{0,40}(news|market)|on the internet|from the web)\b/i.test(
    text,
  );
}

/** Whether web search should be active for this send. */
export function resolveWebSearchForTurn(
  settings: { webSearchEnabled: boolean; localOnly: boolean },
  webSearchOn: boolean,
  prompt: string,
): boolean {
  if (settings.localOnly || !settings.webSearchEnabled) return false;
  return webSearchOn || userWantsWebSearch(prompt);
}
