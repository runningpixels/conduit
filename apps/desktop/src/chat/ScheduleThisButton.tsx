/// "Schedule this…" in a reply's actions, for a reply one of the user's agents gave: it opens the
/// routine form with that agent and the message it answered.

import { useT } from '../i18n';

export function ScheduleThisButton({ name, onClick }: { name: string; onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" className="act" title={t('chat.view.scheduleThisTitle', { name })} onClick={onClick}>
      {t('chat.view.scheduleThis')}
    </button>
  );
}
