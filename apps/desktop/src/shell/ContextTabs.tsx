/// Context's tabs: Documents, Library, Connectors and Memory are one rail
/// item, Context, and these tabs switch between them. Each tab is still its
/// own destination, so its page renders below exactly as before.
///
/// Navigation, not an ARIA tablist: each tab goes somewhere (the page under it
/// is a destination with its own deep links), so the current one is marked
/// with `aria-current="page"` and Tab moves between them.

import { useT } from '../i18n';
import { CONTEXT_TABS, type ContextTab, type Destination } from './Rail';

export function ContextTabs({ current, onNavigate }: { current: ContextTab; onNavigate: (d: Destination) => void }) {
  const t = useT();
  return (
    <nav className="context-tabs" aria-label={t('shell.context.ariaLabel')}>
      <span className="context-tabs-label" aria-hidden="true">
        {t('shell.rail.context')}
      </span>
      {CONTEXT_TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          className="context-tab"
          data-tab={tab}
          aria-current={tab === current ? 'page' : undefined}
          onClick={() => onNavigate(tab)}
        >
          {t(`shell.rail.${tab}`)}
        </button>
      ))}
    </nav>
  );
}
