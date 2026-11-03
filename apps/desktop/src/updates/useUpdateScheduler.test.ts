import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { AppSettings, UpdatePolicy } from "../ipc/contracts";
import { toastDismissMs, type StatusState } from "../chat/statusTypes";
import { useUpdateScheduler } from "./useUpdateScheduler";

/**
 * The scheduler's whole job is deciding *whether* to touch the network, so
 * that decision table is what these cover: the two gates that must hold it
 * back (checks disabled, `manual` policy), the busy-guard, the interval, and
 * which command each policy ends up calling.
 *
 * The Rust side enforces `updateCheckEnabled` independently — `fetch_update`
 * returns before building a client. These tests pin the renderer's own gate so
 * a regression here shows up as a failing test rather than as a request that
 * only the Rust guard happened to stop.
 */
vi.mock("../ipc/client", () => ({
  getUpdateStatus: vi.fn(),
  checkForUpdate: vi.fn(),
  stageUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
  restartToUpdate: vi.fn(),
}));

const {
  getUpdateStatus,
  checkForUpdate,
  stageUpdate,
  downloadAndInstallUpdate,
  restartToUpdate,
} = await import("../ipc/client");

const BASE_SETTINGS = {
  activeProvider: "anthropic",
  activeModel: "claude-sonnet-4",
  localOnly: true,
  diagnosticsEnabled: true,
  theme: "system",
  language: "system",
  providerEndpoints: {},
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  updateChannel: "stable" as const,
  updateCheckEnabled: true,
  updatePolicy: "manual" as const,
  onboardingCompleted: true,
} as unknown as AppSettings;

function settingsWith(
  policy: UpdatePolicy,
  updateCheckEnabled = true,
): AppSettings {
  return { ...BASE_SETTINGS, updatePolicy: policy, updateCheckEnabled };
}

/** Past the 60s startup delay, into the first real tick. */
const PAST_STARTUP_MS = 61_000;

function mount(settings: AppSettings | null, isBusy = () => false) {
  const onStatus = vi.fn();
  const t = (id: string, values?: Record<string, string | number>) =>
    `${id}:${JSON.stringify(values ?? {})}`;
  const view = renderHook(() =>
    useUpdateScheduler({ settings, isBusy, onStatus, t }),
  );
  return { onStatus, ...view };
}

/** Let the chain of awaits inside a tick settle. */
async function flush() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe("useUpdateScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getUpdateStatus).mockResolvedValue({
      lastChecked: null,
      staged: null,
      automaticSupported: true,
    });
    vi.mocked(checkForUpdate).mockResolvedValue(null);
    vi.mocked(stageUpdate).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does nothing while settings are still loading", async () => {
    mount(null);
    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    expect(getUpdateStatus).not.toHaveBeenCalled();
  });

  it("does nothing on the manual policy — the default, and every existing install", async () => {
    mount(settingsWith("manual"));
    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    expect(getUpdateStatus).not.toHaveBeenCalled();
    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(stageUpdate).not.toHaveBeenCalled();
  });

  it("does nothing when update checks are switched off, whatever the policy says", async () => {
    // The hard off-switch outranks a remembered `automatic`: a user who turned
    // checks off has revoked network access, not just downgraded it.
    mount(settingsWith("automatic", false));
    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    expect(getUpdateStatus).not.toHaveBeenCalled();
    expect(stageUpdate).not.toHaveBeenCalled();
  });

  it("does not check during the startup delay", async () => {
    mount(settingsWith("notify"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getUpdateStatus).not.toHaveBeenCalled();
  });

  it("offers a one-click install that stays on screen when the notify policy finds an update", async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({
      version: "0.2.0",
      date: null,
      notes: null,
    });
    const { onStatus } = mount(settingsWith("notify"));

    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    await flush();

    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(stageUpdate).not.toHaveBeenCalled();
    const prompt = onStatus.mock.calls[0][0] as StatusState;
    expect(prompt.brief).toContain("updates.prompt.available");
    expect(prompt.brief).toContain("0.2.0");
    // An action keeps the toast up until dismissed.
    expect(toastDismissMs(prompt)).toBeNull();
    expect(prompt.action?.label).toContain("updates.prompt.install");

    prompt.action?.run();
    await flush();
    expect(downloadAndInstallUpdate).toHaveBeenCalledTimes(1);
    expect(restartToUpdate).not.toHaveBeenCalled();
  });

  it("waits for a streaming reply to finish before installing", async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({
      version: "0.2.0",
      date: null,
      notes: null,
    });
    let busy = false;
    const { onStatus } = mount(settingsWith("notify"), () => busy);
    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    await flush();

    busy = true;
    (onStatus.mock.calls[0][0] as StatusState).action?.run();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(downloadAndInstallUpdate).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        brief: expect.stringContaining("updates.prompt.waitingForReply"),
      }),
    );

    busy = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(downloadAndInstallUpdate).toHaveBeenCalledTimes(1);
  });

  it("reports a failed install as an error that stays", async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({
      version: "0.2.0",
      date: null,
      notes: null,
    });
    vi.mocked(downloadAndInstallUpdate).mockRejectedValue(
      new Error("migration precheck failed"),
    );
    const { onStatus } = mount(settingsWith("notify"));
    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    await flush();

    (onStatus.mock.calls[0][0] as StatusState).action?.run();
    await flush();
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "error",
        brief: expect.stringContaining("installFailed"),
      }),
    );
  });

  it("announces each version once per session", async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({
      version: "0.2.0",
      date: null,
      notes: null,
    });
    const { onStatus } = mount(settingsWith("notify"));
    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    await flush();
    // A day later the check runs again and finds the same version.
    await vi.advanceTimersByTimeAsync(30 * 60 * 60 * 1000);
    await flush();

    expect(vi.mocked(checkForUpdate).mock.calls.length).toBeGreaterThan(1);
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it("stays silent when notify finds nothing", async () => {
    const { onStatus } = mount(settingsWith("notify"));
    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    await flush();

    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("stages rather than checks on the automatic policy", async () => {
    vi.mocked(stageUpdate).mockResolvedValue({
      version: "0.2.0",
      date: null,
      notes: null,
    });
    const { onStatus } = mount(settingsWith("automatic"));

    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    await flush();

    expect(stageUpdate).toHaveBeenCalledTimes(1);
    expect(checkForUpdate).not.toHaveBeenCalled();
    const prompt = onStatus.mock.calls[0][0] as StatusState;
    expect(prompt.brief).toContain("updates.prompt.staged");
    expect(toastDismissMs(prompt)).toBeNull();
    expect(prompt.action?.label).toContain("updates.prompt.restartNow");

    // Restarting installs the staged copy; nothing is downloaded again.
    prompt.action?.run();
    await flush();
    expect(restartToUpdate).toHaveBeenCalledTimes(1);
    expect(downloadAndInstallUpdate).not.toHaveBeenCalled();
  });

  it("never stages while a conversation is streaming", async () => {
    vi.mocked(stageUpdate).mockResolvedValue({
      version: "0.2.0",
      date: null,
      notes: null,
    });
    mount(settingsWith("automatic"), () => true);

    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    await flush();

    // Bails before even the status read, so nothing is recorded and the check
    // stays due for a later, quieter tick.
    expect(getUpdateStatus).not.toHaveBeenCalled();
    expect(stageUpdate).not.toHaveBeenCalled();
  });

  it("checks once on launch even when the last check was recent", async () => {
    // A prompt dismissed last session comes back on the next launch.
    const justChecked = Math.floor(Date.now() / 1000) - 60;
    vi.mocked(getUpdateStatus).mockResolvedValue({
      lastChecked: justChecked,
      staged: null,
      automaticSupported: true,
    });
    mount(settingsWith("notify"));

    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    await flush();

    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not re-check inside the interval after the launch check", async () => {
    const justChecked = Math.floor(Date.now() / 1000) - 60;
    vi.mocked(getUpdateStatus).mockResolvedValue({
      lastChecked: justChecked,
      staged: null,
      automaticSupported: true,
    });
    mount(settingsWith("notify"));

    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    await flush();
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    await flush();

    expect(vi.mocked(getUpdateStatus).mock.calls.length).toBeGreaterThan(1);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("checks again once a day has passed", async () => {
    const yesterday = Math.floor(Date.now() / 1000) - 60 * 60 * 48;
    vi.mocked(getUpdateStatus).mockResolvedValue({
      lastChecked: yesterday,
      staged: null,
      automaticSupported: true,
    });
    mount(settingsWith("notify"));

    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    await flush();

    expect(checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("offers the restart, and stages nothing more, once something is staged", async () => {
    vi.mocked(getUpdateStatus).mockResolvedValue({
      lastChecked: null,
      staged: { version: "0.2.0", date: null, notes: null },
      automaticSupported: true,
    });
    const { onStatus } = mount(settingsWith("automatic"));

    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    await flush();

    expect(stageUpdate).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect((onStatus.mock.calls[0][0] as StatusState).brief).toContain(
      "updates.prompt.staged",
    );
  });

  it("does not stage where install-on-quit cannot be silent (a .deb build)", async () => {
    // Rust refuses this before it reaches the network, but a scheduler that
    // keeps asking would burn a check a day to be told no every time.
    vi.mocked(getUpdateStatus).mockResolvedValue({
      lastChecked: null,
      staged: null,
      automaticSupported: false,
    });
    mount(settingsWith("automatic"));

    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    await flush();

    expect(stageUpdate).not.toHaveBeenCalled();
  });

  it("still notifies where automatic install is unsupported", async () => {
    // `notify` needs no installer, so a .deb build keeps it.
    vi.mocked(getUpdateStatus).mockResolvedValue({
      lastChecked: null,
      staged: null,
      automaticSupported: false,
    });
    vi.mocked(checkForUpdate).mockResolvedValue({
      version: "0.2.0",
      date: null,
      notes: null,
    });
    const { onStatus } = mount(settingsWith("notify"));

    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    await flush();

    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalled();
  });

  it("swallows background failures rather than surfacing them", async () => {
    // A background check the user did not ask for must not produce an error
    // toast they have to dismiss. "Check now" still reports faults loudly.
    vi.mocked(getUpdateStatus).mockRejectedValue(new Error("offline"));
    const { onStatus } = mount(settingsWith("notify"));

    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS);
    await flush();

    expect(onStatus).not.toHaveBeenCalled();
  });

  it("stops scheduling once unmounted", async () => {
    const { unmount } = mount(settingsWith("notify"));
    unmount();

    await vi.advanceTimersByTimeAsync(PAST_STARTUP_MS * 10);
    expect(getUpdateStatus).not.toHaveBeenCalled();
  });
});
