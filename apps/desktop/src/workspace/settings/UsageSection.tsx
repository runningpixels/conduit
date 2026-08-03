import { useEffect, useState } from 'react';
import { getUsageSummary } from '../../ipc/client';
import type { UsageSummaryResponse, UsagePeriod } from '../../ipc/contracts';

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
          <span>Usage & Cost</span>
        </div>
        <span className="status-pill hold">Loading…</span>
      </div>
    );
  }

  if (!data || (data.totalInputTokens === 0 && data.totalOutputTokens === 0)) {
    return (
      <div className="settings-section">
        <div className="settings-section-header">
          <span>Usage & Cost</span>
        </div>
        <p style={{ fontSize: '13px', color: 'var(--ink-2)', padding: '12px 0' }}>
          No usage data yet. Start chatting to see analytics.
        </p>
      </div>
    );
  }

  const maxCost = Math.max(...data.dailyTotals.map((d) => d.costCents), 0.0001);

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>Usage & Cost</span>
        <select
          aria-label="Usage period"
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
          <option value="today">Today</option>
          <option value="thisWeek">This Week</option>
          <option value="thisMonth">This Month</option>
          <option value="allTime">All Time</option>
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
          <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>Total cost (est.)</div>
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
          <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>Input tokens</div>
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
          <div style={{ fontSize: '11px', color: 'var(--ink-2)' }}>Output tokens</div>
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
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Provider</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Model</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>Input</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>Output</th>
              <th style={{ textAlign: 'right', padding: '6px 8px' }}>Cost</th>
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
          aria-label="Daily usage chart"
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
              title={`${day.date}: ${formatCents(day.costCents)}`}
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
        Costs are estimates based on published pricing. Actual billing may differ.
      </p>
    </div>
  );
}