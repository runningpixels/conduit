import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentSection } from './AgentSection';
import type { AppSettings } from '../../ipc/contracts';

function settingsWith(agent: AppSettings['agent']): AppSettings {
  return { agent } as AppSettings;
}

describe('AgentSection finish-after-document-write toggle', () => {
  it('is on when the setting has never been saved', () => {
    render(<AgentSection settings={settingsWith({ maxSteps: 25, wallClockBudgetSecs: 300 })} onUpdate={vi.fn()} onStatus={vi.fn()} />);
    expect(screen.getByLabelText(/Finish after writing a document/)).toBeChecked();
  });

  it('saves the choice with the other guardrails', () => {
    const onUpdate = vi.fn();
    render(<AgentSection settings={settingsWith({ maxSteps: 25, wallClockBudgetSecs: 300 })} onUpdate={onUpdate} onStatus={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/Finish after writing a document/));
    expect(onUpdate).toHaveBeenCalledWith({
      agent: { maxSteps: 25, wallClockBudgetSecs: 300, finishAfterDocumentWrite: false },
    });
  });
});
