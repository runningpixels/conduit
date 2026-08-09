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

/** §6.4 — a model line renders **only at a switch**: when the turn's provider or
 *  model differs from the preceding assistant turn. A single-model conversation
 *  never shows it.
 *
 *  The first turn used to show it too, which meant every conversation opened
 *  with a caption naming a model the status line was already reporting
 *  continuously. §6.4's own argument — that the switch "is the only moment it
 *  carries information" — applies just as well to the first turn, where nothing
 *  has changed yet. */
export function shouldShowModelLine(
  prev: { provider?: string; model?: string } | undefined,
  next: { provider: string; model: string },
): boolean {
  if (!prev) return false;
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
