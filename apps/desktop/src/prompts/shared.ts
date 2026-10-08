/**
 * The static text of the deck and draft system prompts lives in the `.md` files
 * next to this one. The renderer reads them here (Vite's `?raw`) and the Rust
 * workflow runner reads the same files (`include_str!`), so a chat and a
 * scheduled workflow give the model the same words. The Rust twin of
 * `fillTemplate` is `prompts::fill_template`; `promptParity.test.ts` and the Rust
 * golden test both check one fixture, so the two cannot drift.
 */

/** A prompt file's text: Unix line ends, no trailing newline. */
export function promptText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

/**
 * Fill a template made of paragraphs (separated by a blank line). `{app}` in
 * any paragraph becomes `app`; a paragraph that is only `{name}` becomes
 * `sections[name]`, or disappears when that is null or missing.
 */
export function fillTemplate(template: string, app: string, sections: Record<string, string | null | undefined> = {}): string {
  const out: string[] = [];
  for (const paragraph of promptText(template).split('\n\n')) {
    const slot = /^\{([a-z_]+)\}$/.exec(paragraph);
    if (slot && slot[1] !== 'app') {
      const section = sections[slot[1]];
      if (section != null) out.push(section);
      continue;
    }
    out.push(paragraph.split('{app}').join(app));
  }
  return out.join('\n\n');
}
