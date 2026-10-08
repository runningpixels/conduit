/// What a workflow's permissions and questions say, in the user's language.
///
/// The permissions come from Rust (`workflows::permissions`): what a
/// workflow may do when it runs on its own, and what a paused run asks for.

import type { Translate } from '../i18n';
import type { WorkflowPermissionView, WorkflowReview } from '../ipc/contracts';

/// What each agent tool lets a step do (tool name → catalog key).
const AGENT_TOOL_KEY: Record<string, string> = {
  web_search: 'workspace.workflows.agentTool.webSearch',
  web_fetch: 'workspace.workflows.agentTool.webFetch',
  current_time: 'workspace.workflows.agentTool.currentTime',
  calculator: 'workspace.workflows.agentTool.calculator',
};

/// What one agent tool lets a step do ("search the web").
export function agentToolText(tool: string, t: Translate): string {
  return AGENT_TOOL_KEY[tool] ? t(AGENT_TOOL_KEY[tool]) : tool;
}

/// What an agent step's tools let it do, joined ("search the web, read any web page it chooses").
export function agentToolsText(tools: readonly string[], t: Translate): string {
  return tools.map((tool) => agentToolText(tool, t)).join(', ');
}

/// The titles of a documents permission's collections, joined ("Notes, Specs").
export function documentTitles(p: Extract<WorkflowPermissionView, { kind: 'documents' }>): string {
  return p.collections.map((c) => c.title).join(', ');
}

/// One line of "When it runs on its own, it will be allowed to: …".
export function permissionText(p: WorkflowPermissionView, t: Translate): string {
  switch (p.kind) {
    case 'host':
      return t('workspace.workflows.permissions.host', { host: p.host });
    case 'anyHost':
      return t('workspace.workflows.permissions.anyHost', { step: p.stepId });
    case 'webSearch':
      return t('workspace.workflows.permissions.webSearch', { backend: p.label ?? p.backend });
    case 'model':
      return p.local
        ? t('workspace.workflows.permissions.modelLocal', { provider: p.label ?? p.provider })
        : t('workspace.workflows.permissions.modelCloud', { provider: p.label ?? p.provider });
    case 'saveDocuments':
      return t('workspace.workflows.permissions.saveDocuments');
    case 'readFolder':
      return t('workspace.workflows.permissions.readFolder', { folder: p.path });
    case 'agentTools':
      return t('workspace.workflows.permissions.agentTools', { step: p.stepId, tools: agentToolsText(p.tools, t) });
    case 'research':
      return t('workspace.workflows.permissions.research');
    case 'documents':
      return t('workspace.workflows.permissions.documents', { titles: documentTitles(p) });
    case 'connector':
      return t('workspace.workflows.permissions.connector', { tool: p.tool, connector: p.name });
    case 'editDocument':
      return t(
        p.documentKind === 'deck' ? 'workspace.workflows.permissions.editDeck' : 'workspace.workflows.permissions.editDraft',
        { title: p.title },
      );
  }
}

/// What a paused run wants, as one sentence ("It wants to read pages on bbc.com.").
export function reviewText(review: WorkflowReview, t: Translate): string {
  const p = review.permission;
  switch (p.kind) {
    case 'host':
      return t('workspace.workflows.review.host', { host: p.host });
    case 'anyHost':
      return t('workspace.workflows.review.anyHost', { url: review.url ?? '', step: p.stepId });
    case 'webSearch':
      return t('workspace.workflows.review.webSearch', { backend: p.label ?? p.backend });
    case 'model':
      return p.local
        ? t('workspace.workflows.review.modelLocal', { provider: p.label ?? p.provider })
        : t('workspace.workflows.review.modelCloud', { provider: p.label ?? p.provider });
    case 'saveDocuments':
      return t('workspace.workflows.review.saveDocuments');
    case 'readFolder':
      return t('workspace.workflows.review.readFolder', { folder: p.path });
    case 'agentTools':
      return t('workspace.workflows.review.agentTools', { step: p.stepId, tools: agentToolsText(p.tools, t) });
    case 'research':
      return t('workspace.workflows.review.research');
    case 'documents':
      return t('workspace.workflows.review.documents', { titles: documentTitles(p) });
    case 'connector':
      return t('workspace.workflows.review.connector', { tool: p.tool, connector: p.name });
    case 'editDocument':
      return t(
        p.documentKind === 'deck' ? 'workspace.workflows.review.editDeck' : 'workspace.workflows.review.editDraft',
        { title: p.title },
      );
  }
}
