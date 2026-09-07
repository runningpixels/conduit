import { useEffect, useState } from 'react';
import { getUsageSummary } from '../../ipc/client';
import type { UsageSummaryResponse, UsagePeriod } from '../../ipc/contracts';
import { useT } from '../../i18n';

function formatCents(cents: number): string {
  const d = cents / 100;
  if (d < 0.01) return '<$0.01';
  return `$${d.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toLocaleString();
}

export function UsageSection() {
  const t = useT();
  const [period, setPeriod] = useState<UsagePeriod>('thisMonth');
  const [data, setData] = useState<UsageSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getUsageSummary(period)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [period]);

  if (loading) {
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
        <p style={{ fontSize: '13px', color: 'var(--ink-2)', padding: '12px 0' }}>
          {t('settings.usage.empty')}
        </p>
      </div>
    );
  }

  const maxCost = Math.max(...data.dailyTotals.map((d) => d.costCents), 0.0001);

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>{t('settings.usage.header')}</span>
        <select
          aria-label={t('settings.usage.periodAriaLabel')}
          value={period}
          onChange={(e) => setPeriod(e.target.value as UsagePeriod)}
          style={{
            fontSize: '13px',
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
          <div style={{ fontSize: '20px', fontWeight: 700 }}>{formatCents(data.totalCostCents)}</div>
          <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>{t('settings.usage.stats.totalCost')}</div>
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
          <div style={{ fontSize: '20px', fontWeight: 700 }}>{formatTokens(data.totalInputTokens)}</div>
          <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>{t('settings.usage.stats.inputTokens')}</div>
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
          <div style={{ fontSize: '20px', fontWeight: 700 }}>{formatTokens(data.totalOutputTokens)}</div>
          <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>{t('settings.usage.stats.outputTokens')}</div>
        </div>
      </div>

      {data.byProvider.length > 0 && (
        <table
          style={{
            width: '100%',
            fontSize: '13px',
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
            </tr>
          </thead>
          <tbody>
            {data.byProvider.map((row) => (
              <tr
                key={`${row.providerId}-${row.modelId}`}
                style={{ borderBottom: '1px solid var(--line)' }}
              >
                <td style={{ padding: '6px 8px' }}>{row.providerId}</td>
                <td style={{ padding: '6px 8px' }}>{row.modelId}</td>
                <td style={{ textAlign: 'right', padding: '6px 8px' }}>{formatTokens(row.inputTokens)}</td>
                <td style={{ textAlign: 'right', padding: '6px 8px' }}>{formatTokens(row.outputTokens)}</td>
                <td style={{ textAlign: 'right', padding: '6px 8px' }}>{formatCents(row.costCents)}</td>
              </tr>
            ))}
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
                  borderRadius: '2px 2px 0 0',
                  height: `${Math.max((day.costCents / maxCost) * 100, 2)}%`,
                }}
              />
              <span style={{ fontSize: '9px', color: 'var(--ink-3)', marginTop: 2 }}>
                {day.date.slice(5)}
              </span>
            </div>
          ))}
        </div>
      )}

      <p style={{ fontSize: '11px', color: 'var(--ink-3)', marginTop: 8 }}>
        {t('settings.usage.footer')}
      </p>
    </div>
  );
}
