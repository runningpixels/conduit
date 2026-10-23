/// "Helpers" total: tokens and cost of a set of agent nodes, one line per model.

import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { useNodeCosts, type NodeUsage } from './helperCost';
import { ProviderBadge, splitModel } from './ProviderBadge';

export function HelperTotals({ nodes, title }: { nodes: NodeUsage[]; title: string }) {
  const t = useT();
  const fmt = useFormatters();
  const { totals } = useNodeCosts(nodes);
  if (nodes.length === 0) return null;
  const all = totals();
  if (all.tokens <= 0) return null;
  return (
    <section className="helper-totals" aria-label={title}>
      <p className="helper-totals-title">{title}</p>
      <ul className="helper-totals-list">
        {all.byModel.map((g) => (
          <li key={g.model || '-'} className="helper-totals-line">
            <span className="helper-totals-model">
              <ProviderBadge model={g.model} />
              <span>{splitModel(g.model).modelId || t('chat.handoff.totals.unknownModel')}</span>
            </span>
            <span className="helper-totals-nums">
              {[
                t('chat.handoff.tokens', { count: fmt.count(g.tokens) }),
                g.cents !== null ? fmt.money(g.cents) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </li>
        ))}
        {all.byModel.length > 1 ? (
          <li className="helper-totals-line helper-totals-sum">
            <span>{t('chat.handoff.totals.total')}</span>
            <span className="helper-totals-nums">
              {[
                t('chat.handoff.tokens', { count: fmt.count(all.tokens) }),
                all.cents !== null ? fmt.money(all.cents) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
