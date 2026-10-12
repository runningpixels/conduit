/// A rail destination that is planned but not built yet (Inbox, Agents): the
/// page says what it will be, and points to where that work lives today.

import { useT } from '../i18n';
import { PageEmpty, PageFrame } from '../shell/PageFrame';

export interface ComingSoonPageProps {
  /** Catalog prefix: `<prefix>.title`, `.subtitle`, `.body` and `.action`. */
  copy: 'shell.inbox' | 'shell.agents';
  onAction: () => void;
}

export function ComingSoonPage({ copy, onAction }: ComingSoonPageProps) {
  const t = useT();
  return (
    <PageFrame title={t(`${copy}.title`)} subtitle={t(`${copy}.subtitle`)} className="coming-soon-page">
      <PageEmpty
        title={t('shell.page.comingSoon')}
        body={t(`${copy}.body`)}
        action={
          <button type="button" className="btn" onClick={onAction}>
            {t(`${copy}.action`)}
          </button>
        }
      />
    </PageFrame>
  );
}
