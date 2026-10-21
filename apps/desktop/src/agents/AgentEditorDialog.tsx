/// The dialog to make or change one of the user's agents (the agent library): name,
/// instructions, model, tools, the agents it may hand work to and a token limit.
/// What is wrong with it is checked by the backend as the user types and listed
/// under the form; the same check runs again when the agent is saved.
///
/// Escape is caught in the capture phase, like the other dialogs over a page.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useFocusTrap } from '../shell/useFocusTrap';
import { useT } from '../i18n';
import { createLibraryAgent, updateLibraryAgent, validateLibraryAgent } from '../ipc/client';
import type { AgentDef, LibraryAgent } from '../ipc/contracts';
import { AgentConnectorTools } from '../workflows/AgentConnectorTools';
import {
  AGENT_TOOLS,
  COMPUTER_TOOL,
  DEFAULT_HELPER_TOKENS,
  MAX_HELPER_LINKS,
  MAX_HELPER_TOKENS,
  MIN_HELPER_TOKENS,
  uniqueId,
  withBuiltinTool,
  withComputerTool,
  withConnectorTool,
  withHelperLink,
  withHelperModel,
  withHelperTokens,
} from '../workflows/editorModel';
import { agentToolText } from '../workflows/permissionText';
import { ProviderModelsProvider, WorkflowModelRow } from '../workflows/WorkflowModelRow';

/// How long the form rests before it is checked again.
export const VALIDATE_DEBOUNCE_MS = 300;

/// A new agent starts with the web tools, like a new helper.
const BLANK: AgentDef = { id: '', name: '', instructions: '', tools: ['web_search', 'web_fetch'] };

function errorLines(e: unknown): string[] {
  const text = e instanceof Error ? e.message : String(e);
  return text.split('\n').filter((line) => line.trim() !== '');
}

export function AgentEditorDialog({
  agent,
  library,
  onClose,
  onSaved,
}: {
  /// The agent to change; `null` makes a new one.
  agent: LibraryAgent | null;
  /// All of the user's agents: the ones this one may hand work to, and the ids already taken.
  library: readonly LibraryAgent[];
  onClose: () => void;
  onSaved: (saved: LibraryAgent) => void;
}) {
  const t = useT();
  const titleId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  useFocusTrap(formRef, true);
  const [draft, setDraft] = useState<AgentDef>(() => agent?.agent ?? BLANK);
  const [problems, setProblems] = useState<string[]>([]);
  const [showProblems, setShowProblems] = useState(false);
  const [saveProblems, setSaveProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const isNew = agent === null;
  const set = (fn: (d: AgentDef) => AgentDef) => {
    setDraft(fn);
    setShowProblems(true);
    setSaveProblems([]);
  };

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  /// A new agent has no id until it is saved; the check needs one, so it gets the one its name would.
  const checkedId = draft.id || uniqueId(draft.name || 'agent', new Set(library.map((a) => a.agent.id)));
  const checked = { ...draft, id: checkedId };
  const key = JSON.stringify(checked);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => validateLibraryAgent(JSON.parse(key) as AgentDef))
        .then((list) => {
          if (!cancelled) setProblems(Array.isArray(list) ? list : []);
        })
        .catch(() => {
          if (!cancelled) setProblems([]);
        });
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (problems.length > 0) {
      setShowProblems(true);
      return;
    }
    setBusy(true);
    setSaveProblems([]);
    try {
      const saved = isNew ? await createLibraryAgent(draft) : await updateLibraryAgent(draft);
      onSaved(saved);
    } catch (e) {
      setSaveProblems(errorLines(e));
      setBusy(false);
    }
  }

  const tools = draft.tools ?? [];
  const linked = draft.agents ?? [];
  const others = library.filter((a) => a.agent.id !== draft.id);
  const shown = saveProblems.length > 0 ? saveProblems : showProblems ? problems : [];

  return (
    <div
      className="consent-overlay app-inputs-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        ref={formRef}
        className="app-inputs-dialog agent-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => void submit(e)}
      >
        <header className="agent-editor-head">
          <h2 id={titleId}>{isNew ? t('shell.agents.editor.titleNew') : t('shell.agents.editor.titleEdit')}</h2>
        </header>

        {/* Two columns on a wide window: what the agent is, then what it may use. */}
        <div className="agent-editor-body">
          <section className="agent-editor-col" aria-labelledby={`${titleId}-who`}>
            <h3 className="agent-editor-h" id={`${titleId}-who`}>
              {t('shell.agents.editor.identity')}
            </h3>
            <ProviderModelsProvider>
              <label className="app-field">
                <span className="app-field-label">{t('shell.agents.editor.name')}</span>
                <input
                  type="text"
                  autoFocus
                  placeholder={t('workspace.workflows.helpers.namePlaceholder')}
                  value={draft.name}
                  onChange={(e) => set((d) => ({ ...d, name: e.target.value }))}
                />
              </label>
              <label className="app-field agent-editor-instructions">
                <span className="app-field-label">{t('workspace.workflows.helpers.instructions')}</span>
                <textarea
                  className="mem-input"
                  rows={9}
                  placeholder={t('shell.agents.editor.instructionsPlaceholder')}
                  value={draft.instructions}
                  onChange={(e) => set((d) => ({ ...d, instructions: e.target.value }))}
                />
              </label>
              <WorkflowModelRow
                kind="step"
                idPrefix="agent-editor-model"
                label={t('workspace.workflows.model.label')}
                model={draft.model}
                onChange={(model) => set((d) => withHelperModel(d, model))}
              />
            </ProviderModelsProvider>
            <label className="app-field agent-editor-tokens">
              <span className="app-field-label">{t('workspace.workflows.helpers.tokens')}</span>
              <input
                type="number"
                min={MIN_HELPER_TOKENS}
                max={MAX_HELPER_TOKENS}
                step={1000}
                placeholder={String(DEFAULT_HELPER_TOKENS)}
                value={draft.maxTokens ?? ''}
                onChange={(e) => set((d) => withHelperTokens(d, e.target.value === '' ? null : Number(e.target.value)))}
              />
            </label>
          </section>

          <section className="agent-editor-col" aria-labelledby={`${titleId}-uses`}>
            <h3 className="agent-editor-h" id={`${titleId}-uses`}>
              {t('shell.agents.editor.abilities')}
            </h3>
            <fieldset className="wf-tools agent-editor-group">
              <legend>{t('workspace.workflows.editor.agent.tools')}</legend>
              <div className="agent-editor-checks">
                {AGENT_TOOLS.map((tool) => (
                  <label key={tool} className="wf-check">
                    <input
                      type="checkbox"
                      checked={tools.includes(tool)}
                      onChange={(e) => set((d) => ({ ...d, tools: withBuiltinTool(d.tools ?? [], tool, e.target.checked) }))}
                    />
                    {agentToolText(tool, t)}
                  </label>
                ))}
              </div>
              <label className="wf-check">
                <input
                  type="checkbox"
                  checked={tools.includes(COMPUTER_TOOL)}
                  onChange={(e) => set((d) => ({ ...d, tools: withComputerTool(d.tools ?? [], e.target.checked) }))}
                />
                {t('workspace.workflows.editor.agent.computer')}
              </label>
              {tools.includes(COMPUTER_TOOL) ? <p className="wf-muted">{t('shell.agents.editor.computerHint')}</p> : null}
            </fieldset>
            <div className="agent-editor-group">
              <AgentConnectorTools
                tools={tools}
                onToggle={(ref, on) => set((d) => ({ ...d, tools: withConnectorTool(d.tools ?? [], ref, on) }))}
              />
            </div>
            {others.length > 0 ? (
              <fieldset className="wf-tools agent-editor-group">
                <legend>{t('workspace.workflows.helpers.handsTo')}</legend>
                <div className="agent-editor-checks">
                  {others.map((other) => {
                    const on = linked.includes(other.agent.id);
                    return (
                      <label key={other.agent.id} className="wf-check">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={!on && linked.length >= MAX_HELPER_LINKS}
                          onChange={(e) => set((d) => withHelperLink(d, other.agent.id, e.target.checked))}
                        />
                        {other.agent.name || other.agent.id}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ) : null}
          </section>
        </div>

        {/* Always in view: what is wrong, and the buttons. */}
        <footer className="agent-editor-foot">
          {shown.length > 0 ? (
            <ul className="agent-editor-problems" role="alert">
              {shown.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          <div className="app-details-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              {t('common.actions.cancel')}
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              {isNew ? t('shell.agents.editor.create') : t('common.actions.save')}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
