/// Save an HTML artifact as an app, or edit a saved app's details: name, mark,
/// description, category. When saving, the page's remembered network grants
/// are offered — never copied without a tick — and hosts it declares but was
/// never allowed are listed as "asks the first time".
///
/// Rendered at the app shell, but it can open over the document panel, whose
/// own Escape closes the document: Escape is caught in the capture phase.

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useFocusTrap } from '../shell/useFocusTrap';
import { useT } from '../i18n';
import { declaredHosts } from '../artifacts/networkHosts';
import { useSiteLabel } from '../workspace/ArtifactNetwork';
import {
  artifactPrincipal,
  getArtifactNetworkState,
  saveApp,
  updateApp,
  type AppMetaInput,
} from '../ipc/client';
import type { AppCategory, AppSummary } from '../ipc/contracts';
import { APP_CATEGORIES, AppTile } from './AppTile';

export type AppDetailsTarget =
  | { mode: 'save'; artifactId: string; title: string | null; html: string }
  | { mode: 'edit'; app: AppSummary };

export const MAX_APP_NAME = 80;
export const MAX_APP_DESCRIPTION = 280;
export const MAX_APP_MARK = 5;

export function AppDetailsDialog({
  target,
  onClose,
  onSaved,
}: {
  target: AppDetailsTarget | null;
  onClose: () => void;
  onSaved: (app: AppSummary, mode: 'save' | 'edit') => void;
}) {
  const t = useT();
  const siteLabel = useSiteLabel();
  const titleId = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const open = target != null;
  useFocusTrap(dialogRef, open);

  const [name, setName] = useState('');
  const [mark, setMark] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<AppCategory>('tools');
  const [granted, setGranted] = useState<string[]>([]);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const declared = useMemo(
    () => (target?.mode === 'save' ? declaredHosts(target.html).map((d) => d.origin) : []),
    [target],
  );

  useEffect(() => {
    if (!target) return;
    setError(null);
    setBusy(false);
    setKeep(new Set());
    setGranted([]);
    if (target.mode === 'save') {
      setName(target.title?.trim().slice(0, MAX_APP_NAME) ?? '');
      setMark('');
      setDescription('');
      setCategory(declaredHosts(target.html).length > 0 ? 'live-data' : 'tools');
      let cancelled = false;
      getArtifactNetworkState(artifactPrincipal(target.artifactId))
        .then((state) => {
          if (!cancelled) setGranted(state.always);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
    setName(target.app.name);
    setMark(target.app.icon ?? '');
    setDescription(target.app.description ?? '');
    setCategory(target.app.category);
    return undefined;
  }, [target]);

  useEffect(() => {
    if (!open) return;
    nameRef.current?.focus();
    nameRef.current?.select();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  if (!target) return null;
  const asking = declared.filter((origin) => !granted.includes(origin));
  const trimmed = name.trim();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!target || !trimmed || busy) return;
    const meta: AppMetaInput = {
      name: trimmed,
      icon: mark.trim() || null,
      description: description.trim() || null,
      category,
    };
    setBusy(true);
    setError(null);
    try {
      const app =
        target.mode === 'save'
          ? await saveApp(target.artifactId, meta, declared, [...keep])
          : await updateApp(target.app.id, meta);
      onSaved(app, target.mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="consent-overlay app-details-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="app-details-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => void submit(e)}
      >
        <h2 id={titleId}>{target.mode === 'save' ? t('apps.details.saveTitle') : t('apps.details.editTitle')}</h2>
        {target.mode === 'save' && <p className="app-details-intro">{t('apps.details.saveIntro')}</p>}

        <div className="app-details-identity">
          <AppTile icon={mark} name={trimmed || '·'} category={category} size="lg" />
          <div className="app-details-fields">
            <label className="app-field">
              <span className="app-field-label">{t('apps.details.name')}</span>
              <input
                ref={nameRef}
                value={name}
                maxLength={MAX_APP_NAME}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="app-field app-field-mark">
              <span className="app-field-label">{t('apps.details.mark')}</span>
              <input
                value={mark}
                maxLength={MAX_APP_MARK}
                placeholder={t('apps.details.markPlaceholder')}
                onChange={(e) => setMark(e.target.value)}
              />
            </label>
          </div>
        </div>

        <label className="app-field">
          <span className="app-field-label">{t('apps.details.description')}</span>
          <input
            value={description}
            maxLength={MAX_APP_DESCRIPTION}
            placeholder={t('apps.details.descriptionPlaceholder')}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <label className="app-field">
          <span className="app-field-label">{t('apps.details.category')}</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as AppCategory)}>
            {APP_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`apps.category.${c}`)}
              </option>
            ))}
          </select>
        </label>

        {target.mode === 'save' && (granted.length > 0 || asking.length > 0) && (
          <fieldset className="app-details-access">
            <legend className="app-field-label">{t('apps.details.access')}</legend>
            {granted.map((origin) => (
              <label key={origin} className="app-details-keep">
                <input
                  type="checkbox"
                  checked={keep.has(origin)}
                  onChange={(e) =>
                    setKeep((current) => {
                      const next = new Set(current);
                      if (e.target.checked) next.add(origin);
                      else next.delete(origin);
                      return next;
                    })
                  }
                />
                <span>{t('apps.details.keepAccess', { host: siteLabel(origin) })}</span>
              </label>
            ))}
            {asking.map((origin) => (
              <p key={origin} className="app-details-asks">
                {t('apps.details.asksFirst', { host: siteLabel(origin) })}
              </p>
            ))}
          </fieldset>
        )}

        {error && (
          <p className="app-details-error" role="alert">
            {error}
          </p>
        )}

        <div className="app-details-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={!trimmed || busy}>
            {target.mode === 'save' ? t('apps.details.save') : t('apps.details.saveChanges')}
          </button>
        </div>
      </form>
    </div>
  );
}
