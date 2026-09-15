/**
 * Documents built in parts.
 *
 * A long document can be written as a skeleton with placeholder comments —
 * `<!-- section: moons -->` — that the model then fills in one or two at a
 * time with `patch_document`. The placeholders say how much of the build is
 * left, and, being comments, render as nothing: a half-built page looks
 * finished-but-short. These helpers find them and make them visible in the
 * preview (never in the saved document).
 */

/** `<!-- section: name -->`, any case, any spacing. */
const PLACEHOLDER = /<!--\s*section\s*:\s*([^>]*?)\s*-->/gi;

/** Names of the sections still waiting to be written, in document order. */
export function placeholderSections(content: string | undefined): string[] {
  if (!content) return [];
  return [...content.matchAll(PLACEHOLDER)].map((match) => match[1].trim()).filter(Boolean);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * Preview HTML with each placeholder shown as a quiet dashed block.
 * `label` gets the section name and returns display text; it is escaped here.
 * Inline styles only — the preview frame's CSP already allows inline styles
 * (the reset stylesheet is inline), and no script or resource is added.
 */
export function markPlaceholdersInHtml(html: string, label: (name: string) => string): string {
  return html.replace(PLACEHOLDER, (_match, name: string) => {
    const text = escapeHtml(label(name.trim()));
    return (
      `<div data-conduit-pending-section style="margin:1.25em 0;padding:.9em 1.1em;` +
      `border:1px dashed currentColor;border-radius:6px;opacity:.5;` +
      `font:italic .95em/1.4 system-ui,sans-serif">${text}</div>`
    );
  });
}

/** Markdown with each placeholder shown as an emphasised line of its own. */
export function markPlaceholdersInMarkdown(markdown: string, label: (name: string) => string): string {
  return markdown.replace(PLACEHOLDER, (_match, name: string) => {
    // Markdown punctuation in a section name must not turn into formatting;
    // the safe renderer has no escapes, so drop it.
    const text = label(name.trim()).replace(/[\\`*_[\]#<>]/g, '');
    return `\n\n*${text}*\n\n`;
  });
}
