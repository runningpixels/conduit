/// The catalog key naming each step kind ("Fetch pages", "Ask the model"),
/// shared by the step editor and the canvas.

import type { StepType } from './editorModel';

export const STEP_TYPE_KEY: Record<StepType, string> = {
  fetch_page: 'workspace.workflows.editor.type.fetchPage',
  web_search: 'workspace.workflows.editor.type.webSearch',
  read_file: 'workspace.workflows.editor.type.readFile',
  parse_data: 'workspace.workflows.editor.type.parseData',
  research: 'workspace.workflows.editor.type.research',
  search_documents: 'workspace.workflows.editor.type.searchDocuments',
  connector_tool: 'workspace.workflows.editor.type.connectorTool',
  summarize: 'workspace.workflows.editor.type.summarize',
  template: 'workspace.workflows.editor.type.template',
  for_each: 'workspace.workflows.editor.type.forEach',
  save_artifact: 'workspace.workflows.editor.type.saveArtifact',
  export_file: 'workspace.workflows.editor.type.exportFile',
  save_memory: 'workspace.workflows.editor.type.saveMemory',
  notify: 'workspace.workflows.editor.type.notify',
  ask: 'workspace.workflows.editor.type.ask',
  agent: 'workspace.workflows.editor.type.agent',
  edit_deck: 'workspace.workflows.editor.type.editDeck',
  edit_draft: 'workspace.workflows.editor.type.editDraft',
  condition: 'workspace.workflows.editor.type.condition',
  branch: 'workspace.workflows.editor.type.branch',
};
