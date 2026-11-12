/// The sites a workflow's agents may click and type on without asking first
/// (`ActionRules.browserSites`), one host per line; `*.example.com` covers a
/// site and its subdomains. Any other site asks before the first action on it.
/// Form submits on unlisted sites, login forms and anything that spends money
/// or changes an account still ask. Rendered by ActionRulesSection.

import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n';

/// One DNS label: letters, digits and inner hyphens.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/// A site list entry: a plain host (`example.com`) or `*.` and a host of at least two labels
/// (`*.example.com`). No scheme, port, path or other wildcards.
export function isSitePattern(entry: string): boolean {
  const s = entry.trim().toLowerCase();
  if (s.length === 0 || s.length > 253) return false;
  if (s.startsWith('*.')) {
    const rest = s.slice(2);
    return HOST.test(rest) && rest.includes('.');
  }
  return HOST.test(s);
}

/// The box's lines as a site list: trimmed, lower-cased, blank lines and repeats dropped, with
/// the lines that aren't sites kept apart (as typed) so they can be pointed out.
export function parseSiteList(text: string): { sites: string[]; invalid: string[] } {
  const sites: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!isSitePattern(line)) invalid.push(line);
    else if (!sites.includes(line.toLowerCase())) sites.push(line.toLowerCase());
  }
  return { sites, invalid };
}

export function BrowserSitesEditor({
  sites,
  busy,
  onSave,
}: {
  sites: readonly string[];
  busy: boolean;
  /// Saves the whole list; resolves `true` when the backend took it.
  onSave: (next: string[]) => Promise<boolean>;
}) {
  const t = useT();
  const errorId = useId();
  const saved = sites.join('\n');
  const [draft, setDraft] = useState(saved);
  // A site added from an approval card ("Always on …") shows up here.
  useEffect(() => setDraft(saved), [saved]);
  const { sites: parsed, invalid } = parseSiteList(draft);
  const changed = parsed.join('\n') !== saved;

  const save = () => {
    if (invalid.length > 0 || !changed) return;
    void onSave(parsed);
  };

  return (
    <section className="grp wf-perm-group wf-browser-sites" aria-label={t('workspace.workflows.perm.browser.title')}>
      <div className="grp-label">{t('workspace.workflows.perm.browser.title')}</div>
      <p className="wf-muted">{t('workspace.workflows.perm.browser.intro')}</p>
      <label className="wf-field">
        <span>{t('workspace.workflows.perm.browser.label')}</span>
        <textarea
          className="mem-input"
          rows={Math.min(10, Math.max(3, draft.split('\n').length + 1))}
          spellCheck={false}
          // i18n-exempt: example host names, the same in every language
          placeholder={'example.com\n*.example.org'}
          value={draft}
          disabled={busy}
          aria-invalid={invalid.length > 0 ? true : undefined}
          aria-describedby={invalid.length > 0 ? errorId : undefined}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      {invalid.length > 0 ? (
        <p id={errorId} className="wf-error" role="alert">
          {t('workspace.workflows.perm.browser.invalid', { sites: invalid.map((s) => `“${s}”`).join(', ') })}
        </p>
      ) : null}
      <div className="wf-offer-actions">
        <button type="button" className="btn" disabled={busy || !changed || invalid.length > 0} onClick={save}>
          {t('workspace.workflows.perm.browser.save')}
        </button>
      </div>
    </section>
  );
}
