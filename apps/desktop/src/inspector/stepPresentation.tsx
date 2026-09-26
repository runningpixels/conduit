import type { Translate } from '../i18n';
import type { Formatters } from '../i18n/formatters';
import { documentWriteDetail } from '../chat/documentWriteScan';
import type { ActivityStep, ActivityStepStatus } from './turnActivity';

/** Status glyph for a step or a turn line. Inline SVG, `currentColor`, coloured by `data-status`. */
export function StepStatusIcon({ status }: { status: ActivityStepStatus }) {
  return (
    <svg
      className="step-status"
      data-status={status}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {status === 'done' && <path d="M20 6 9 17l-5-5" />}
      {status === 'running' && <path d="M21 12a9 9 0 1 1-6.2-8.6" />}
      {status === 'failed' && <path d="M18 6 6 18M6 6l12 12" />}
      {status === 'waiting' && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </>
      )}
      {status === 'denied' && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m5.6 5.6 12.8 12.8" />
        </>
      )}
    </svg>
  );
}

/** `340ms` / `2.4s` — the same shape the tool cards used. */
export function formatStepDuration(ms: number | undefined): string {
  if (ms == null) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The detail line under a step's tool name, in the reader's language. */
export function stepDetail(step: ActivityStep, t: Translate, fmt: Formatters): string {
  switch (step.kind) {
    case 'search': {
      const parts = [step.label || t('chat.search.searchingPlaceholder')];
      if (step.sourceCount) parts.push(t('chat.search.sourceCount', { count: step.sourceCount }));
      return parts.join(' · ');
    }
    case 'document': {
      const parts = [t('chat.toolCall.document.action', { action: step.documentAction ?? 'document' })];
      if (step.label) parts.push(step.label);
      const size = step.size
        ? documentWriteDetail({ contentChars: step.size.chars, contentLines: step.size.lines }, t, fmt)
        : undefined;
      if (size) parts.push(size);
      return parts.join(' · ');
    }
    case 'tool':
      return [step.label, step.status === 'failed' ? step.error : undefined].filter(Boolean).join(' · ');
    default:
      return step.label;
  }
}

export function stepStatusLabel(status: ActivityStepStatus, t: Translate): string {
  return t('inspector.activity.status', { status });
}
