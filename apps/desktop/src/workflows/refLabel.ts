import type { Translate } from '../i18n';
import type { ValueRef } from './editorModel';

/// Readable names for step outputs and item fields in the "Insert value" menu.
const FIELD_KEY: Record<string, string> = {
  text: 'workspace.workflows.editor.field.text',
  pages: 'workspace.workflows.editor.field.pages',
  'pages.0.text': 'workspace.workflows.editor.field.firstPageText',
  'pages.0.title': 'workspace.workflows.editor.field.firstPageTitle',
  'pages.0.links': 'workspace.workflows.editor.field.firstPageLinks',
  results: 'workspace.workflows.editor.field.results',
  items: 'workspace.workflows.editor.field.items',
  data: 'workspace.workflows.editor.field.data',
  artifactId: 'workspace.workflows.editor.field.artifactId',
  title: 'workspace.workflows.editor.field.title',
  url: 'workspace.workflows.editor.field.url',
  snippet: 'workspace.workflows.editor.field.snippet',
  links: 'workspace.workflows.editor.field.links',
  index: 'workspace.workflows.editor.field.index',
  item: 'workspace.workflows.editor.field.item',
  date: 'workspace.workflows.editor.field.date',
  answer: 'workspace.workflows.editor.field.answer',
  toolCalls: 'workspace.workflows.editor.field.toolCalls',
  name: 'workspace.workflows.editor.field.fileName',
  rows: 'workspace.workflows.editor.field.rows',
  count: 'workspace.workflows.editor.field.rowCount',
  columns: 'workspace.workflows.editor.field.columns',
  reply: 'workspace.workflows.editor.field.reply',
  changed: 'workspace.workflows.editor.field.changed',
  summary: 'workspace.workflows.editor.field.summary',
  reportArtifactId: 'workspace.workflows.editor.field.reportArtifactId',
  sources: 'workspace.workflows.editor.field.sources',
  credibility: 'workspace.workflows.editor.field.credibility',
  passages: 'workspace.workflows.editor.field.passages',
  document: 'workspace.workflows.editor.field.document',
  collection: 'workspace.workflows.editor.field.collection',
  citation: 'workspace.workflows.editor.field.citation',
};

/// Names for what a trigger hands the run (`{{trigger.<field>}}`), by trigger kind.
const TRIGGER_FIELD_KEY: Record<string, string> = {
  title: 'workspace.workflows.editor.trigger.title',
  link: 'workspace.workflows.editor.trigger.link',
  summary: 'workspace.workflows.editor.trigger.summary',
  published: 'workspace.workflows.editor.trigger.published',
  id: 'workspace.workflows.editor.trigger.id',
  path: 'workspace.workflows.editor.trigger.path',
  name: 'workspace.workflows.editor.trigger.name',
  modified: 'workspace.workflows.editor.trigger.modified',
  bytes: 'workspace.workflows.editor.trigger.bytes',
};

export function refLabel(ref: ValueRef, t: Translate): string {
  const field = (name: string) => (FIELD_KEY[name] ? t(FIELD_KEY[name]) : name);
  switch (ref.source.kind) {
    case 'input':
      return ref.source.label || ref.field;
    case 'run':
      return field('date');
    case 'trigger':
      return TRIGGER_FIELD_KEY[ref.field] ? t(TRIGGER_FIELD_KEY[ref.field]) : ref.field;
    case 'item': {
      // `summary.text` inside an earlier loop's items: step, then field.
      const [first, ...rest] = ref.field.split('.');
      return rest.length > 0 ? `${first} · ${field(rest.join('.'))}` : field(first);
    }
    case 'step':
      return `${ref.source.stepId} · ${field(ref.field)}`;
  }
}
