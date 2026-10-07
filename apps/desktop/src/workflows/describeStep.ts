/// One plain-English line per step, so a workflow reads as a list of what it
/// does rather than as JSON.

import type { ConditionTest, WorkflowStep } from '../ipc/contracts';
import type { Translate } from '../i18n';

/// Longest quoted text (a prompt, a query) shown in a step's line.
const MAX_QUOTE = 80;

/// Input names by id, so `{{inputs.url}}` reads as `[Page]`.
export type InputLabels = Record<string, string>;

function quote(text: string, labels: InputLabels = {}): string {
  const named = text.replace(/\{\{\s*inputs\.([a-z0-9_]+)\s*\}\}/g, (whole, id: string) =>
    labels[id] ? `[${labels[id]}]` : whole,
  );
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

/// The step's line, with a brief mention of its own model when it has one.
export function describeStep(step: WorkflowStep, t: Translate, labels: InputLabels = {}): string {
  const line = describeKind(step, t, labels);
  const only =
    (step.type === 'notify' || step.type === 'save_artifact') && step.onlyIfChanged
      ? `${line} (${t('workspace.workflows.step.onlyIfChanged')})`
      : line;
  return (step.type === 'summarize' || step.type === 'agent') && step.model
    ? `${line} ${t('workspace.workflows.step.usingModel', { model: step.model.model })}`
    : only;
}

function describeKind(step: WorkflowStep, t: Translate, labels: InputLabels): string {
  const q = (text: string) => quote(text, labels);
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
    case 'summarize':
      return step.schema
        ? t('workspace.workflows.step.summarizeData', { prompt: q(step.prompt) })
        : t('workspace.workflows.step.summarize', { prompt: q(step.prompt) });
    case 'template':
      return t('workspace.workflows.step.template');
    case 'for_each':
      return t('workspace.workflows.step.forEach', { items: step.items });
    case 'save_artifact':
      return (step.format ?? 'markdown') === 'html'
        ? t('workspace.workflows.step.saveHtml', { title: q(step.title) })
        : t('workspace.workflows.step.saveMarkdown', { title: q(step.title) });
    case 'agent':
      return t('workspace.workflows.step.agent', { prompt: q(step.prompt) });
    case 'ask':
      return t('workspace.workflows.step.ask', { question: q(step.question) });
    case 'notify':
      return t('workspace.workflows.step.notify', { title: q(step.title) });
    case 'condition':
      return t(CONDITION_STEP_KEY[step.is], { value: q(step.value), text: q(step.text ?? '') });
  }
}
