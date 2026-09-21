/**
 * G.0.12 / #418 (finding A4): gate execution status polling on
 * `document.visibilityState`, with exponential backoff and jitter.
 *
 * Relates to #418 / Part of #402. Keep #402 open.
 *
 * Chloe chrome only. Existing GET /executions/{id} poll stays — no
 * EventSource, WebSocket, or new API. Hidden tabs pause. Visible tabs
 * keep the ~2s cadence, plus jitter so the hammer is not fixed, and
 * back off on failure. Inbox list stays a one-shot load.
 */

import { EXECUTION_STATUS_POLL_MS } from "./execution-contract.ts";

export { EXECUTION_STATUS_POLL_MS } from "./execution-contract.ts";

/** Cap so a long outage cannot grow the delay without bound. */
export const EXECUTION_STATUS_POLL_MAX_MS = 30_000;
/** Symmetric jitter as a fraction of the backoff base (±). */
export const EXECUTION_STATUS_POLL_JITTER = 0.2;

export function pageIsVisible(
  visibilityState: string | undefined = typeof document === "undefined"
    ? "visible"
    : document.visibilityState,
): boolean {
  return visibilityState === "visible";
}

export function executionPollDelayMs(input: {
  visible?: boolean;
  consecutiveFailures?: number;
  random?: () => number;
} = {}): number | null {
  const visible = input.visible ?? pageIsVisible();
  if (!visible) {
    return null;
  }
  const failures = Number.isFinite(input.consecutiveFailures)
    ? Math.max(0, Math.floor(input.consecutiveFailures as number))
    : 0;
  const shift = Math.min(failures, 10);
  const base = Math.min(
    EXECUTION_STATUS_POLL_MS * 2 ** shift,
    EXECUTION_STATUS_POLL_MAX_MS,
  );
  const random = input.random ?? Math.random;
  const unit = random() * 2 - 1;
  return Math.max(0, Math.round(base * (1 + EXECUTION_STATUS_POLL_JITTER * unit)));
}

export type ExecutionStatusPollLoop = {
  stop: () => void;
};

/**
 * Recursive timeout loop. Pauses while hidden; resumes immediately
 * when the tab is visible again. First visible tick waits the jittered
 * interval (same as the old setInterval). Failures double the delay
 * up to EXECUTION_STATUS_POLL_MAX_MS.
 */
export function startExecutionStatusPoll(input: {
  tick: () => Promise<boolean> | boolean;
  isVisible?: () => boolean;
  random?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  clear?: (handle: unknown) => void;
  subscribeVisibility?: (listener: () => void) => () => void;
}): ExecutionStatusPollLoop {
  const isVisible = input.isVisible ?? (() => pageIsVisible());
  const schedule =
    input.schedule ??
    ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const clear =
    input.clear ??
    ((handle) => {
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  const subscribeVisibility =
    input.subscribeVisibility ??
    ((listener) => {
      if (typeof document === "undefined") {
        return () => {};
      }
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    });

  let stopped = false;
  let handle: unknown;
  let failures = 0;
  let inFlight = false;

  function clearTimer() {
    if (handle === undefined) {
      return;
    }
    clear(handle);
    handle = undefined;
  }

  function arm(immediate: boolean) {
    clearTimer();
    if (stopped || !isVisible()) {
      return;
    }
    const delay = immediate
      ? 0
      : executionPollDelayMs({
          visible: true,
          consecutiveFailures: failures,
          random: input.random,
        });
    if (delay === null) {
      return;
    }
    handle = schedule(() => {
      handle = undefined;
      void runTick();
    }, delay);
  }

  async function runTick() {
    if (stopped || inFlight || !isVisible()) {
      return;
    }
    inFlight = true;
    let ok = false;
    try {
      ok = Boolean(await input.tick());
    } catch {
      ok = false;
    }
    inFlight = false;
    if (stopped) {
      return;
    }
    failures = ok ? 0 : failures + 1;
    arm(false);
  }

  function onVisibility() {
    if (stopped) {
      return;
    }
    if (isVisible()) {
      arm(true);
      return;
    }
    clearTimer();
  }

  const unsubscribe = subscribeVisibility(onVisibility);
  arm(false);

  return {
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clearTimer();
      unsubscribe();
    },
  };
}
