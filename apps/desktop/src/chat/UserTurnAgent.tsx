import { AgentsIcon } from '../icons';
import { useT } from '../i18n';

/** Read-only chip on a user message that was sent to one of the user's agents. */
export function UserTurnAgent({ agent }: { agent: { id: string; name: string } }) {
  const t = useT();
  return (
    <div>
      <span className="turn-agent-chip" title={t('chat.composer.agents.turnTitle', { name: agent.name })}>
        <AgentsIcon />
        {agent.name}
      </span>
    </div>
  );
}
