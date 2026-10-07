/// The workflow editor's model pickers: the workflow's default ("Follow the
/// chat model" or a provider + model) and a summarize/agent step's own override
/// ("Use the workflow's model" or a provider + model). Both are the mini-apps'
/// `SlotRow`; nothing is written to the definition for the default choice.

import { createContext, useContext, type ReactNode } from 'react';
import { useT } from '../i18n';
import { SlotRow, useProviderModels, type ProviderModels } from '../apps/ModelSlotRow';
import type { AppModelChoice, WorkflowModel } from '../ipc/contracts';

/// Provider data is loaded once per editor, not per step card.
export const ProviderModelsContext = createContext<ProviderModels | null>(null);

export function ProviderModelsProvider({ children }: { children: ReactNode }) {
  const value = useProviderModels();
  return <ProviderModelsContext.Provider value={value}>{children}</ProviderModelsContext.Provider>;
}

function toChoice(model: WorkflowModel | undefined): AppModelChoice | null {
  return model ? { providerId: model.provider, model: model.model } : null;
}

export function WorkflowModelRow({
  kind,
  idPrefix,
  model,
  onChange,
}: {
  /** `workflow`: the default for the whole workflow; `step`: one step's own. */
  kind: 'workflow' | 'step';
  idPrefix: string;
  model: WorkflowModel | undefined;
  onChange: (model: WorkflowModel | null) => void;
}) {
  const t = useT();
  const ctx = useContext(ProviderModelsContext);
  if (!ctx) return null;
  const { configured, providerName, pickable, modelsByProvider, ensureModels } = ctx;
  const choice = toChoice(model);
  // A saved choice whose provider is no longer set up stays visible, saying so.
  const stale = choice && configured !== null && !configured.has(choice.providerId);
  const note = stale
    ? t('workspace.workflows.model.notSetUp', { model: choice.model, provider: providerName(choice.providerId) })
    : null;

  return (
    <SlotRow
      slot={kind}
      idPrefix={idPrefix}
      label={kind === 'workflow' ? t('workspace.workflows.model.label') : t('workspace.workflows.model.stepLabel')}
      followLabel={kind === 'workflow' ? t('workspace.workflows.model.followChat') : t('workspace.workflows.model.followWorkflow')}
      choice={choice}
      providers={pickable(choice)}
      modelsByProvider={modelsByProvider}
      ensureModels={ensureModels}
      disabled={false}
      note={note}
      onChange={(_slot, next) => onChange(next ? { provider: next.providerId, model: next.model } : null)}
    />
  );
}
