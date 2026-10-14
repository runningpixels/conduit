import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { WorkflowActionRecord } from '../ipc/contracts';
import { StepActions, stepActions } from './StepActions';

const record = (over: Partial<WorkflowActionRecord>): WorkflowActionRecord => ({
  connector: { id: 'slack', name: 'Slack' },
  tool: 'post_message',
  arguments: { channel: '#general' },
  outcome: 'sent',
  ...over,
});

describe('StepActions', () => {
  it('reads a connector step action and an agent step action list', () => {
    expect(stepActions({ action: record({}) })).toHaveLength(1);
    expect(stepActions({ actions: [record({}), record({ outcome: 'failed' })] })).toHaveLength(2);
    expect(stepActions({ text: 'no actions' })).toEqual([]);
    expect(stepActions(null)).toEqual([]);
  });

  it('says what happened, one line per action, with the arguments to open', () => {
    render(
      <StepActions
        output={{
          actions: [
            record({}),
            record({ outcome: 'sentWithoutAsking' }),
            record({ outcome: 'notSent' }),
            record({ outcome: 'failed', error: 'Channel not found' }),
          ],
        }}
      />,
    );
    expect(screen.getByText('Sent “post_message” in Slack.')).toBeInTheDocument();
    expect(screen.getByText('Sent “post_message” in Slack without asking.')).toBeInTheDocument();
    expect(screen.getByText('Not sent: “post_message” in Slack.')).toBeInTheDocument();
    expect(screen.getByText(/“post_message” in Slack failed\. Channel not found/)).toBeInTheDocument();
    expect(screen.getAllByText(/#general/)).toHaveLength(4);
  });

  it('renders nothing for a step that did not act', () => {
    const { container } = render(<StepActions output={{ text: 'hi' }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
