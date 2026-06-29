/** Developer prompt for web-search turns: concise answers, provider citations only. */
export function webSearchDeveloperPromptFor(): string {
  return [
    'Web search is enabled for this turn. Use the hosted web_search tool for current or live information.',
    'Structure your reply: lead with a direct answer in 1–2 sentences, then add brief supporting bullets only if needed.',
    'Rely on the provider inline citations for attribution. Do not add a separate Sources section or paste duplicate raw URLs.',
    'Do not use fenced code blocks unless the user explicitly asked for code or a document artifact.',
  ].join(' ');
}
