import { useCallback, useEffect, useState } from 'react';
import { getUsageSummary, updateSettings } from '../../ipc/client';
import type {
  AppSettings,
  ModelPrice,
  ModelPriceOverride,
  ProviderUsageBreakdown,
  ResolvedModelPrice,
  UsagePeriod,
  UsageSummaryResponse,
} from '../../ipc/contracts';
import { translateError } from '../../ipc/errors';
import { useT, type Translate } from '../../i18n';
import { providerDisplayName } from '../../lib/providerIdentity';
import { notifyModelPricesChanged } from '../../lib/useModelPrices';
import { useFormatters } from '../../i18n/formatters';
import {
  MAX_DAILY_SPEND_ALERT_USD,
  parseSpendAlertInput,
  spendAlertInputValue,
} from '../../lib/spendAlert';

interface UsageSectionProps {
  settings: AppSettings;
  /** Apply settings the backend has already persisted (no second save). */
  onSettingsChange: (s: AppSettings) => void;
  onStatus: (message: string) => void;
}

/** The ceiling `pricing::price_is_valid` enforces; a typo guard, not a rule. */
const MAX_PRICE_PER_MTOK = 10_000;

const cellStyle = { padding: '6px 8px' } as const;
const numberCell = { textAlign: 'right', padding: '6px 8px' } as const;

/** Parse one price field. Empty is `undefined` (allowed for cache prices only). */
function parsePrice(raw: string): number | undefined | 'invalid' {
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > MAX_PRICE_PER_MTOK) return 'invalid';
  return value;
}

interface PriceDraft {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

function draftFrom(price: ModelPrice | undefined): PriceDraft {
  const s = (v: number | undefined) => (v == null ? '' : String(v));
  return {
    input: s(price?.inputPerMtok),
    output: s(price?.outputPerMtok),
    cacheRead: s(price?.cacheReadPerMtok),
    cacheWrite: s(price?.cacheWritePerMtok),
  };
}

/** A complete, valid price from the draft, or null. */
function priceFrom(draft: PriceDraft): ModelPrice | null {
  const input = parsePrice(draft.input);
  const output = parsePrice(draft.output);
  const cacheRead = parsePrice(draft.cacheRead);
  const cacheWrite = parsePrice(draft.cacheWrite);
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  if (cacheRead === 'invalid' || cacheWrite === 'invalid') return null;
  return {
    inputPerMtok: input,
    outputPerMtok: output,
    ...(cacheRead != null ? { cacheReadPerMtok: cacheRead } : {}),
    ...(cacheWrite != null ? { cacheWritePerMtok: cacheWrite } : {}),
  };
}

function sourceLabel(price: ResolvedModelPrice, pricesAsOf: string, t: Translate): string {
  switch (price.source) {
    case 'override':
      return t('settings.usage.priceSource.override');
    case 'provider':
      return t('settings.usage.priceSource.provider');
    case 'snapshot':
      return t('settings.usage.priceSource.snapshot', { date: pricesAsOf });
    case 'retired':
      return t('settings.usage.priceSource.retired');
    case 'local':
      return t('settings.usage.priceSource.local');
  }
}

function PriceEditor({
  row,
  onSave,
  onRemove,
  onCancel,
}: {
  row: ProviderUsageBreakdown;
  onSave: (price: ModelPrice) => void;
  onRemove: (() => void) | null;
  onCancel: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(() => draftFrom(row.price?.price));
  const [invalid, setInvalid] = useState(false);
  const field = (key: keyof PriceDraft, labelId: string) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--fs-md)', color: 'var(--ink-2)' }}>
      {t(labelId)}
      <input
        type="text"
        inputMode="decimal"
        value={draft[key]}
        onChange={(e) => {
          setInvalid(false);
          setDraft({ ...draft, [key]: e.target.value });
        }}
        style={{
          width: 110,
          padding: '4px 6px',
          borderRadius: 'var(--r-sm)',
          border: '1px solid var(--line)',
          background: 'var(--card)',
          color: 'var(--ink)',
        }}
      />
    </label>
  );

  return (
    <form
      aria-label={t('settings.usage.editor.ariaLabel', { model: row.modelId })}
      onSubmit={(e) => {
        e.preventDefault();
        const price = priceFrom(draft);
        if (!price) {
          setInvalid(true);
          return;
        }
        onSave(price);
      }}
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12, padding: '8px 8px 12px' }}
    >
      {field('input', 'settings.usage.editor.input')}
      {field('output', 'settings.usage.editor.output')}
      {field('cacheRead', 'settings.usage.editor.cacheRead')}
      {field('cacheWrite', 'settings.usage.editor.cacheWrite')}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="btn">{t('settings.usage.editor.save')}</button>
        {onRemove && (
          <button type="button" className="btn ghost" onClick={onRemove}>
            {t('settings.usage.editor.remove')}
          </button>
        )}
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t('common.actions.cancel')}
        </button>
      </div>
      {invalid && (
        <p role="alert" style={{ width: '100%', margin: 0, fontSize: 'var(--fs-md)', color: 'var(--err)' }}>
          {t('settings.usage.editor.invalid')}
        </p>
      )}
    </form>
  );
}

/**
 * "Alert me when today's estimated spend passes $X". Empty is off. Saving
 * validates here first (the backend validates again) so a typo never reaches
 * the settings file.
 */
export function SpendAlertField({
  value,
  onSave,
}: {
  value: number | null | undefined;
  /** Persist the alert (`null` = off). Resolves false when the save failed. */
  onSave: (usd: number | null) => Promise<boolean>;
}) {
  const t = useT();
  const fmt = useFormatters();
  const [draft, setDraft] = useState(() => spendAlertInputValue(value));
  const [invalid, setInvalid] = useState(false);

  // Follow the saved value when it changes underneath the field.
  useEffect(() => {
    setDraft(spendAlertInputValue(value));
    setInvalid(false);
  }, [value]);

  return (
    <form
      aria-label={t('settings.usage.spendAlert.ariaLabel')}
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = parseSpendAlertInput(draft);
        if (parsed === 'invalid') {
          setInvalid(true);
          return;
        }
        void onSave(parsed);
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '4px 0 12px' }}
    >
      <label htmlFor="usage-spend-alert-input" style={{ fontSize: 'var(--fs-3xl)', color: 'var(--ink)' }}>
        {t('settings.usage.spendAlert.label')}
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span aria-hidden="true" style={{ color: 'var(--ink-2)' }}>
          $
        </span>
        <input
          id="usage-spend-alert-input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={draft}
          placeholder={t('settings.usage.spendAlert.placeholder')}
          aria-invalid={invalid ? true : undefined}
          aria-describedby="usage-spend-alert-help"
          onChange={(e) => {
            setInvalid(false);
            setDraft(e.target.value);
          }}
          style={{
            width: 110,
            padding: '4px 6px',
            borderRadius: 'var(--r-sm)',
            border: '1px solid var(--line)',
            background: 'var(--card)',
            color: 'var(--ink)',
          }}
        />
        <button type="submit" className="btn">
          {t('settings.usage.spendAlert.save')}
        </button>
        {value != null && (
          <button type="button" className="btn ghost" onClick={() => void onSave(null)}>
            {t('settings.usage.spendAlert.turnOff')}
          </button>
        )}
      </div>
      <small id="usage-spend-alert-help" style={{ fontSize: 'var(--fs-md)', color: 'var(--ink-3)' }}>
        {t('settings.usage.spendAlert.help')}
      </small>
      {invalid && (
        <p role="alert" style={{ margin: 0, fontSize: 'var(--fs-md)', color: 'var(--err)' }}>
          {t('settings.usage.spendAlert.invalid', {
            min: fmt.money(1),
            max: fmt.money(MAX_DAILY_SPEND_ALERT_USD * 100),
          })}
        </p>
      )}
    </form>
  );
}

export function UsageSection({ settings, onSettingsChange, onStatus }: UsageSectionProps) {
  const t = useT();
  const fmt = useFormatters();
  const formatCents = fmt.money;
  const formatTokens = fmt.compact;
  const [period, setPeriod] = useState<UsagePeriod>('thisMonth');
  const [data, setData] = useState<UsageSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setLoading(true);
    getUsageSummary(period)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [period, reload]);

  const overrides = settings.modelPriceOverrides ?? [];

  /** Persist a new override list, then re-price the table and every price tail. */
  const saveOverrides = useCallback(
    async (next: ModelPriceOverride[], message: string) => {
      try {
        const persisted = await updateSettings({ modelPriceOverrides: next });
        onSettingsChange(persisted);
        setEditing(null);
        setReload((n) => n + 1);
        notifyModelPricesChanged();
        onStatus(message);
      } catch (e) {
        onStatus(t('settings.autoSave.failed', { error: translateError(e, t) }));
      }
    },
    [onSettingsChange, onStatus, t],
  );

  const saveSpendAlert = useCallback(
    async (usd: number | null) => {
      try {
        const persisted = await updateSettings({ dailySpendAlertUsd: usd });
        onSettingsChange(persisted);
        const saved = persisted.dailySpendAlertUsd;
        onStatus(
          saved != null
            ? t('settings.usage.spendAlert.saved', { amount: formatCents(saved * 100) })
            : t('settings.usage.spendAlert.cleared'),
        );
        return true;
      } catch (e) {
        onStatus(t('settings.autoSave.failed', { error: translateError(e, t) }));
        return false;
      }
    },
    [onSettingsChange, onStatus, t, formatCents],
  );
  const spendAlert = <SpendAlertField value={settings.dailySpendAlertUsd} onSave={saveSpendAlert} />;

  if (loading && !data) {
    return (
      <div className="settings-section">
        <div className="settings-section-header">
          <span>{t('settings.usage.header')}</span>
        </div>
        <span className="status-pill hold">{t('common.status.loading')}</span>
      </div>
    );
  }

  if (!data || (data.totalInputTokens === 0 && data.totalOutputTokens === 0)) {
    return (
      <div className="settings-section">
        <div className="settings-section-header">
          <span>{t('settings.usage.header')}</span>
        </div>
        <p style={{ fontSize: 'var(--fs-3xl)', color: 'var(--ink-2)', padding: '12px 0' }}>
          {t('settings.usage.empty')}
        </p>
        {spendAlert}
      </div>
    );
  }

  const maxCost = Math.max(...data.dailyTotals.map((d) => d.costCents), 0.0001);
  const rowKey = (row: ProviderUsageBreakdown) => `${row.providerId}\u0000${row.modelId}`;
  const without = (row: ProviderUsageBreakdown) =>
    overrides.filter((o) => !(o.providerId === row.providerId && o.modelId === row.modelId));

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>{t('settings.usage.header')}</span>
        <select
          aria-label={t('settings.usage.periodAriaLabel')}
          value={period}
          onChange={(e) => setPeriod(e.target.value as UsagePeriod)}
          style={{
            fontSize: 'var(--fs-3xl)',
            padding: '4px 8px',
            borderRadius: 'var(--r-sm)',
            border: '1px solid var(--line)',
            background: 'var(--card)',
            color: 'var(--ink)',
          }}
        >
          <option value="today">{t('settings.usage.period.optionToday')}</option>
          <option value="thisWeek">{t('settings.usage.period.optionThisWeek')}</option>
          <option value="thisMonth">{t('settings.usage.period.optionThisMonth')}</option>
          <option value="allTime">{t('settings.usage.period.optionAllTime')}</option>
        </select>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 16,
          padding: '12px 0',
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 120,
            padding: 12,
            borderRadius: 'var(--r-sm)',
            background: 'var(--card)',
          }}
        >
          <div style={{ fontSize: 'var(--fs-10xl)', fontWeight: 700 }}>{formatCents(data.totalCostCents)}</div>
          <div style={{ fontSize: 'var(--fs-md)', color: 'var(--ink-2)' }}>{t('settings.usage.stats.totalCost')}</div>
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 120,
            padding: 12,
            borderRadius: 'var(--r-sm)',
            background: 'var(--card)',
          }}
        >
          <div style={{ fontSize: 'var(--fs-10xl)', fontWeight: 700 }}>{formatTokens(data.totalInputTokens)}</div>
          <div style={{ fontSize: 'var(--fs-md)', color: 'var(--ink-2)' }}>{t('settings.usage.stats.inputTokens')}</div>
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 120,
            padding: 12,
            borderRadius: 'var(--r-sm)',
            background: 'var(--card)',
          }}
        >
          <div style={{ fontSize: 'var(--fs-10xl)', fontWeight: 700 }}>{formatTokens(data.totalOutputTokens)}</div>
          <div style={{ fontSize: 'var(--fs-md)', color: 'var(--ink-2)' }}>{t('settings.usage.stats.outputTokens')}</div>
        </div>
      </div>

      {data.unpricedModels > 0 && (
        <p role="note" style={{ fontSize: 'var(--fs-3xl)', color: 'var(--ink-2)', margin: '0 0 12px' }}>
          {t('settings.usage.unpricedNotice', { count: data.unpricedModels })}
        </p>
      )}

      {data.byProvider.length > 0 && (
        <table
          style={{
            width: '100%',
            fontSize: 'var(--fs-3xl)',
            borderCollapse: 'collapse',
            marginBottom: 12,
          }}
        >
          <thead>
            <tr style={{ borderBottom: '1px solid var(--line)' }}>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('settings.usage.table.provider')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>{t('settings.usage.table.model')}</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>{t('settings.usage.table.input')}</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>{t('settings.usage.table.output')}</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>{t('settings.usage.table.cost')}</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>
                <span className="sr-only">{t('settings.usage.table.price')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.byProvider.map((row) => {
              const key = rowKey(row);
              const isLocal = row.price?.source === 'local';
              const hasOverride = row.price?.source === 'override';
              const priceTitle = row.price
                ? t('settings.usage.priceTitle', {
                    input: `$${row.price.price.inputPerMtok}`,
                    output: `$${row.price.price.outputPerMtok}`,
                    source: sourceLabel(row.price, data.pricesAsOf, t),
                  })
                : undefined;
              return [
                <tr key={key} style={{ borderBottom: editing === key ? 'none' : '1px solid var(--line)' }}>
                  <td style={cellStyle}>{providerDisplayName(row.providerId)}</td>
                  <td style={cellStyle}>{row.modelId}</td>
                  <td style={numberCell}>{formatTokens(row.inputTokens)}</td>
                  <td style={numberCell}>{formatTokens(row.outputTokens)}</td>
                  <td style={numberCell} title={priceTitle}>
                    {row.costCents != null ? (
                      formatCents(row.costCents)
                    ) : (
                      <span style={{ color: 'var(--ink-3)' }}>{t('settings.usage.table.noPrice')}</span>
                    )}
                  </td>
                  <td style={numberCell}>
                    {!isLocal && editing !== key && (
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => setEditing(key)}
                        aria-label={t(row.price ? 'settings.usage.editPriceFor' : 'settings.usage.setPriceFor', {
                          model: row.modelId,
                        })}
                      >
                        {t(row.price ? 'settings.usage.editPrice' : 'settings.usage.setPrice')}
                      </button>
                    )}
                  </td>
                </tr>,
                editing === key ? (
                  <tr key={`${key}-editor`} style={{ borderBottom: '1px solid var(--line)' }}>
                    <td colSpan={6}>
                      <PriceEditor
                        row={row}
                        onCancel={() => setEditing(null)}
                        onSave={(price) =>
                          void saveOverrides(
                            [...without(row), { providerId: row.providerId, modelId: row.modelId, price }],
                            t('settings.usage.editor.saved', { model: row.modelId }),
                          )
                        }
                        onRemove={
                          hasOverride
                            ? () =>
                                void saveOverrides(
                                  without(row),
                                  t('settings.usage.editor.removed', { model: row.modelId }),
                                )
                            : null
                        }
                      />
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      )}

      {data.dailyTotals.length > 1 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 4,
            height: 80,
            padding: '8px 0',
            marginBottom: 12,
          }}
          role="img"
          aria-label={t('settings.usage.dailyChartAriaLabel')}
        >
          {data.dailyTotals.map((day) => (
            <div
              key={day.date}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                height: '100%',
                justifyContent: 'flex-end',
              }}
              title={t('settings.usage.dailyBarTitle', { date: day.date, cost: formatCents(day.costCents) })}
            >
              <div
                style={{
                  width: '100%',
                  maxWidth: 32,
                  minHeight: 2,
                  background: 'var(--hue)',
                  borderRadius: 'var(--r-2) var(--r-2) 0 0',
                  height: `${Math.max((day.costCents / maxCost) * 100, 2)}%`,
                }}
              />
              <span style={{ fontSize: 'var(--fs-3xs)', color: 'var(--ink-3)', marginTop: 2 }}>
                {day.date.slice(5)}
              </span>
            </div>
          ))}
        </div>
      )}

      {spendAlert}

      <p style={{ fontSize: 'var(--fs-md)', color: 'var(--ink-3)', marginTop: 8 }}>
        {t('settings.usage.footer', { date: data.pricesAsOf })}
      </p>
    </div>
  );
}
