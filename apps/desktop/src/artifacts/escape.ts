/// Shared HTML-escaper for the artifact renderers. Escapes the five
/// significant characters so any text inserted into HTML text content or an
/// attribute value is rendered literally (never parsed as markup).
///
/// This is the single source of truth for the renderer path. The chat surface
/// (ContentBlock/ChatView/DocumentPanel) keeps its own copies for now; M6
/// consolidates them onto this one as the renderers land.
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}