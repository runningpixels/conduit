import { providerDisplayName } from '../lib/providerIdentity';

interface TurnModelLineProps {
  /** Adapter id of the provider that produced this turn. */
  provider: string;
  /** Model id of the provider that produced this turn. */
  model: string;
  /** Turn timestamp, rendered as `· 10:42`. */
  time?: string;
  /** When the provider differs from the preceding assistant turn, the
   *  previous provider id — rendered as `· switched from …` in `--hue`. */
  switchedFrom?: string;
}

/** §6.4 — a model line renders only when the turn's provider or model differs
 *  from the preceding assistant turn, or when it is the first assistant turn.
 *  In a single-model conversation this line appears once; in a mixed
 *  conversation it appears exactly at each switch — the only moment it
 *  carries information. */
export function shouldShowModelLine(
  prev: { provider?: string; model?: string } | undefined,
  next: { provider: string; model: string },
): boolean {
  if (!prev) return true;
  return prev.provider !== next.provider || prev.model !== next.model;
}

/** The conditional model line (§6.4). Mono, 10.5px, `--ink-3`; the leading
 *  dot and "switched from …" carry the provider hue. */
export function TurnModelLine({ provider, model, time, switchedFrom }: TurnModelLineProps) {
  return (
    <div className="turn-model">
      <i className="pdot" aria-hidden="true" />
      <b>{providerDisplayName(provider)}</b> / {model}
      {time ? <span className="turn-model-time">· {time}</span> : null}
      {switchedFrom ? (
        <span className="switched">· switched from {providerDisplayName(switchedFrom)}</span>
      ) : null}
    </div>
  );
}
