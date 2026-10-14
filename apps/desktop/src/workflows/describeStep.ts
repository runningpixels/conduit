/// One plain-English line per step, so a workflow reads as a list of what it
/// does rather than as JSON.

import type { ConditionTest, WorkflowDefinition, WorkflowStep } from '../ipc/contracts';
import type { Translate } from '../i18n';
import type { ValueRef } from './editorModel';
import { refLabel } from './refLabel';

/// Longest quoted text (a prompt, a query) shown in a step's line.
const MAX_QUOTE = 80;

/// Input names by id, so `{{inputs.url}}` reads as `[Page]`.
export type InputLabels = Record<string, string>;

/// Where [`stepLabels`] keeps what starts the workflow, so `{{trigger.title}}`
/// reads as that kind's field. Not a valid input id, so it can't clash.
export const TRIGGER_KIND_LABEL = '$trigger';

/// A workflow's input names by id, and what starts it (`TRIGGER_KIND_LABEL`).
export function stepLabels(def: Pick<WorkflowDefinition, 'inputs' | 'trigger'>): InputLabels {
  const labels: InputLabels = Object.fromEntries((def.inputs ?? []).map((i) => [i.id, i.label]));
  if (def.trigger) labels[TRIGGER_KIND_LABEL] = def.trigger.kind;
  return labels;
}

/// A `{{path}}` as the chip the editor shows for it, or `null` for a path it
/// has no chip for.
function refFor(path: string, labels: InputLabels): ValueRef | null {
  const [head, second, ...rest] = path.split('.');
  switch (head) {
    case 'inputs':
      return second && labels[second]
        ? { path, source: { kind: 'input', label: labels[second] }, field: second, list: false }
        : null;
    case 'run':
      return { path, source: { kind: 'run' }, field: 'date', list: false };
    case 'trigger':
      return second
        ? { path, source: { kind: 'trigger', trigger: labels[TRIGGER_KIND_LABEL] }, field: second, list: false }
        : null;
    case 'steps':
      return second && rest.length > 0
        ? { path, source: { kind: 'step', stepId: second }, field: rest.join('.'), list: false }
        : null;
    case 'item':
      return { path, source: { kind: 'item' }, field: second ? [second, ...rest].join('.') : 'item', list: false };
    default:
      return null;
  }
}

/// A step's text on one line, each `{{reference}}` as the label its chip carries
/// (`[Topic]`, `[the new file's path]`). `\{{` stays literal.
function quote(text: string, t: Translate, labels: InputLabels = {}): string {
  const named = text.replace(/(\\?)\{\{\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g, (whole, slash: string, path: string) => {
    if (slash) return whole;
    const ref = refFor(path, labels);
    return ref ? `[${refLabel(ref, t)}]` : whole;
  });
  const flat = named.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_QUOTE ? `${flat.slice(0, MAX_QUOTE - 1)}…` : flat;
}

const CONDITION_STEP_KEY: Record<ConditionTest, string> = {
  changed: 'workspace.workflows.step.condition.changed',
  not_empty: 'workspace.workflows.step.condition.notEmpty',
  empty: 'workspace.workflows.step.condition.empty',
  contains: 'workspace.workflows.step.condition.contains',
  not_contains: 'workspace.workflows.step.condition.notContains',
  equals: 'workspace.workflows.step.condition.equals',
};

const BRANCH_STEP_KEY: Record<ConditionTest, string> = {
  changed: 'workspace.workflows.step.branch.changed',
  not_empty: 'workspace.workflows.step.branch.notEmpty',
  empty: 'workspace.workflows.step.branch.empty',
  contains: 'workspace.workflows.step.branch.contains',
  not_contains: 'workspace.workflows.step.branch.notContains',
  equals: 'workspace.workflows.step.branch.equals',
};

/// What one entry of a list is called, by the list's name ("pages" -> "page").
const SINGULAR: Record<string, string> = {
  pages: 'page',
  items: 'item',
  results: 'result',
  rows: 'row',
  stories: 'story',
  files: 'file',
};

/// A loop over `steps.<id>.<list>` as "step N" and what one entry is, or `null`
/// when the list is not an earlier step's output.
export function forEachSource(items: string, scope: readonly WorkflowStep[]): { n: number; kind: string } | null {
  const match = /^(?:\{\{\s*)?steps\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+?)(?:\s*\}\})?$/.exec(items.trim());
  if (!match) return null;
  const index = scope.findIndex((s) => s.id === match[1]);
  if (index < 0) return null;
  const last = match[2].split('.').pop() ?? '';
  return { n: index + 1, kind: SINGULAR[last] ?? 'item' };
}

/// The step's line, with a brief mention of its own model when it has one.
/// `scope` is the workflow's top-level steps, so a loop can say which step it reads.
export function describeStep(
  step: WorkflowStep,
  t: Translate,
  labels: InputLabels = {},
  connectorNames: Record<string, string> = {},
  scope: readonly WorkflowStep[] = [],
): string {
  const line = describeKind(step, t, labels, connectorNames, scope);
  const only =
    (step.type === 'notify' || step.type === 'save_artifact') && step.onlyIfChanged
      ? `${line} (${t('workspace.workflows.step.onlyIfChanged')})`
      : line;
  return (step.type === 'summarize' || step.type === 'agent' || step.type === 'edit_deck' || step.type === 'edit_draft' || step.type === 'research') && step.model
    ? `${line} ${t('workspace.workflows.step.usingModel', { model: step.model.model })}`
    : only;
}

function describeKind(
  step: WorkflowStep,
  t: Translate,
  labels: InputLabels,
  connectorNames: Record<string, string>,
  scope: readonly WorkflowStep[],
): string {
  const q = (text: string) => quote(text, t, labels);
  switch (step.type) {
    case 'fetch_page':
      return t('workspace.workflows.step.fetchPage', {
        count: step.urls.length,
        urls: step.urls.map(q).join(', '),
      });
    case 'web_search':
      return t('workspace.workflows.step.webSearch', { query: q(step.query) });
    case 'read_file':
      return t('workspace.workflows.step.readFile', { path: q(step.path) });
    case 'parse_data':
      return t('workspace.workflows.step.parseData', { format: step.format.toUpperCase() });
    case 'research':
      return t(
        step.depth === 'standard' ? 'workspace.workflows.step.researchStandard' : 'workspace.workflows.step.researchQuick',
        { question: q(step.question) },
      );
    case 'search_documents':
      return t('workspace.workflows.step.searchDocuments', {
        count: step.collections.length,
        query: q(step.query),
      });
    case 'connector_tool':
      return step.connector && step.tool
        ? t('workspace.workflows.step.connectorTool', {
            tool: step.tool,
            connector: connectorNames[step.connector] ?? step.connector,
          })
        : t('workspace.workflows.step.connectorToolEmpty');
    case 'summarize':
      return step.schema
        ? t('workspace.workflows.step.summarizeData', { prompt: q(step.prompt) })
        : t('workspace.workflows.step.summarize', { prompt: q(step.prompt) });
    case 'template':
      return t('workspace.workflows.step.template');
    case 'for_each':
    {
      const source = forEachSource(step.items, scope);
      return source
        ? t('workspace.workflows.step.forEachFrom', source)
        : t('workspace.workflows.step.forEach', { items: step.items });
    }
    case 'save_artifact':
      return (step.format ?? 'markdown') === 'html'
        ? t('workspace.workflows.step.saveHtml', { title: q(step.title) })
        : t('workspace.workflows.step.saveMarkdown', { title: q(step.title) });
    case 'export_file':
      return t('workspace.workflows.step.exportFile', { name: q(step.name) });
    case 'save_memory':
      return t('workspace.workflows.step.saveMemory', { text: q(step.text) });
    case 'agent':
      return t('workspace.workflows.step.agent', { prompt: q(step.prompt) });
    case 'edit_deck':
      return t('workspace.workflows.step.editDeck', { instructions: q(step.instructions) });
    case 'edit_draft':
      return t('workspace.workflows.step.editDraft', { instructions: q(step.instructions) });
    case 'ask':
      return t('workspace.workflows.step.ask', { question: q(step.question) });
    case 'notify':
      return t('workspace.workflows.step.notify', { title: q(step.title) });
    case 'condition':
      return t(CONDITION_STEP_KEY[step.is], { value: q(step.value), text: q(step.text ?? '') });
    case 'branch':
      return t(BRANCH_STEP_KEY[step.is], { value: q(step.value), text: q(step.text ?? '') });
  }
}
