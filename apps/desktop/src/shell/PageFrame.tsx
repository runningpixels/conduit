/// The frame every rail destination shares (docs/plans/ui-revamp.md, "Pages"):
/// a header — title, one line of what the page is for, the page's main
/// action on the right — then either full-width content, or a list beside
/// the selected item's detail.
///
/// Pages used to be the old modal sheets hosted in the main area, each with
/// its own width cap and alignment, and paragraphs of explanation above the
/// first action. The frame fixes both: one width rule, and the explanation
/// behind "How this works".

import { useId, useState, type ReactNode } from 'react';
import { useT } from '../i18n';

export interface PageFrameProps {
  title: string;
  /** One line under the title. */
  subtitle?: ReactNode;
  /** The page's main action(s), right-aligned in the header. */
  actions?: ReactNode;
  /** Longer explanation, folded behind "How this works". */
  about?: ReactNode;
  /** With a list, the page is list-and-detail: the list on the left. */
  list?: ReactNode;
  /** Accessible name for the list pane. */
  listLabel?: string;
  /** Controls above the list (search, filter). */
  listHeader?: ReactNode;
  /** The detail (with a list) or the whole content (without). */
  children: ReactNode;
  /** Extra class on the root, for page-specific rules. */
  className?: string;
}

export function PageFrame({
  title,
  subtitle,
  actions,
  about,
  list,
  listLabel,
  listHeader,
  children,
  className,
}: PageFrameProps) {
  const t = useT();
  const headingId = useId();
  const aboutId = useId();
  const [aboutOpen, setAboutOpen] = useState(false);
  return (
    <section className={`page${list ? ' page-split' : ''}${className ? ` ${className}` : ''}`} aria-labelledby={headingId}>
      <header className="page-head">
        <div className="page-head-text">
          <h2 id={headingId} className="page-title">
            {title}
          </h2>
          {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
        </div>
        <div className="page-head-actions">
          {about ? (
            <button
              type="button"
              className="btn ghost page-about-toggle"
              aria-expanded={aboutOpen}
              aria-controls={aboutId}
              onClick={() => setAboutOpen((open) => !open)}
            >
              {t('shell.page.about')}
            </button>
          ) : null}
          {actions}
        </div>
      </header>
      {about && aboutOpen ? (
        <div id={aboutId} className="page-about">
          {about}
        </div>
      ) : null}
      {list ? (
        <div className="page-body">
          <nav className="page-list scroll" aria-label={listLabel ?? title}>
            {listHeader ? <div className="page-list-head">{listHeader}</div> : null}
            {list}
          </nav>
          <div className="page-detail scroll">{children}</div>
        </div>
      ) : (
        <div className="page-body page-body-single scroll">
          <div className="page-content">{children}</div>
        </div>
      )}
    </section>
  );
}

/** A consistent empty state: one sentence and, when there is one, the action. */
export function PageEmpty({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="page-empty">
      <p className="page-empty-title">{title}</p>
      {body ? <p className="page-empty-body">{body}</p> : null}
      {action ? <div className="page-empty-action">{action}</div> : null}
    </div>
  );
}

/** A row in a page's list pane. */
export function PageListItem({
  selected,
  onSelect,
  title,
  meta,
  status,
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
}) {
  return (
    <button type="button" className="page-list-item" aria-current={selected ? 'true' : undefined} onClick={onSelect}>
      {/* The title wraps; the meta line may be cut off, so it carries a tooltip. */}
      <span className="page-list-item-title">{title}</span>
      {status != null && status !== false ? <span className="page-list-item-status">{status}</span> : null}
      {meta ? (
        <span className="page-list-item-meta" title={typeof meta === 'string' ? meta : undefined}>
          {meta}
        </span>
      ) : null}
    </button>
  );
}
