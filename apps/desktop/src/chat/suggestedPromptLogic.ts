import type { Artifact } from '../ipc/contracts';
import { looksLikeArtifactCreationRequest } from './artifactPrompt';
import { resolveRecentDocumentArtifactId } from './artifactFollowUpContext';
import { looksLikeInformationalQuestion } from './documentTurnIntent';
import type { ChatTurn } from './conversationHydration';
import { STARTER_SUGGESTED_PROMPTS, type SuggestedPrompt } from './suggestedPromptData';

export type { SuggestedPrompt } from './suggestedPromptData';
export { STARTER_SUGGESTED_PROMPTS } from './suggestedPromptData';

const MAX_SUGGESTIONS = 4;

/** Generic follow-ups when no stronger signal is present. */
const GENERIC_FOLLOW_UPS: readonly SuggestedPrompt[] = [
  {
    id: 'followup-summarize',
    label: 'Summarize',
    text: 'Summarize the key points from your last reply in a short bullet list.',
  },
  {
    id: 'followup-clarify',
    label: 'Clarify',
    text: 'What assumptions did you make, and what should I clarify?',
  },
  {
    id: 'followup-next',
    label: 'Next steps',
    text: 'What are the concrete next steps I should take based on this?',
  },
  {
    id: 'followup-markdown',
    label: 'Markdown',
    text: 'Turn your last reply into a markdown artifact I can promote.',
  },
];

/** Suggestions when a document artifact is in scope. */
function artifactEditFollowUps(artifact: Artifact | undefined): SuggestedPrompt[] {
  const title = artifact?.title?.trim();
  const kind = artifact?.kind ?? 'document';
  const subject = title ? `"${title}"` : `the ${kind} artifact`;
  return [
    {
      id: 'artifact-edit-improve',
      label: 'Improve',
      text: `Improve ${subject} — tighten the wording and fix any gaps.`,
    },
    {
      id: 'artifact-edit-style',
      label: 'Style',
      text: `Update ${subject} with a cleaner layout and better visual hierarchy.`,
    },
    {
      id: 'artifact-edit-section',
      label: 'Add section',
      text: `Add a new section to ${subject} that covers edge cases and examples.`,
    },
    {
      id: 'artifact-edit-convert',
      label: 'Convert',
      text: `Convert ${subject} to a different format while keeping the same content.`,
    },
  ];
}

/** Suggestions when the last assistant reply was explanatory. */
const INFORMATIONAL_FOLLOW_UPS: readonly SuggestedPrompt[] = [
  {
    id: 'info-summarize',
    label: 'Summarize',
    text: 'Summarize your explanation in three bullet points.',
  },
  {
    id: 'info-action-items',
    label: 'Action items',
    text: 'Extract actionable next steps from your last reply.',
  },
  {
    id: 'info-markdown',
    label: 'Markdown',
    text: 'Turn your last reply into a markdown artifact I can promote.',
  },
  {
    id: 'info-example',
    label: 'Example',
    text: 'Show a concrete example that illustrates what you just explained.',
  },
];

/** Suggestions when the user asked for creation but no artifact exists yet. */
const CREATION_RETRY_FOLLOW_UPS: readonly SuggestedPrompt[] = [
  {
    id: 'create-retry-html',
    label: 'HTML',
    text: 'Create a new HTML artifact with the full page in a ```html fence.',
  },
  {
    id: 'create-retry-markdown',
    label: 'Markdown',
    text: 'Create a new markdown artifact with the full document in a ```markdown fence.',
  },
  {
    id: 'create-retry-json',
    label: 'JSON',
    text: 'Create a new JSON artifact with the schema in a ```json fence.',
  },
  {
    id: 'create-retry-outline',
    label: 'Outline first',
    text: 'Outline the artifact structure first, then generate the full content.',
  },
];

function lastTurn(turns: ChatTurn[], role: 'user' | 'assistant'): ChatTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === role) return turns[i];
  }
  return undefined;
}

function takeUpTo(prompts: readonly SuggestedPrompt[], max = MAX_SUGGESTIONS): SuggestedPrompt[] {
  return prompts.slice(0, max);
}

export interface SuggestedPromptContext {
  turns: ChatTurn[];
  artifacts: Artifact[];
}

/**
 * Derive suggested prompts for the current chat state.
 * Empty thread → starter prompts; active conversation → contextual follow-ups.
 */
export function deriveSuggestedPrompts({ turns, artifacts }: SuggestedPromptContext): SuggestedPrompt[] {
  if (turns.length === 0) {
    return [...STARTER_SUGGESTED_PROMPTS];
  }

  const lastUser = lastTurn(turns, 'user');
  const lastAssistant = lastTurn(turns, 'assistant');
  const recentArtifactId = resolveRecentDocumentArtifactId(turns, artifacts);
  const recentArtifact = recentArtifactId
    ? artifacts.find((a) => a.id === recentArtifactId)
    : undefined;

  if (recentArtifact) {
    return takeUpTo(artifactEditFollowUps(recentArtifact));
  }

  if (lastUser && looksLikeArtifactCreationRequest(lastUser.content)) {
    return takeUpTo(CREATION_RETRY_FOLLOW_UPS);
  }

  if (lastAssistant && looksLikeInformationalQuestion(lastUser?.content ?? '')) {
    return takeUpTo(INFORMATIONAL_FOLLOW_UPS);
  }

  if (lastAssistant && lastAssistant.content.trim().length > 80) {
    return takeUpTo(INFORMATIONAL_FOLLOW_UPS);
  }

  return takeUpTo(GENERIC_FOLLOW_UPS);
}
