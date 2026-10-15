/// The "Use the computer" checkbox on an agent step or helper: adds or removes
/// the `computer` entry in its tools. Once ticked, one line says where the
/// agent works and how it treats file changes, with a way to the Computer
/// settings; with no workflow folder yet it says so and offers to pick one,
/// because the agent works only inside that folder.

import { useState } from 'react';
import { useT } from '../i18n';
import { pickWorkspaceFolder } from '../ipc/client';
import type { WorkflowComputer } from '../ipc/contracts';
import { useEditorNav } from './EditorNav';
import { COMPUTER_TOOL, withComputerTool } from './editorModel';
import { folderName } from './WorkflowViewParts';

export function ComputerToolOption({
  tools,
  hasFolder,
  folder,
  computer,
  onChange,
}: {
  tools: readonly string[];
  hasFolder: boolean;
  /// The workflow's folder, for the summary line.
  folder?: string;
  /// The workflow's computer settings, for the summary line.
  computer?: WorkflowComputer;
  onChange: (tools: string[]) => void;
}) {
  const t = useT();
  const nav = useEditorNav();
  const onFolder = nav.setFolder;
  const [pickError, setPickError] = useState<string | null>(null);
  const on = tools.includes(COMPUTER_TOOL);
  const name = folderName(folder);
  const pick = async () => {
    setPickError(null);
    try {
      const picked = await pickWorkspaceFolder();
      if (picked) onFolder?.(picked);
    } catch (e) {
      setPickError(e instanceof Error && e.message ? e.message : t('workspace.workflows.folder.pickFailed'));
    }
  };
  return (
    <div className="wf-computer-option">
      <label className="wf-check">
        <input type="checkbox" checked={on} onChange={(e) => onChange(withComputerTool(tools, e.target.checked))} />
        {t('workspace.workflows.editor.agent.computer')}
      </label>
      {on && !hasFolder ? (
        <>
          <p className="wf-muted">{t('workspace.workflows.editor.agent.computerNoFolder')}</p>
          {onFolder ? (
            <button type="button" className="btn ghost wf-computer-link" onClick={() => void pick()}>
              {t('workspace.workflows.editor.agent.computerPick')}
            </button>
          ) : null}
          {pickError ? <p className="wf-error">{pickError}</p> : null}
        </>
      ) : null}
      {on && hasFolder && name ? (
        <p className="wf-muted wf-computer-summary">
          <span>
            {computer?.editMode === 'free'
              ? t('workspace.workflows.editor.agent.computerSummaryFree', { folder: name })
              : t('workspace.workflows.editor.agent.computerSummaryAsk', { folder: name })}
          </span>{' '}
          <button type="button" className="btn ghost wf-computer-link" onClick={nav.openComputerSettings}>
            {t('workspace.workflows.editor.agent.computerSettings')}
          </button>
        </p>
      ) : null}
    </div>
  );
}
