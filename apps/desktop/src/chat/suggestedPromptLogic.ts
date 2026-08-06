import type { Artifact } from '../ipc/contracts';
import { looksLikeArtifactCreationRequest } from './artifactPrompt';
import { resolveRecentDocumentArtifactId } from './artifactFollowUpContext';
import { looksLikeInformationalQuestion } from './documentTurnIntent';
import type { ChatTurn } from './conversationHydration';
import type { SuggestedPrompt } from './suggestedPromptData';

export type { SuggestedPrompt } from './suggestedPromptData';

const MAX_SUGGESTIONS = 4;

/** Generic follow-ups when no stronger signal is present. */
const GENERIC_FOLLOW_UPS: readonly SuggestedPrompt[] = [
  {
    id: 'followup-summarize',
    text: 'Summarize the key points from your last reply in a short bullet list.',
    short: 'Summarize the key points',
  },
  {
    id: 'followup-clarify',
    text: 'What assumptions did you make, and what should I clarify?',
    short: 'What assumptions did you make?',
  },
  {
    id: 'followup-next',
    text: 'What are the concrete next steps I should take based on this?',
    short: 'Next steps',
  },
  {
    id: 'followup-markdown',
    text: 'Turn your last reply into a markdown artifact I can promote.',
    short: 'Turn this into an artifact',
  },
];

/** Suggestions when a document artifact is in scope. */
function artifactEditFollowUps(artifact: Artifact | undefined): SuggestedPrompt[] {
  const title = artifact?.title?.trim();
  const kind = artifact?.kind ?? 'document';
  const subject = title ? `"${title}"` : `the ${kind} artifact`;
  return [
    // The chip captions deliberately omit `subject`: the artifact is already
    // named on the card directly above these chips, and repeating a long
    // quoted title in every chip is what made them unreadable.
    {
      id: 'artifact-edit-improve',
      text: `Improve ${subject} — tighten the wording and fix any gaps.`,
      short: 'Tighten the wording',
    },
    {
      id: 'artifact-edit-style',
      text: `Update ${subject} with a cleaner layout and better visual hierarchy.`,
      short: 'Clean up the layout',
    },
    {
      id: 'artifact-edit-section',
      text: `Add a new section to ${subject} that covers edge cases and examples.`,
      short: 'Add a section',
    },
    {
      id: 'artifact-edit-convert',
      text: `Convert ${subject} to a different format while keeping the same content.`,
      short: 'Convert the format',
    },
  ];
}

/** Suggestions when the last assistant reply was explanatory. */
const INFORMATIONAL_FOLLOW_UPS: readonly SuggestedPrompt[] = [
  {
    id: 'info-summarize',
    text: 'Summarize your explanation in three bullet points.',
    short: 'Summarize in three points',
  },
  {
    id: 'info-action-items',
    text: 'Extract actionable next steps from your last reply.',
    short: 'Extract action items',
  },
  {
    id: 'info-markdown',
    text: 'Turn your last reply into a markdown artifact I can promote.',
    short: 'Turn this into an artifact',
  },
  {
    id: 'info-example',
    text: 'Show a concrete example that illustrates what you just explained.',
    short: 'Show an example',
  },
];

/** Suggestions when the user asked for creation but no artifact exists yet. */
const CREATION_RETRY_FOLLOW_UPS: readonly SuggestedPrompt[] = [
  {
    id: 'create-retry-html',
    text: 'Create a new HTML artifact with the full page in a ```html fence.',
    short: 'As HTML',
  },
  {
    id: 'create-retry-markdown',
    text: 'Create a new markdown artifact with the full document in a ```markdown fence.',
    short: 'As markdown',
  },
  {
    id: 'create-retry-json',
    text: 'Create a new JSON artifact with the schema in a ```json fence.',
    short: 'As JSON',
  },
  {
    id: 'create-retry-outline',
    text: 'Outline the artifact structure first, then generate the full content.',
    short: 'Outline it first',
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
 * Derive contextual follow-up suggestions for the current chat state.
 *
 * An empty thread has none: it shows a greeting and the composer, and the
 * starter prompt cards that used to fill it were removed with the rest of the
 * empty-state furniture (§10).
 */
export function deriveSuggestedPrompts({ turns, artifacts }: SuggestedPromptContext): SuggestedPrompt[] {
  if (turns.length === 0) {
    return [];
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
