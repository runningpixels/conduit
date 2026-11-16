import { useEffect, useState } from 'react';
import {
  deleteBrowserSignIn,
  listBrowserSignIns,
  saveBrowserSignIn,
  type BrowserSignIn,
} from '../../ipc/client';
import { translateError } from '../../ipc/errors';
import { useT } from '../../i18n';

interface Draft {
  site: string;
  username: string;
  password: string;
  includeSubdomains: boolean;
  unattended: boolean;
  /// The site being edited; its password may be left empty to keep it.
  editing: string | null;
}

const EMPTY: Draft = { site: '', username: '', password: '', includeSubdomains: false, unattended: false, editing: null };

/**
 * Settings → Computer → Saved sign-ins (Browser B3): sites the agent's browser
 * may sign in to with a username and password the app fills in itself. The
 * list shows sites and usernames only; a password can be replaced or deleted,
 * never shown.
 */
export function SavedSignIns() {
  const t = useT();
  const [list, setList] = useState<BrowserSignIn[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => listBrowserSignIns())
      .then(
        (got) => {
          if (!cancelled) setList(Array.isArray(got) ? got : []);
        },
        () => {
          if (!cancelled) setList([]);
        },
      );
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(next: Draft) {
    setBusy(true);
    setNote(null);
    try {
      const saved = await saveBrowserSignIn({
        site: next.site,
        username: next.username,
        password: next.password,
        includeSubdomains: next.includeSubdomains,
        unattended: next.unattended,
      });
      setList((old) =>
        [...(old ?? []).filter((s) => s.site !== saved.site && s.site !== next.editing), saved].sort((a, b) =>
          a.site.localeCompare(b.site),
        ),
      );
      if (next.editing && next.editing !== saved.site) await deleteBrowserSignIn(next.editing);
      setDraft(null);
      setNote({ text: t('settings.computer.signIns.saved'), failed: false });
    } catch (e) {
      setNote({ text: translateError(e, t), failed: true });
    } finally {
      setBusy(false);
    }
  }

  async function remove(site: string) {
    setBusy(true);
    setNote(null);
    try {
      await deleteBrowserSignIn(site);
      setList((old) => (old ?? []).filter((s) => s.site !== site));
      if (draft?.editing === site) setDraft(null);
    } catch (e) {
      setNote({ text: translateError(e, t), failed: true });
    } finally {
      setBusy(false);
    }
  }

  const canSave =
    draft !== null && draft.site.trim() !== '' && draft.username.trim() !== '' && (draft.editing !== null || draft.password !== '');

  return (
    <div className="settings-sign-ins" style={{ margin: '0 0 12px' }}>
      <div className="srow">
        <span className="srow-text">
          <b>{t('settings.computer.signIns.label')}</b>
          <small>{t('settings.computer.signIns.help')}</small>
        </span>
        {draft === null ? (
          <button type="button" className="btn ghost" disabled={busy} onClick={() => setDraft(EMPTY)}>
            {t('settings.computer.signIns.add')}
          </button>
        ) : null}
      </div>
      {list && list.length === 0 && draft === null ? (
        <p className="wf-muted" style={{ margin: '0 0 8px' }}>
          {t('settings.computer.signIns.none')}
        </p>
      ) : null}
      {list && list.length > 0 ? (
        <ul className="settings-sign-in-list" style={{ listStyle: 'none', margin: '0 0 8px', padding: 0 }}>
          {list.map((s) => (
            <li key={s.site} className="srow">
              <span className="srow-text">
                <b>{s.site}</b>
                <small>
                  {s.username}
                  {s.unattended ? ` · ${t('settings.computer.signIns.unattendedTag')}` : ''}
                </small>
              </span>
              <span style={{ display: 'flex', gap: 'var(--sp-1)' }}>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  aria-label={t('settings.computer.signIns.editLabel', { site: s.site })}
                  onClick={() => setDraft({ ...s, password: '', editing: s.site })}
                >
                  {t('common.actions.edit')}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  aria-label={t('settings.computer.signIns.deleteLabel', { site: s.site })}
                  onClick={() => void remove(s.site)}
                >
                  {t('common.actions.delete')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {draft ? (
        <form
          className="form-grid settings-sign-in-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) void save(draft);
          }}
        >
          <label className="field">
            <span className="field-label">{t('settings.computer.signIns.site')}</span>
            <input
              value={draft.site}
              onChange={(e) => setDraft({ ...draft, site: e.target.value })}
              // i18n-exempt: an example host name, the same in every language
              placeholder="example.com"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('settings.computer.signIns.username')}</span>
            <input
              value={draft.username}
              onChange={(e) => setDraft({ ...draft, username: e.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('settings.computer.signIns.password')}</span>
            <input
              type="password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              placeholder={draft.editing ? t('settings.computer.signIns.passwordKeep') : undefined}
              autoComplete="new-password"
            />
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={draft.includeSubdomains}
              onChange={(e) => setDraft({ ...draft, includeSubdomains: e.target.checked })}
            />
            <span>{t('settings.computer.signIns.subdomains')}</span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={draft.unattended}
              onChange={(e) => setDraft({ ...draft, unattended: e.target.checked })}
            />
            <span>{t('settings.computer.signIns.unattended')}</span>
          </label>
          <span style={{ display: 'flex', gap: 'var(--sp-2)' }}>
            <button type="submit" className="btn primary" disabled={busy || !canSave}>
              {t('common.actions.save')}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setDraft(null)}>
              {t('common.actions.cancel')}
            </button>
          </span>
        </form>
      ) : null}
      {note ? (
        <p role="status" className={note.failed ? 'wf-error' : 'wf-muted'} style={{ margin: '0 0 8px' }}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}
