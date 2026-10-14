/// The "Connector tools" part of an agent step's tool list: the tools of the
/// installed connectors, stored as "<connectorId>/<tool>" beside the built-in
/// tools. A tool that changes things stops to ask the user before it acts, a
/// sensitive one always asks. At most `MAX_AGENT_CONNECTOR_TOOLS` per step.

import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import {
  loadConnectorChoices,
  loadConnectorTools,
  toolLabel,
  type ConnectorChoice,
  type ConnectorToolInfo,
} from './connectorTools';
import { connectorToolRef, MAX_AGENT_CONNECTOR_TOOLS, parseConnectorToolRef } from './editorModel';

type Loaded<T> = { state: 'loading' } | { state: 'error' } | { state: 'ready'; value: T };

export function AgentConnectorTools({
  tools,
  onToggle,
}: {
  /// The step's whole `tools` list (built-ins and connector entries).
  tools: readonly string[];
  /// Add (`on`) or remove one `<connectorId>/<tool>` entry.
  onToggle: (ref: string, on: boolean) => void;
}) {
  const t = useT();
  const [choices, setChoices] = useState<Loaded<ConnectorChoice[]>>({ state: 'loading' });
  const [toolsOf, setToolsOf] = useState<Record<string, Loaded<ConnectorToolInfo[]>>>({});

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => loadConnectorChoices())
      .then((value) => {
        if (cancelled) return;
        setChoices({ state: 'ready', value });
        for (const c of value) {
          Promise.resolve()
            .then(() => loadConnectorTools(c.connectorId))
            .then((list) => {
              if (!cancelled) setToolsOf((prev) => ({ ...prev, [c.connectorId]: { state: 'ready', value: list } }));
            })
            .catch(() => {
              if (!cancelled) setToolsOf((prev) => ({ ...prev, [c.connectorId]: { state: 'error' } }));
            });
        }
      })
      .catch(() => {
        if (!cancelled) setChoices({ state: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const chosen = tools.filter((x) => parseConnectorToolRef(x) !== null);
  const full = chosen.length >= MAX_AGENT_CONNECTOR_TOOLS;
  const installed = choices.state === 'ready' ? choices.value : [];
  // Entries whose connector is gone, or no longer offers the tool: shown so they can be removed.
  const missing = choices.state !== 'ready' ? [] : chosen.filter((ref) => {
    const parsed = parseConnectorToolRef(ref);
    if (!parsed) return false;
    const connector = installed.find((c) => c.connectorId === parsed.connectorId);
    if (!connector) return true;
    const loaded = toolsOf[connector.connectorId];
    return loaded?.state === 'ready' && !loaded.value.some((x) => x.name === parsed.tool);
  });

  if (choices.state === 'ready' && installed.length === 0 && chosen.length === 0) return null;

  return (
    <fieldset className="wf-tools">
      <legend>{t('workspace.workflows.editor.agent.connectorTools')}</legend>
      {choices.state === 'loading' ? <p className="wf-muted">{t('workspace.workflows.editor.connector.loading')}</p> : null}
      {choices.state === 'error' ? <p className="wf-error">{t('workspace.workflows.editor.connector.loadFailed')}</p> : null}
      {installed.map((c) => {
        const loaded = toolsOf[c.connectorId] ?? { state: 'loading' };
        return (
          <div key={c.connectorId} className="wf-connector-tools" role="group" aria-label={c.name}>
            <p className="wf-muted wf-connector-name">{c.name}</p>
            {loaded.state === 'loading' ? (
              <p className="wf-muted">{t('workspace.workflows.editor.connector.loadingTools')}</p>
            ) : null}
            {loaded.state === 'error' ? (
              <p className="wf-error">{t('workspace.workflows.editor.connector.toolsFailed')}</p>
            ) : null}
            {loaded.state === 'ready' && loaded.value.length === 0 ? (
              <p className="wf-muted">{t('workspace.workflows.editor.connector.noTools', { name: c.name })}</p>
            ) : null}
            {loaded.state === 'ready'
              ? loaded.value.map((tool) => {
                  const ref = connectorToolRef(c.connectorId, tool.name);
                  const on = tools.includes(ref);
                  return (
                    <label key={tool.name} className="wf-check">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!on && full}
                        onChange={(e) => onToggle(ref, e.target.checked)}
                      />
                      {toolLabel(tool, t)}
                    </label>
                  );
                })
              : null}
          </div>
        );
      })}
      {missing.map((ref) => {
        const parsed = parseConnectorToolRef(ref);
        if (!parsed) return null;
        return (
          <div key={ref} className="wf-gone-tool">
            <span className="wf-error">
              {t('workspace.workflows.editor.agent.toolGone', {
                tool: parsed.tool,
                connector: installed.find((c) => c.connectorId === parsed.connectorId)?.name ?? parsed.connectorId,
              })}
            </span>
            <button type="button" className="btn ghost" onClick={() => onToggle(ref, false)}>
              {t('workspace.workflows.editor.agent.removeTool', { tool: parsed.tool })}
            </button>
          </div>
        );
      })}
      {full ? (
        <p className="wf-muted">{t('workspace.workflows.editor.agent.toolLimit', { max: MAX_AGENT_CONNECTOR_TOOLS })}</p>
      ) : null}
    </fieldset>
  );
}
