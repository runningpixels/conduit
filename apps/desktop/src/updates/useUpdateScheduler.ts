/**
 * The background half of the updater: the thing that decides *when* to check.
 *
 * ## Why this lives in the renderer
 *
 * The app uses no Tauri events — there is no `.emit()` in the Rust tree and no
 * `listen()` here; all streaming goes through renderer-initiated `ipc::Channel`
 * (`commands/chat.rs`). A Rust-side scheduler would therefore have to invent an
 * event channel to reach the UI *and* a way to ask whether a stream is in
 * flight before it dared stage anything.
 *
 * Scheduling from the renderer needs neither. Rust still performs every byte of
 * network I/O — this only calls the existing commands — so the architectural
 * promise that the renderer never touches the network is untouched. And because
 * this runs where stream state already lives, "don't disturb an in-flight
 * conversation" is a function call rather than new plumbing.
 *
 * The tradeoff is that checks only happen while the window is alive. That is
 * correct for a desktop chat client with no background service, and not a thing
 * this app should grow one for.
 *
 * ## What it tells the user
 *
 * An update it finds stays on screen until dismissed, with the install one
 * click away: "Install and restart" under `notify`, "Restart now" once
 * `automatic` has staged one. A six-second toast with no button went unseen
 * for weeks, and "installs when you quit" rarely comes, since closing the
 * window only hides it to the tray. Each launch checks once whatever the clock
 * says, so a dismissed prompt comes back next launch; within a session each
 * version is announced once.
 *
 * ## What it will not do
 *
 * - Run at all unless `updateCheckEnabled` is on AND the policy is not
 *   `manual`. The Rust side enforces the first of those independently; this is
 *   a second gate, not the only one.
 * - Interrupt a streaming conversation. Staging is deferred to a later tick.
 * - Surface failures. A background check that cannot reach the network is not
 *   an event the user asked about; only the explicit "Check now" button reports
 *   errors.
 */

import { useEffect, useRef } from "react";
import type { AppSettings } from "../ipc/contracts";
import {
  checkForUpdate,
  downloadAndInstallUpdate,
  getUpdateStatus,
  restartToUpdate,
  stageUpdate,
} from "../ipc/client";
import { makeStatus, type StatusState } from "../chat/statusTypes";

/** Delay before the first check, so launch is never competing with it. */
const STARTUP_DELAY_MS = 60_000;

/** Nominal gap between checks. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Up to ±20% is added to the interval, drawn once per session.
 *
 * Without this every client that launched on the same day would wake on the
 * same cadence and arrive at GitHub Pages together. The manifest is static and
 * cheap, but a self-synchronising thundering herd is the kind of thing that is
 * free to avoid now and expensive to retrofit.
 */
const JITTER_RATIO = 0.2;

/**
 * How often the hook re-evaluates whether a check is due.
 *
 * Deliberately much shorter than the interval, and deliberately not a single
 * 24h `setTimeout`: a laptop that sleeps for a day would never fire one, and a
 * tick that finds the machine busy needs a cheap way to try again soon.
 */
const TICK_MS = 15 * 60 * 1000;

/** How often an install the user asked for during a reply looks again. */
const BUSY_RETRY_MS = 2_000;

export interface UpdateSchedulerOptions {
  /** Null while settings are still loading; the hook stays dormant. */
  settings: AppSettings | null;
  /** True while a conversation is streaming — staging waits. */
  isBusy: () => boolean;
  onStatus: (status: StatusState) => void;
  /** Translator, passed in so this stays decoupled from the i18n provider. */
  t: (id: string, values?: Record<string, string | number>) => string;
}

export function useUpdateScheduler({
  settings,
  isBusy,
  onStatus,
  t,
}: UpdateSchedulerOptions) {
  // Held in refs so changing them does not restart the schedule: a status
  // callback identity change should not reset the 24h clock.
  const isBusyRef = useRef(isBusy);
  const onStatusRef = useRef(onStatus);
  const tRef = useRef(t);
  isBusyRef.current = isBusy;
  onStatusRef.current = onStatus;
  tRef.current = t;

  // One jitter draw per mount, not per tick — re-drawing every tick would
  // average the offset back out to zero and defeat the point.
  const jitterRef = useRef(1 + (Math.random() * 2 - 1) * JITTER_RATIO);
  // The launch check runs whatever `lastChecked` says; later ones keep the clock.
  const checkedThisSessionRef = useRef(false);
  // Versions already put in front of the user this session, so a daily tick
  // does not stack a second prompt over a dismissed one.
  const announcedRef = useRef(new Set<string>());

  const enabled =
    Boolean(settings?.updateCheckEnabled) &&
    settings?.updatePolicy !== "manual";
  const policy = settings?.updatePolicy;

  useEffect(() => {
    if (!enabled || !policy) return;

    let cancelled = false;
    const dueAfterMs = CHECK_INTERVAL_MS * jitterRef.current;

    /** The one-click install. A found update takes the same verified path as
     *  Settings' button (migration precheck, signature check, restart); a
     *  staged one is installed by restarting. A reply in flight is let finish
     *  first — a restart would cut it off. */
    async function install(kind: "available" | "staged", version: string) {
      const say = (
        key: string,
        kind: StatusState["kind"],
        values: Record<string, string> = {},
      ) =>
        onStatusRef.current(
          makeStatus(
            tRef.current(key, { version, ...values }),
            kind,
            "settings",
          ),
        );
      if (isBusyRef.current()) {
        say("settings.updates.prompt.waitingForReply", "active");
        while (isBusyRef.current())
          await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
      }
      say("settings.updates.prompt.installing", "active");
      try {
        await (kind === "staged"
          ? restartToUpdate()
          : downloadAndInstallUpdate());
      } catch (e) {
        say("settings.updates.status.installFailed", "error", {
          error: String(e),
        });
      }
    }

    function announce(kind: "available" | "staged", version: string) {
      const key = `${kind}:${version}`;
      if (announcedRef.current.has(key)) return;
      announcedRef.current.add(key);
      const t = tRef.current;
      onStatusRef.current({
        ...makeStatus(
          t(`settings.updates.prompt.${kind}`, { version }),
          "success",
          "settings",
          t(`settings.updates.prompt.${kind}Detail`),
        ),
        action: {
          label: t(
            kind === "available"
              ? "settings.updates.prompt.install"
              : "settings.updates.prompt.restartNow",
          ),
          run: () => void install(kind, version),
        },
      });
    }

    async function tick() {
      if (cancelled) return;
      // Busy now means try again in TICK_MS, not skip this cycle: `lastChecked`
      // is untouched, so the check stays due.
      if (isBusyRef.current()) return;

      try {
        const status = await getUpdateStatus();
        if (cancelled) return;

        // Something is already downloaded and waiting for quit: offer the
        // restart, and check nothing further this session.
        if (status.staged) {
          announce("staged", status.staged.version);
          return;
        }

        const elapsedMs =
          status.lastChecked === null
            ? Number.POSITIVE_INFINITY
            : Date.now() - status.lastChecked * 1000;
        if (checkedThisSessionRef.current && elapsedMs < dueAfterMs) return;
        checkedThisSessionRef.current = true;

        // A `.deb` build cannot install silently at quit, so staging there
        // would be a daily check that only ever earns a refusal.
        if (policy === "automatic" && !status.automaticSupported) return;

        if (policy === "automatic") {
          const staged = await stageUpdate();
          if (cancelled || !staged) return;
          announce("staged", staged.version);
          return;
        }

        const found = await checkForUpdate();
        if (cancelled || !found) return;
        announce("available", found.version);
      } catch {
        // Swallowed on purpose. A background check the user did not ask for
        // should not produce an error they have to dismiss; the next tick
        // retries, and "Check now" still reports faults loudly.
      }
    }

    const startupTimer = setTimeout(() => {
      void tick();
    }, STARTUP_DELAY_MS);
    const interval = setInterval(() => {
      void tick();
    }, TICK_MS);

    return () => {
      cancelled = true;
      clearTimeout(startupTimer);
      clearInterval(interval);
    };
  }, [enabled, policy]);
}
