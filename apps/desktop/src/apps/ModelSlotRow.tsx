/// The "follow the active model, or pick a provider and a model" row, shared by
/// a mini-app's Settings page and the workflow editor, and the hook that feeds
/// it (which providers are set up, each one's models).
///
/// Nothing is saved until there is a provider *and* a model: a provider with no
/// listed models asks for a typed model id.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { withTimeout } from '../chat/ComposerModelPicker';
import { sortModels } from '../lib/modelOrder';
import { getSettings, listConfiguredProviders, listProviderDescriptors, listProviderModels } from '../ipc/client';
import type { AppModelChoice, ModelInfo, ProviderDescriptor } from '../ipc/contracts';

const MODEL_FETCH_TIMEOUT_MS = 2500;

export interface ProviderModels {
  providers: ProviderDescriptor[];
  /** Ids Rust can use right now; null until known. */
  configured: ReadonlySet<string> | null;
  active: { providerId: string; model: string } | null;
  providerName: (id: string) => string;
  /** Set-up providers, plus `choice`'s own provider so a row can show what it
   *  is mapped to even when that provider is gone. */
  pickable: (choice: AppModelChoice | null | undefined) => ProviderDescriptor[];
  modelsByProvider: Record<string, ModelInfo[]>;
  ensureModels: (providerId: string) => Promise<ModelInfo[]>;
}

/// Every provider (for names), which of them are set up (for the pickers), the
/// active model (for the "follow" labels), and models per provider fetched on
/// demand with a per-provider timeout so an unreachable endpoint costs only its
/// own row.
export function useProviderModels(): ProviderModels {
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [configured, setConfigured] = useState<ReadonlySet<string> | null>(null);
  const [active, setActive] = useState<{ providerId: string; model: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    // `Promise.resolve().then` so a synchronous failure to reach Rust is
    // handled like an async one.
    Promise.resolve()
      .then(() => listProviderDescriptors())
      .then((list) => {
        if (!cancelled) setProviders(list);
      })
      .catch(() => {});
    Promise.resolve()
      .then(() => listConfiguredProviders())
      .then((ids) => {
        if (!cancelled) setConfigured(new Set(ids));
      })
      .catch(() => {
        if (!cancelled) setConfigured(new Set());
      });
    Promise.resolve()
      .then(() => getSettings())
      .then((s) => {
        if (!cancelled) setActive({ providerId: s.activeProvider, model: s.activeModel });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const providerName = useCallback(
    (id: string) => providers.find((p) => p.id === id)?.displayName ?? id,
    [providers],
  );
  const pickable = useCallback(
    (choice: AppModelChoice | null | undefined) =>
      providers.filter((p) => configured?.has(p.id) || p.id === choice?.providerId),
    [providers, configured],
  );

  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelInfo[]>>({});
  const requestedRef = useRef<Set<string>>(new Set());
  const ensureModels = useCallback(async (providerId: string): Promise<ModelInfo[]> => {
    if (requestedRef.current.has(providerId)) return [];
    requestedRef.current.add(providerId);
    const models = await withTimeout(listProviderModels(providerId), MODEL_FETCH_TIMEOUT_MS, [] as ModelInfo[]);
    setModelsByProvider((prev) => ({ ...prev, [providerId]: models }));
    return models;
  }, []);

  return { providers, configured, active, providerName, pickable, modelsByProvider, ensureModels };
}

export function SlotRow<S extends string>({
  slot,
  label,
  followLabel,
  choice,
  providers,
  modelsByProvider,
  ensureModels,
  disabled,
  onChange,
  idPrefix = 'app-settings',
  note,
}: {
  slot: S;
  label: string;
  followLabel: string;
  choice: AppModelChoice | null;
  providers: ProviderDescriptor[];
  modelsByProvider: Record<string, ModelInfo[]>;
  ensureModels: (providerId: string) => Promise<ModelInfo[]>;
  disabled: boolean;
  onChange: (slot: S, choice: AppModelChoice | null) => Promise<void> | void;
  /** Prefix for the controls' ids, so two rows on one page never clash. */
  idPrefix?: string;
  /** A short line under the controls (e.g. the saved provider isn't set up). */
  note?: string | null;
}) {
  const t = useT();
  const fmt = useFormatters();
  // A provider picked that has no listed models yet: the row asks for a model
  // id, since nothing is saved until there is a provider *and* a model.
  const [draftProvider, setDraftProvider] = useState<string | null>(null);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const providerId = draftProvider ?? choice?.providerId ?? '';
  const models = providerId ? modelsByProvider[providerId] : undefined;
  const sorted = useMemo(
    () => [...providers].sort((a, b) => a.tier - b.tier || fmt.compare(a.displayName, b.displayName)),
    [providers, fmt],
  );

  useEffect(() => {
    if (choice) void ensureModels(choice.providerId);
  }, [choice, ensureModels]);

  const onProvider = async (id: string) => {
    if (!id) {
      setDraftProvider(null);
      await onChange(slot, null);
      return;
    }
    setDraftProvider(id);
    setDraftModel(null);
    await ensureModels(id);
  };

  // Once the provider's models are known, a provider with a list gets its
  // first model straight away; one without a list waits for a typed id.
  useEffect(() => {
    if (draftProvider && models && models.length > 0) {
      setDraftProvider(null);
      void onChange(slot, { providerId: draftProvider, model: models[0].id });
    }
  }, [draftProvider, models, onChange, slot]);

  const modelOptions = sortModels(models ?? []);
  const current = choice && choice.providerId === providerId ? choice.model : '';
  const typedModel = draftModel ?? current;
  const showSelect = providerId !== '' && modelOptions.length > 0;
  const providerLabelId = `${idPrefix}-${slot}-provider`;
  const modelLabelId = `${idPrefix}-${slot}-model`;

  return (
    <div className="app-settings-slot" role="group" aria-label={label}>
      <span className="app-settings-slot-name">{label}</span>
      <div className="app-settings-slot-controls">
        <label className="sr-only" htmlFor={providerLabelId}>
          {t('apps.settings.model.providerLabel', { slot: label })}
        </label>
        <select
          id={providerLabelId}
          value={providerId}
          disabled={disabled}
          onChange={(e) => void onProvider(e.target.value)}
        >
          <option value="">{followLabel}</option>
          {sorted.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
        {providerId !== '' &&
          (showSelect ? (
            <>
              <label className="sr-only" htmlFor={modelLabelId}>
                {t('apps.settings.model.modelLabel', { slot: label })}
              </label>
              <select
                id={modelLabelId}
                value={current}
                disabled={disabled}
                onChange={(e) => void onChange(slot, { providerId, model: e.target.value })}
              >
                {current !== '' && !modelOptions.some((m) => m.id === current) && (
                  <option value={current}>{current}</option>
                )}
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName ?? m.id}
                  </option>
                ))}
              </select>
            </>
          ) : models === undefined ? (
            <span className="app-settings-meta">{t('apps.settings.model.loading')}</span>
          ) : (
            <form
              className="app-settings-modelid"
              onSubmit={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const model = typedModel.trim();
                if (!model) return;
                setDraftProvider(null);
                setDraftModel(null);
                void onChange(slot, { providerId, model });
              }}
            >
              <label className="sr-only" htmlFor={modelLabelId}>
                {t('apps.settings.model.modelLabel', { slot: label })}
              </label>
              <input
                id={modelLabelId}
                value={typedModel}
                maxLength={200}
                placeholder={t('apps.settings.model.modelIdPlaceholder')}
                onChange={(e) => {
                  setDraftModel(e.target.value);
                }}
              />
              <button type="submit" className="btn" disabled={!typedModel.trim()}>
                {t('apps.settings.model.use')}
              </button>
            </form>
          ))}
        {choice && (
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setDraftProvider(null);
              void onChange(slot, null);
            }}
          >
            {t('apps.settings.model.reset')}
          </button>
        )}
      </div>
      {note ? <span className="app-settings-meta">{note}</span> : null}
    </div>
  );
}
