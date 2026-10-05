/// One app's Settings page (docs/private/app-settings-contract.md): which model
/// answers, what the app has used, what it stores, what it may reach, and a
/// short log of what it did. It replaces the app's page area while open; the
/// app's frame stays mounted behind it (AppView hides it), so nothing the app
/// is doing is lost by looking at its settings.
///
/// Everything here is read from Rust by app id; Rust owns every limit, so the
/// checks in this file (the limit's range, the empty model id) are only there
/// to save a round trip.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useT, type Translate } from '../i18n';
import { useFormatters, type Formatters } from '../i18n/formatters';
import { withTimeout } from '../chat/ComposerModelPicker';
import { ChevronLeft, DownloadIcon, FilesIcon, GlobeIcon, ModelIcon, TrashIcon } from '../icons';
import {
  appPrincipal,
  exportAppDataDialog,
  getAppSettings,
  getSettings,
  listAppActivity,
  listPageLlmGrants,
  listConfiguredProviders,
  listProviderDescriptors,
  listProviderModels,
  pageStorageEntries,
  revokePageLlmProvider,
  setAppDailyTokenCap,
  setAppModelSlot,
} from '../ipc/client';
import type {
  AppActivityEntry,
  AppLlmSlot,
  AppModelChoice,
  AppSettingsView as AppSettingsData,
  ModelInfo,
  PageLlmProviderGrant,
  PageStorageEntry,
  ProviderDescriptor,
} from '../ipc/contracts';

export const MIN_DAILY_TOKEN_CAP = 1_000;
export const MAX_DAILY_TOKEN_CAP = 10_000_000;
const MODEL_FETCH_TIMEOUT_MS = 2500;

export interface AppSettingsSite {
  origin: string;
  /** `session`: only until Conduit quits. */
  scope: 'page' | 'session';
}

export interface AppSettingsViewProps {
  appId: string;
  appName: string;
  /** Sites the app may reach now, as the network hook reports them. */
  sites: AppSettingsSite[];
  siteLabel: (origin: string) => string;
  onRevokeSite: (origin: string) => Promise<void> | void;
  /** Called after a model provider's access was revoked, so the frame's
   *  consent state is re-read. */
  onLlmRevoked: () => void;
  /** Opens the existing "Clear data" confirmation. */
  onClearData: () => void;
  /** Changes when the app's data changes (a write, "Clear data"). */
  dataRevision: number;
  onStatus?: (message: string) => void;
  onBack: () => void;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `invalid: message` style Rust errors, shown without the code. */
function plainError(e: unknown): string {
  const text = errorText(e);
  const at = text.indexOf(': ');
  return at > 0 && /^[a-z_]+$/.test(text.slice(0, at)) ? text.slice(at + 2) : text;
}

function dayLabel(day: string, locale: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString(locale, { weekday: 'short', day: 'numeric' });
}

function errorWords(code: string | null, t: Translate): string {
  switch (code) {
    case 'invalid':
    case 'quota':
    case 'unavailable':
    case 'timeout':
      return t(`apps.settings.error.${code}`);
    case 'rate_limited':
      return t('apps.settings.error.rateLimited');
    case 'not_granted':
      return t('apps.settings.error.notGranted');
    default:
      return t('apps.settings.error.other');
  }
}

function hostOf(origin: string | null): string {
  if (!origin) return '';
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function activityText(
  entry: AppActivityEntry,
  t: Translate,
  fmt: Formatters,
  providerName: (id: string) => string,
): string {
  if (entry.kind === 'storage') {
    return t('apps.settings.activity.storage', { count: entry.count });
  }
  if (entry.kind === 'fetch') {
    const result =
      entry.status != null && entry.ok ? String(entry.status) : entry.error ? errorWords(entry.error, t) : entry.status != null ? String(entry.status) : t('apps.settings.error.other');
    return t('apps.settings.activity.fetch', {
      method: entry.method ?? 'GET',
      host: hostOf(entry.host),
      result,
    });
  }
  const label =
    entry.providerId && entry.model
      ? `${providerName(entry.providerId)} · ${entry.model}`
      : t('apps.settings.activity.kind.model');
  if (!entry.ok) {
    return t('apps.settings.activity.modelFailed', { model: label, reason: errorWords(entry.error, t) });
  }
  const tokens = (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0);
  return tokens > 0
    ? t('apps.settings.activity.modelTokens', { model: label, tokens: fmt.count(tokens) })
    : label;
}

export function AppSettingsView({
  appId,
  appName,
  sites,
  siteLabel,
  onRevokeSite,
  onLlmRevoked,
  onClearData,
  dataRevision,
  onStatus,
  onBack,
}: AppSettingsViewProps) {
  const t = useT();
  const fmt = useFormatters();
  const principal = useMemo(() => appPrincipal(appId), [appId]);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const [settings, setSettings] = useState<AppSettingsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entries, setEntries] = useState<PageStorageEntry[] | null>(null);
  const [activity, setActivity] = useState<AppActivityEntry[] | null>(null);
  const [grants, setGrants] = useState<PageLlmProviderGrant[] | null>(null);
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  // Ids Rust can use right now; the slot pickers offer only these.
  const [configured, setConfigured] = useState<ReadonlySet<string> | null>(null);
  const [active, setActive] = useState<{ providerId: string; model: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Model, usage and limit. Re-read when the app's data moves too: a model
  // call the page just made changes today's total.
  useEffect(() => {
    let cancelled = false;
    getAppSettings(appId)
      .then((view) => {
        if (!cancelled) {
          setSettings(view);
          setLoadError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setLoadError(plainError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [appId, dataRevision]);

  useEffect(() => {
    let cancelled = false;
    pageStorageEntries(principal)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    listAppActivity(appId)
      .then((rows) => {
        if (!cancelled) setActivity(rows);
      })
      .catch(() => {
        if (!cancelled) setActivity([]);
      });
    return () => {
      cancelled = true;
    };
  }, [appId, principal, dataRevision]);

  const loadGrants = useCallback(async () => {
    try {
      setGrants(await listPageLlmGrants(principal));
    } catch {
      setGrants([]);
    }
  }, [principal]);
  useEffect(() => {
    void loadGrants();
  }, [loadGrants, dataRevision]);

  // Every provider (for names), which of them are set up (for the pickers:
  // the same check set_app_model_slot applies), and the active model for the
  // "follow" labels.
  useEffect(() => {
    let cancelled = false;
    listProviderDescriptors()
      .then((list) => {
        if (!cancelled) setProviders(list);
      })
      .catch(() => {});
    listConfiguredProviders()
      .then((ids) => {
        if (!cancelled) setConfigured(new Set(ids));
      })
      .catch(() => {
        if (!cancelled) setConfigured(new Set());
      });
    getSettings()
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
  // A slot's current provider stays listed even if it is no longer set up,
  // so the row can show what it is mapped to.
  const pickable = (choice: AppModelChoice | null | undefined) =>
    providers.filter((p) => configured?.has(p.id) || p.id === choice?.providerId);

  // Models per provider, fetched on demand with the picker's per-provider
  // timeout so an unreachable endpoint costs only its own row.
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelInfo[]>>({});
  const requestedRef = useRef<Set<string>>(new Set());
  const ensureModels = useCallback(async (providerId: string): Promise<ModelInfo[]> => {
    if (requestedRef.current.has(providerId)) return [];
    requestedRef.current.add(providerId);
    const models = await withTimeout(listProviderModels(providerId), MODEL_FETCH_TIMEOUT_MS, [] as ModelInfo[]);
    setModelsByProvider((prev) => ({ ...prev, [providerId]: models }));
    return models;
  }, []);

  const changeSlot = useCallback(
    async (slot: AppLlmSlot, choice: AppModelChoice | null) => {
      try {
        setSettings(await setAppModelSlot(appId, slot, choice));
        setNotice(null);
      } catch (e) {
        setNotice(plainError(e));
      }
    },
    [appId],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    onBack();
  };

  const activeLabel = active ? `${providerName(active.providerId)} · ${active.model}` : '';
  const mainChoice = settings?.slots.default ?? null;
  const mainLabel = mainChoice ? `${providerName(mainChoice.providerId)} · ${mainChoice.model}` : activeLabel;

  return (
    <section className="app-settings" aria-labelledby={`app-settings-title-${appId}`} onKeyDown={handleKeyDown}>
      <div className="app-settings-inner">
        <header className="app-settings-head">
          <button type="button" className="btn ghost app-view-back" onClick={onBack}>
            <ChevronLeft />
            {t('apps.settings.back')}
          </button>
          <h2 id={`app-settings-title-${appId}`} ref={headingRef} tabIndex={-1} className="app-settings-title">
            {t('apps.settings.title', { name: appName })}
          </h2>
        </header>

        {loadError && (
          <p className="app-settings-error" role="alert">
            {loadError}
          </p>
        )}
        {notice && (
          <p className="app-settings-error" role="alert">
            {notice}
          </p>
        )}

        {/* ── Model ─────────────────────────────────────────────── */}
        <section className="app-settings-section" aria-labelledby="app-settings-model">
          <h3 id="app-settings-model">{t('apps.settings.model.title')}</h3>
          <p className="app-settings-hint">{t('apps.settings.model.hint')}</p>
          {configured !== null && configured.size === 0 && settings ? (
            <p className="app-settings-empty">{t('apps.settings.model.noProviders')}</p>
          ) : (
            <>
              <SlotRow
                slot="default"
                label={t('apps.settings.model.main')}
                followLabel={t('apps.settings.model.followActive', { model: activeLabel })}
                choice={settings?.slots.default ?? null}
                providers={pickable(settings?.slots.default)}
                modelsByProvider={modelsByProvider}
                ensureModels={ensureModels}
                disabled={!settings}
                onChange={changeSlot}
              />
              <SlotRow
                slot="quick"
                label={t('apps.settings.model.quick')}
                followLabel={t('apps.settings.model.followMain', { model: mainLabel })}
                choice={settings?.slots.quick ?? null}
                providers={pickable(settings?.slots.quick)}
                modelsByProvider={modelsByProvider}
                ensureModels={ensureModels}
                disabled={!settings}
                onChange={changeSlot}
              />
            </>
          )}
        </section>

        {/* ── Usage ─────────────────────────────────────────────── */}
        <UsageSection
          settings={settings}
          onSetCap={async (cap) => {
            try {
              setSettings(await setAppDailyTokenCap(appId, cap));
              setNotice(null);
              return null;
            } catch (e) {
              return plainError(e);
            }
          }}
        />

        {/* ── Data ──────────────────────────────────────────────── */}
        <section className="app-settings-section" aria-labelledby="app-settings-data">
          <h3 id="app-settings-data">{t('apps.settings.data.title')}</h3>
          {entries === null ? (
            <p className="app-settings-empty" aria-busy="true">
              {t('apps.settings.loading')}
            </p>
          ) : entries.length === 0 ? (
            <p className="app-settings-empty">{t('apps.settings.data.empty')}</p>
          ) : (
            <>
              <p className="app-settings-summary">
                {t('apps.settings.data.summary', {
                  size: fmt.size(entries.reduce((sum, e) => sum + e.bytes, 0)),
                  count: entries.length,
                })}
              </p>
              <ul className="app-settings-list" aria-label={t('apps.settings.data.listLabel')}>
                {entries.map((entry) => (
                  <li key={entry.key} className="app-settings-row">
                    <code className="app-settings-key" title={entry.key}>
                      {entry.key}
                    </code>
                    <span className="app-settings-meta">
                      {t('apps.settings.data.keyMeta', {
                        size: fmt.size(entry.bytes),
                        when: fmt.timeAgo(entry.updatedAt),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="app-settings-actions">
            <button
              type="button"
              className="btn"
              onClick={async () => {
                try {
                  const path = await exportAppDataDialog(appId);
                  if (path) onStatus?.(t('apps.settings.data.exported', { path }));
                } catch (e) {
                  setNotice(plainError(e));
                }
              }}
            >
              <DownloadIcon />
              {t('apps.settings.data.export')}
            </button>
            <button type="button" className="btn" onClick={onClearData} disabled={entries !== null && entries.length === 0}>
              <TrashIcon />
              {t('apps.settings.data.clear')}
            </button>
          </div>
        </section>

        {/* ── Permissions ───────────────────────────────────────── */}
        <section className="app-settings-section" aria-labelledby="app-settings-permissions">
          <h3 id="app-settings-permissions">{t('apps.settings.permissions.title')}</h3>
          <h4>{t('apps.settings.permissions.sites')}</h4>
          {sites.length === 0 ? (
            <p className="app-settings-empty">{t('apps.settings.permissions.sitesEmpty')}</p>
          ) : (
            <ul className="app-settings-list">
              {sites.map((site) => (
                <li key={site.origin} className="app-settings-row">
                  <span className="app-settings-key">{siteLabel(site.origin)}</span>
                  {site.scope === 'session' && (
                    <span className="app-settings-meta">{t('apps.settings.permissions.session')}</span>
                  )}
                  <button
                    type="button"
                    className="btn ghost"
                    aria-label={t('apps.settings.permissions.revokeSite', { site: siteLabel(site.origin) })}
                    onClick={() => void onRevokeSite(site.origin)}
                  >
                    {t('apps.settings.permissions.revoke')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h4>{t('apps.settings.permissions.models')}</h4>
          {grants === null || grants.length === 0 ? (
            <p className="app-settings-empty">{t('apps.settings.permissions.modelsEmpty')}</p>
          ) : (
            <ul className="app-settings-list">
              {grants.map((grant) => (
                <li key={grant.providerId} className="app-settings-row">
                  <span className="app-settings-key">{grant.providerName}</span>
                  <span className="app-settings-meta">
                    {grant.isLocal ? t('apps.settings.permissions.local') : t('apps.settings.permissions.cloud')}
                  </span>
                  <button
                    type="button"
                    className="btn ghost"
                    aria-label={t('apps.settings.permissions.revokeModel', { provider: grant.providerName })}
                    onClick={async () => {
                      try {
                        await revokePageLlmProvider(principal, grant.providerId);
                        await loadGrants();
                        onLlmRevoked();
                      } catch (e) {
                        setNotice(plainError(e));
                      }
                    }}
                  >
                    {t('apps.settings.permissions.revoke')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Activity ──────────────────────────────────────────── */}
        <section className="app-settings-section" aria-labelledby="app-settings-activity">
          <h3 id="app-settings-activity">{t('apps.settings.activity.title')}</h3>
          <p className="app-settings-hint">{t('apps.settings.activity.hint')}</p>
          {activity === null ? (
            <p className="app-settings-empty" aria-busy="true">
              {t('apps.settings.loading')}
            </p>
          ) : activity.length === 0 ? (
            <p className="app-settings-empty">{t('apps.settings.activity.empty')}</p>
          ) : (
            <ul className="app-settings-list app-settings-activity">
              {activity.map((entry, i) => (
                <li key={`${entry.at}:${entry.kind}:${i}`} className="app-settings-row" data-ok={entry.ok}>
                  <time className="app-settings-when" dateTime={entry.at} title={new Date(entry.at).toLocaleString(fmt.locale)}>
                    {fmt.timeAgo(entry.at)}
                  </time>
                  <span
                    className="app-settings-kind"
                    role="img"
                    aria-label={t(`apps.settings.activity.kind.${entry.kind}`)}
                  >
                    {entry.kind === 'model' ? <ModelIcon /> : entry.kind === 'fetch' ? <GlobeIcon /> : <FilesIcon />}
                  </span>
                  <span className="app-settings-text">{activityText(entry, t, fmt, providerName)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}

// ── Model rows ───────────────────────────────────────────────────────────

function SlotRow({
  slot,
  label,
  followLabel,
  choice,
  providers,
  modelsByProvider,
  ensureModels,
  disabled,
  onChange,
}: {
  slot: AppLlmSlot;
  label: string;
  followLabel: string;
  choice: AppModelChoice | null;
  providers: ProviderDescriptor[];
  modelsByProvider: Record<string, ModelInfo[]>;
  ensureModels: (providerId: string) => Promise<ModelInfo[]>;
  disabled: boolean;
  onChange: (slot: AppLlmSlot, choice: AppModelChoice | null) => Promise<void>;
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

  const modelOptions = models ?? [];
  const current = choice && choice.providerId === providerId ? choice.model : '';
  const typedModel = draftModel ?? current;
  const showSelect = providerId !== '' && modelOptions.length > 0;
  const providerLabelId = `app-settings-${slot}-provider`;
  const modelLabelId = `app-settings-${slot}-model`;

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
    </div>
  );
}

// ── Usage ────────────────────────────────────────────────────────────────

function UsageSection({
  settings,
  onSetCap,
}: {
  settings: AppSettingsData | null;
  onSetCap: (cap: number | null) => Promise<string | null>;
}) {
  const t = useT();
  const fmt = useFormatters();
  const limit = settings ? (settings.dailyTokenCap ?? settings.defaultDailyTokenCap) : 0;
  const [draft, setDraft] = useState('');
  const [capError, setCapError] = useState<string | null>(null);
  // Reset the field only when the saved limit changes. Keyed on the settings
  // object, a reload of unchanged settings (usage refreshes, for one) landing
  // just after the user typed threw the typed value away.
  const savedCap = settings ? (settings.dailyTokenCap ?? settings.defaultDailyTokenCap) : null;
  useEffect(() => {
    if (savedCap !== null) setDraft(String(savedCap));
  }, [savedCap]);

  const range = { min: fmt.count(MIN_DAILY_TOKEN_CAP), max: fmt.count(MAX_DAILY_TOKEN_CAP) };
  const save = async () => {
    const value = Number(draft.trim().replace(/[,_\s]/g, ''));
    if (!Number.isInteger(value) || value < MIN_DAILY_TOKEN_CAP || value > MAX_DAILY_TOKEN_CAP) {
      setCapError(t('apps.settings.usage.capInvalid', range));
      return;
    }
    setCapError(await onSetCap(value));
  };

  const days = settings?.usage ?? [];
  const peak = Math.max(1, ...days.map((d) => d.inputTokens + d.outputTokens));
  const anyUse = days.some((d) => d.calls > 0 || d.inputTokens + d.outputTokens > 0);
  const used = settings?.cloudTokensToday ?? 0;

  return (
    <section className="app-settings-section" aria-labelledby="app-settings-usage">
      <h3 id="app-settings-usage">{t('apps.settings.usage.title')}</h3>
      {!settings ? (
        <p className="app-settings-empty" aria-busy="true">
          {t('apps.settings.loading')}
        </p>
      ) : (
        <>
          <p className="app-settings-summary">
            {t('apps.settings.usage.today', { used: fmt.count(used), limit: fmt.count(limit) })}
          </p>
          <progress
            className="app-settings-meter"
            max={limit}
            value={Math.min(used, limit)}
            aria-label={t('apps.settings.usage.meterLabel')}
          />
          <p className="app-settings-hint">{t('apps.settings.usage.localNote')}</p>

          <h4>{t('apps.settings.usage.week')}</h4>
          {anyUse ? (
            <ul className="app-settings-bars">
              {days.map((d) => {
                const total = d.inputTokens + d.outputTokens;
                return (
                  <li
                    key={d.day}
                    className="app-settings-bar"
                    aria-label={t('apps.settings.usage.dayLabel', {
                      day: dayLabel(d.day, fmt.locale),
                      tokens: fmt.count(total),
                      calls: d.calls,
                    })}
                  >
                    <span className="app-settings-bar-day">{dayLabel(d.day, fmt.locale)}</span>
                    <span className="app-settings-bar-track" aria-hidden="true">
                      <span className="app-settings-bar-fill" style={{ width: `${(total / peak) * 100}%` }} />
                    </span>
                    <span className="app-settings-bar-value" aria-hidden="true">
                      {fmt.compact(total)}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="app-settings-empty">{t('apps.settings.usage.empty')}</p>
          )}

          <form
            className="app-settings-cap"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label htmlFor="app-settings-cap-input">{t('apps.settings.usage.capLabel')}</label>
            <div className="app-settings-cap-row">
              <input
                id="app-settings-cap-input"
                type="text"
                inputMode="numeric"
                value={draft}
                aria-invalid={capError ? true : undefined}
                aria-describedby="app-settings-cap-help"
                onChange={(e) => {
                  setDraft(e.target.value);
                  setCapError(null);
                }}
              />
              <button type="submit" className="btn">
                {t('apps.settings.usage.capSave')}
              </button>
              {settings.dailyTokenCap !== null && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={async () => setCapError(await onSetCap(null))}
                >
                  {t('apps.settings.usage.capReset')}
                </button>
              )}
            </div>
            <small id="app-settings-cap-help" className="app-settings-hint">
              {t('apps.settings.usage.capHelp', { ...range, default: fmt.count(settings.defaultDailyTokenCap) })}
            </small>
            {capError && (
              <p className="app-settings-error" role="alert">
                {capError}
              </p>
            )}
          </form>
        </>
      )}
    </section>
  );
}
