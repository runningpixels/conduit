import type { Translate } from '../i18n';
import type { AssistantStreamState } from './streamState';

type AgentPhase = NonNullable<AssistantStreamState['agentPhase']>;

/**
 * The agent loop (`stream_manager.rs`) names each phase in English —
 * "Thinking", "Running 2 tools", "Writing the next section" — and those
 * labels used to reach the screen as sent, in every language. The backend
 * keeps sending them (the chat view also matches on one), and this reads
 * each known one in the reader's language. An unknown label is shown as
 * sent.
 */
export function localizeAgentPhase(phase: AgentPhase, t: Translate): AgentPhase {
  const label = phaseLabel(phase.label, t);
  return label === phase.label ? phase : { ...phase, label };
}

function phaseLabel(label: string, t: Translate): string {
  switch (label) {
    case 'Thinking':
      return t('chat.view.agentPhase.thinking');
    case 'Continuing':
      return t('chat.view.agentPhase.continuing');
    case 'Steering':
      return t('chat.view.agentPhase.steering');
    case 'Reviewing results':
      return t('chat.view.agentPhase.reviewing');
    case 'Retrying in parts':
      return t('chat.view.agentPhase.retryingInParts');
    case 'Retrying with less thinking':
      return t('chat.view.agentPhase.retryingLessThinking');
    case 'Writing the next section':
      return t('chat.view.agentPhase.writingNextSection');
    default: {
      const running = /^Running (\d+) tools?$/.exec(label);
      return running ? t('chat.view.agentPhase.runningTools', { count: Number(running[1]) }) : label;
    }
  }
}
