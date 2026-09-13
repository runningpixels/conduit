/**
 * Fixture data for `?route=gallery` (`dev/Gallery.tsx`).
 *
 * Everything here is inert: fixed ids and a fixed timestamp, so a screenshot
 * taken today matches one taken next month with the same palette/theme. Real
 * component props, not markup — the gallery renders the actual `@conduit/ui`
 * primitives, chat blocks and shell components against these, so a visual
 * regression here is a real one.
 *
 * Imported only from `Gallery.tsx`, which is itself reached only behind
 * `import.meta.env.DEV` (`devRoute.ts`) — dead code in a production build.
 */

import type {
  AppSettings,
  Artifact,
  ConversationFolder,
  ConversationSummary,
  SkillSummary,
} from '../ipc/contracts';
import type { StatusState } from '../chat/statusTypes';
import type { AssistantStreamState } from '../chat/streamState';
import { createAssistantStreamState } from '../chat/streamState';
import type { SuggestedPrompt } from '../chat/suggestedPromptData';
import { appName } from '../brand';
import { FIXTURE_ARTIFACTS } from './artifactFixtures';

/** One fixed instant, so relative-time formatting never drifts between runs. */
export const GALLERY_NOW = '2026-09-13T12:00:00Z';

export const GALLERY_SETTINGS: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'dark',
  language: 'system',
  providerEndpoints: {},
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  updateChannel: 'stable',
  updateCheckEnabled: true,
  updatePolicy: 'manual',
  onboardingCompleted: true,
  webSearchEnabled: true,
  webSearch: {
    mode: 'auto',
    localBackend: 'duckduckgo',
    searchContextSize: 'medium',
    allowedDomains: [],
    blockedDomains: [],
    externalWebAccess: true,
    returnTokenBudget: 'default',
    includeSources: false,
  },
  webSearchConsentAcknowledged: true,
  agent: {
    maxSteps: 25,
    wallClockBudgetSecs: 300,
  },
  keychainMode: 'os',
  brandingEnabled: false,
  workspaceToolsEnabled: false,
  workspaceRoot: null,
  workspaceToolsConsentAcknowledged: false,
  generationControls: null,
  userInstructions: null,
  contextCompactEnabled: true,
  contextCompactThresholdPercent: 90,
  memoryEnabled: true,
};

export const GALLERY_FOLDERS: ConversationFolder[] = [
  { id: 'folder-research', name: 'Research', createdAt: GALLERY_NOW },
];

export const GALLERY_CONVERSATIONS: ConversationSummary[] = [
  {
    id: 'convo-active',
    title: undefined,
    displayTitle: 'Migration plan review',
    updatedAt: GALLERY_NOW,
    messageCount: 12,
    lastMessagePreview: 'Looks good — ship it after the dry run.',
    pinnedAt: '2026-09-12T09:00:00Z',
  },
  {
    id: 'convo-openai',
    title: undefined,
    displayTitle: 'Compare pricing tiers',
    updatedAt: '2026-09-12T18:30:00Z',
    messageCount: 4,
    lastMessagePreview: 'Here is the per-token breakdown for each tier.',
    folderId: 'folder-research',
    folderName: 'Research',
  },
  {
    id: 'convo-ollama',
    title: undefined,
    displayTitle: 'Local model smoke test',
    updatedAt: '2026-09-11T08:15:00Z',
    messageCount: 2,
    lastMessagePreview: 'Runs fine offline, 40 tok/s on this machine.',
  },
  {
    id: 'convo-custom',
    title: undefined,
    displayTitle: 'Self-hosted endpoint notes',
    updatedAt: '2026-09-10T14:00:00Z',
    messageCount: 6,
    lastMessagePreview: 'Latency is fine once the proxy warms up.',
    archivedAt: '2026-09-10T15:00:00Z',
  },
  {
    id: 'convo-untitled',
    title: undefined,
    displayTitle: undefined,
    updatedAt: '2026-09-09T09:00:00Z',
    messageCount: 0,
  },
];

/** conversationId → providerId, so every sidebar hue dot has a fixture. */
export const GALLERY_CONVO_PROVIDERS: Record<string, string> = {
  'convo-active': 'anthropic',
  'convo-openai': 'openai',
  'convo-ollama': 'ollama',
  'convo-custom': 'custom-endpoint',
  'convo-untitled': 'anthropic',
};

export const GALLERY_TOASTS: StatusState[] = [
  { brief: 'Document updated', kind: 'success', timestamp: 1 },
  { brief: 'Web search unavailable', detail: 'The endpoint refused the request.', kind: 'warning', timestamp: 2 },
  { brief: 'Could not export conversation', detail: 'Disk is full.', kind: 'error', timestamp: 3 },
];

export const GALLERY_SUGGESTED_PROMPTS: readonly SuggestedPrompt[] = [
  { id: 'sp-1', short: 'Summarize this thread', text: 'Summarize this thread in three bullet points.' },
  { id: 'sp-2', short: 'List open risks', text: 'List every open risk mentioned above with its owner.' },
  { id: 'sp-3', short: 'Draft a follow-up', text: 'Draft a follow-up message to the team recapping decisions made.' },
];

export const GALLERY_SKILLS: SkillSummary[] = [
  {
    id: 'skill-release-notes',
    name: 'Release notes',
    description: 'Drafts release notes from a diff and a set of commit messages.',
    source: 'conduit',
    path: '/skills/release-notes',
    hasScripts: false,
    hasReferences: true,
    hasAssets: false,
  },
  {
    id: 'skill-workspace-audit',
    name: 'Workspace audit',
    description: 'Surveys a workspace for stale dependencies and open TODOs.',
    source: 'workspace',
    path: '/skills/workspace-audit',
    hasScripts: true,
    hasReferences: false,
    hasAssets: false,
  },
];

const MARKDOWN_SHOWCASE = `# Release notes

${appName()} renders every surface consistently across palettes.

- Tokens replace ad hoc hex values
- Contrast is checked automatically
- Screens ship in **terra**, **orange-charcoal**, and **orange-dark**

| Palette | Mode | Status |
| --- | --- | --- |
| terra | dark | stable |
| orange-charcoal | light | stable |
| orange-dark | dark | stable |

Inline code looks like \`const ready = true\` and a [reference link](https://example.com/docs) sits inline too. Energy scales as $E = mc^2$ inline.

\`\`\`ts
export function ready(): boolean {
  return true;
}
\`\`\`

\`\`\`math
E = mc^2
\`\`\`

\`\`\`mermaid
flowchart TD
  A[Gallery] --> B[Snapshot]
  B --> C[Review]
\`\`\`
`;

function textState(overrides: Partial<AssistantStreamState> = {}): AssistantStreamState {
  const base = createAssistantStreamState('gallery-req');
  return {
    ...base,
    streaming: false,
    blocks: [{ blockId: 'b1', blockKind: 'text', content: MARKDOWN_SHOWCASE, citations: [] }],
    segments: [{ kind: 'text', blockId: 'b1' }],
    usage: { inputTokens: 812n, outputTokens: 246n },
    ...overrides,
  };
}

/** Assistant turn: full markdown showcase (headings, list, table, code, links, KaTeX, mermaid). */
export const GALLERY_ASSISTANT_MARKDOWN: AssistantStreamState = textState();

/** Assistant turn: still streaming, caret visible at the tail of the prose. */
export const GALLERY_ASSISTANT_STREAMING: AssistantStreamState = textState({
  streaming: true,
  blocks: [
    {
      blockId: 'b1',
      blockKind: 'text',
      content: 'Running the migration dry run now. So far every shard has copied cleanly',
      citations: [],
    },
  ],
  usage: undefined,
});

/** Assistant turn: a reasoning ("thinking") block ahead of the reply. */
export const GALLERY_ASSISTANT_REASONING: AssistantStreamState = {
  ...createAssistantStreamState('gallery-reasoning'),
  streaming: false,
  reasoning: [
    {
      blockId: 'r1',
      blockKind: 'reasoning',
      content:
        'The dry run touched three shards. Two finished under budget; the third needs a retry policy before it can run unattended.',
      citations: [],
    },
  ],
  blocks: [{ blockId: 'b1', blockKind: 'text', content: 'Two of three shards are ready; the third needs a retry policy first.', citations: [] }],
  segments: [
    { kind: 'reasoning', blockId: 'r1' },
    { kind: 'text', blockId: 'b1' },
  ],
};

/** Assistant turn: a successful tool call. */
export const GALLERY_ASSISTANT_TOOL_SUCCESS: AssistantStreamState = {
  ...createAssistantStreamState('gallery-tool-ok'),
  streaming: false,
  toolCalls: [
    {
      toolCallId: 'tc-ok',
      toolId: 'read_file',
      name: 'read_file',
      argumentsText: '{"path":"docs/theming/decisions.md"}',
      arguments: { path: 'docs/theming/decisions.md' },
      complete: true,
      startedAt: 0,
      endedAt: 420,
      status: 'completed',
    },
  ],
  blocks: [{ blockId: 'b1', blockKind: 'text', content: 'The decisions doc confirms terra stays the default look.', citations: [] }],
  segments: [
    { kind: 'tool', toolCallId: 'tc-ok' },
    { kind: 'text', blockId: 'b1' },
  ],
};

/** Assistant turn: a failed tool call. */
export const GALLERY_ASSISTANT_TOOL_ERROR: AssistantStreamState = {
  ...createAssistantStreamState('gallery-tool-err'),
  streaming: false,
  toolCalls: [
    {
      toolCallId: 'tc-err',
      toolId: 'run_command',
      name: 'run_command',
      argumentsText: '{"command":"pnpm test:visual"}',
      arguments: { command: 'pnpm test:visual' },
      complete: true,
      startedAt: 0,
      endedAt: 1800,
      status: 'failed',
      error: 'No installed Chrome or Edge channel found.',
    },
  ],
  segments: [{ kind: 'tool', toolCallId: 'tc-err' }],
};

/** Assistant turn: a hosted web-search call. */
export const GALLERY_ASSISTANT_SEARCH: AssistantStreamState = {
  ...createAssistantStreamState('gallery-search', 'hosted'),
  streaming: false,
  toolCalls: [
    {
      toolCallId: 'tc-search',
      toolId: 'web_search',
      name: 'web_search',
      argumentsText: '{"query":"css contain fixed position containing block"}',
      arguments: { query: 'css contain fixed position containing block' },
      complete: true,
      startedAt: 0,
      endedAt: 900,
      status: 'completed',
    },
  ],
  blocks: [{ blockId: 'b1', blockKind: 'text', content: '`contain: layout` makes an element a containing block for fixed descendants.', citations: [] }],
  segments: [
    { kind: 'tool', toolCallId: 'tc-search' },
    { kind: 'text', blockId: 'b1' },
  ],
};

/** Assistant turn: an artifact result card (needs `messageId` + `artifacts`). */
export const GALLERY_ASSISTANT_ARTIFACT: AssistantStreamState = {
  ...createAssistantStreamState('gallery-artifact'),
  streaming: false,
  blocks: [{ blockId: 'b1', blockKind: 'text', content: "I've put together the launch readiness report.", citations: [] }],
  segments: [{ kind: 'text', blockId: 'b1' }],
};

/** Assistant turn: a pending ask-user form. */
export const GALLERY_ASSISTANT_ASK_USER: AssistantStreamState = {
  ...createAssistantStreamState('gallery-ask'),
  streaming: false,
  askUser: {
    toolCallId: 'ask-1',
    title: 'Which palette should ship as the default?',
    fields: [
      {
        id: 'palette',
        prompt: 'Default palette',
        type: 'choice',
        options: ['terra', 'orange-charcoal', 'orange-dark'],
      },
    ],
  },
  segments: [{ kind: 'askUser', toolCallId: 'ask-1' }],
};

/** The three sample artifacts (`dev/artifactFixtures.ts`), reused for the
 *  artifact-result-card and document-panel sections.
 *
 *  The first is given a `sourceMessageId` matching
 *  `GALLERY_ASSISTANT_ARTIFACT`'s `messageId` in the chat section
 *  (`gallery-artifact-turn`) — `AssistantArtifactStrip` only renders a card
 *  for an artifact whose `sourceMessageId` equals the turn's `messageId`, so
 *  without this the "Artifact result card" demo silently rendered nothing
 *  but its lead-in sentence. New objects, not a mutation of
 *  `FIXTURE_ARTIFACTS` itself, since `GALLERY_MARKDOWN_ARTIFACT` /
 *  `GALLERY_HTML_ARTIFACT` / `GALLERY_CODE_ARTIFACT` below read from that
 *  array directly for the document-panel section. */
export const GALLERY_ARTIFACTS: Artifact[] = FIXTURE_ARTIFACTS.map((artifact, index) =>
  index === 0 ? { ...artifact, sourceMessageId: 'gallery-artifact-turn' } : artifact,
);
export const GALLERY_MARKDOWN_ARTIFACT = FIXTURE_ARTIFACTS.find((a) => a.kind === 'markdown')!;
export const GALLERY_HTML_ARTIFACT = FIXTURE_ARTIFACTS.find((a) => a.kind === 'html')!;
export const GALLERY_CODE_ARTIFACT = FIXTURE_ARTIFACTS.find((a) => a.kind === 'code')!;
