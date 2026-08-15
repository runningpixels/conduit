/** Developer prompt for web-search turns: concise answers, provider citations only. */
export function webSearchDeveloperPromptFor(): string {
  return [
    'Web search is enabled for this turn. Use the hosted web_search tool for current or live information.',
    'Structure your reply: lead with a direct answer in 1–2 sentences, then add brief supporting bullets only if needed.',
    'Rely on the provider inline citations for attribution. Do not add a separate Sources section or paste duplicate raw URLs.',
    'Do not use fenced code blocks unless the user explicitly asked for code or a document artifact.',
  ].join(' ');
}

/**
 * Extra restraint when the turn is both a document-creation request and a
 * web-search turn. Without this, models binge-search and spawn many write_*
 * calls until max_steps kills the turn.
 */
export function webSearchCreateDeveloperPromptFor(): string {
  return [
    'The user asked for a document artifact with live information.',
    'Search sparingly to gather the brief, then call write_*_document once with the full content embedded.',
    'If you need to fix the document, use edit_*_document with the returned artifact_id — do not create another document.',
    'When the document is done, stop: a short confirmation and no further tool calls.',
  ].join(' ');
}
