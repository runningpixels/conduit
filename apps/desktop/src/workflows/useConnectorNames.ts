/// Connector names by id, for a workflow's step list ("Use list_issues in GitHub").
/// Looked up only when the steps use a connector; until then (or if the lookup
/// fails) the line shows the connector's id.

import { useEffect, useState } from 'react';
import type { WorkflowStep } from '../ipc/contracts';
import { loadConnectorChoices } from './connectorTools';

export function usesConnector(steps: readonly WorkflowStep[]): boolean {
  return steps.some((s) => s.type === 'connector_tool' || (s.type === 'for_each' && usesConnector(s.steps)));
}

export function useConnectorNames(steps: readonly WorkflowStep[], skip = false): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  const needed = !skip && usesConnector(steps);
  useEffect(() => {
    if (!needed) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => loadConnectorChoices())
      .then((choices) => {
        if (!cancelled) setNames(Object.fromEntries(choices.map((c) => [c.connectorId, c.name])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [needed]);
  return names;
}
