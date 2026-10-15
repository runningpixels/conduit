/// The "Use the computer" checkbox on an agent step or helper: adds or removes
/// the `computer` entry in its tools. With no workflow folder yet, a hint says
/// where to set one, because the agent works only inside that folder.

import { useT } from '../i18n';
import { COMPUTER_TOOL, withComputerTool } from './editorModel';

export function ComputerToolOption({
  tools,
  hasFolder,
  onChange,
}: {
  tools: readonly string[];
  hasFolder: boolean;
  onChange: (tools: string[]) => void;
}) {
  const t = useT();
  const on = tools.includes(COMPUTER_TOOL);
  return (
    <div className="wf-computer-option">
      <label className="wf-check">
        <input type="checkbox" checked={on} onChange={(e) => onChange(withComputerTool(tools, e.target.checked))} />
        {t('workspace.workflows.editor.agent.computer')}
      </label>
      {on && !hasFolder ? <p className="wf-muted">{t('workspace.workflows.editor.agent.computerNoFolder')}</p> : null}
    </div>
  );
}
