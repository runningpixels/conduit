import { useT } from '../i18n';

/** A quiet tag marking something Conduit added on first run. */
export function ExampleChip() {
  const t = useT();
  return <span className="example-chip">{t('common.examples.chip')}</span>;
}
