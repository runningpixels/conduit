import { appName } from '../brand';
import { localSearchBackendLabel, localSearchBackendOf } from './webSearchIntent';
import type { LocalSearchBackend } from '@conduit/config-schema';

/** `web_fetch` calls one turn may make. Mirrors Rust's
 *  `MAX_WEB_FETCH_PER_TURN` (stream_manager.rs). */
export const WEB_FETCH_MAX_PER_TURN = 12;

/**
 * Developer prompt for a turn that may read pages (`web_fetch`) but does not
 * search. Without it a model told nothing about the web answers "I can't
 * browse" when the user names a site.
 */
export function webFetchDeveloperPromptFor(options: { creating?: boolean } = {}): string {
  return [
    'You can read public web pages with web_fetch.',
    "When the user names a site or gives a URL, open it with web_fetch instead of saying you can't browse;",
    `use the returned links to open the specific pages you need (up to ${WEB_FETCH_MAX_PER_TURN} per turn), and cite the URLs you read.`,
    ...(options.creating
      ? ['Read what you need first, then write the document once with the content and links in it.']
      : []),
  ].join(' ');
}

/** Developer prompt for hosted (provider) web-search turns. */
export function webSearchDeveloperPromptFor(): string {
  return [
    'Web search is enabled for this turn. Use the hosted web_search tool for current or live information, and web_fetch to read the full text of a specific URL (or a site the user named) when a snippet is not enough.',
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
    'Search sparingly to gather the brief (open a site or URL the user named with web_fetch), then call write_*_document once with the full content embedded.',
    'If you need to fix the document, use edit_*_document with the returned artifact_id — do not create another document.',
    'When the document is done, stop: a short confirmation and no further tool calls.',
  ].join(' ');
}

/** Developer prompt when the local builtin (not provider-hosted) is active. */
export function localWebSearchDeveloperPromptFor(
  backend?: LocalSearchBackend,
): string {
  const label = localSearchBackendLabel(backend);
  const ddg = localSearchBackendOf(backend) === 'duckduckgo';
  const backendHint = ddg
    ? `${label} Instant Answer — encyclopedic snippets, not a live news crawl`
    : localSearchBackendOf(backend) === 'exa'
      ? `${label} — live web results; write the query as a short description of the page you want, not bare keywords`
      : `${label} — live web results`;
  const emptyHint = ddg
    ? 'If results are empty or the payload includes a note about Instant Answer, stop searching: answer from what you know or tell the user local search cannot find live headlines.'
    : 'If results are empty or the payload includes a note, stop searching: answer from what you know or tell the user search found nothing.';
  return [
    `Web search is enabled via ${appName()}'s local web_search tool (${backendHint}).`,
    'Call web_search at most once or twice with a clear query. Use web_fetch to read the full text of a URL from those results, or a site or URL the user named.',
    `${emptyHint} Do not retry similar query variants — that burns the agent step budget.`,
    'Results come back as JSON (titles, snippets, URLs) — cite them in your answer; there are no provider inline citations.',
    'Structure your reply: lead with a direct answer in 1–2 sentences, then brief supporting bullets if needed.',
    'Do not use fenced code blocks unless the user explicitly asked for code or a document artifact.',
  ].join(' ');
}
