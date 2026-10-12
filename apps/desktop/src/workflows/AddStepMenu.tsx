/// "Add a step": a button that opens a menu of every step kind in four groups
/// ("Get information", "Work with the model", ...). Used over the canvas and
/// above the step list. `nested` limits the kinds to what a loop can hold.

import { useRef, useState } from 'react';
import { useT } from '../i18n';
import { Menu } from '../workspace/Menu';
import { stepTypesFor, type StepType } from './editorModel';
import { STEP_TYPE_KEY } from './stepTypes';

const GROUPS: readonly { key: string; types: readonly StepType[] }[] = [
  {
    key: 'workspace.workflows.editor.addMenu.get',
    types: ['fetch_page', 'web_search', 'research', 'read_file', 'search_documents', 'connector_tool'],
  },
  {
    key: 'workspace.workflows.editor.addMenu.model',
    types: ['summarize', 'agent', 'template', 'parse_data'],
  },
  {
    key: 'workspace.workflows.editor.addMenu.save',
    types: ['save_artifact', 'export_file', 'edit_deck', 'edit_draft', 'save_memory', 'notify'],
  },
  {
    key: 'workspace.workflows.editor.addMenu.flow',
    types: ['for_each', 'condition', 'ask'],
  },
];

export function AddStepMenu({
  nested,
  where,
  onPick,
}: {
  nested: boolean;
  /** Where the step will go, in words ("Add after fetch"). */
  where: string;
  onPick: (type: StepType) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const allowed = stepTypesFor(nested);
  const close = () => setOpen(false);

  return (
    <div className="wfe-add">
      <button ref={button} type="button" className="btn primary wfe-add-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span aria-hidden="true">+ </span>
        {t('workspace.workflows.canvas.paletteLabel')}
      </button>
      <Menu open={open} onClose={close} triggerRef={button} className="wfe-menu" label={t('workspace.workflows.canvas.paletteLabel')} dismissOnOutsidePress>
        <p className="wfe-menu-where">{where}</p>
        <div className="wfe-menu-groups">
          {GROUPS.map((group) => {
            const types = group.types.filter((type) => allowed.includes(type));
            if (types.length === 0) return null;
            return (
              <div key={group.key} className="wfe-menu-group" role="group" aria-label={t(group.key)}>
                <div className="wfe-menu-heading" aria-hidden="true">
                  {t(group.key)}
                </div>
                {types.map((type) => (
                  <button
                    key={type}
                    type="button"
                    role="menuitem"
                    className="wfe-menu-item"
                    onClick={() => {
                      onPick(type);
                      close();
                    }}
                  >
                    {t(STEP_TYPE_KEY[type])}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </Menu>
    </div>
  );
}

/// The Canvas / List switch, drawn over the canvas and above the list.
export function ViewToggle({ view, onChoose }: { view: 'canvas' | 'list'; onChoose: (next: 'canvas' | 'list') => void }) {
  const t = useT();
  return (
    <div className="wf-view-toggle" role="group" aria-label={t('workspace.workflows.canvas.viewLabel')}>
      <button type="button" className={`wf-view-btn${view === 'canvas' ? ' active' : ''}`} aria-pressed={view === 'canvas'} onClick={() => onChoose('canvas')}>
        {t('workspace.workflows.canvas.viewCanvas')}
      </button>
      <button type="button" className={`wf-view-btn${view === 'list' ? ' active' : ''}`} aria-pressed={view === 'list'} onClick={() => onChoose('list')}>
        {t('workspace.workflows.canvas.viewList')}
      </button>
    </div>
  );
}
