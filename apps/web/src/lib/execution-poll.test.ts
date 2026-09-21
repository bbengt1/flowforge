import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXECUTION_STATUS_POLL_JITTER,
  EXECUTION_STATUS_POLL_MAX_MS,
  EXECUTION_STATUS_POLL_MS,
  executionPollDelayMs,
  pageIsVisible,
  startExecutionStatusPoll,
} from "./execution-poll.ts";
import { STATUS_POLL_HELP } from "./execution-contract.ts";
import { R4_GUARDRAILS } from "./execution-inbox.ts";
import { EDITOR_RUNS } from "./editor-runs.ts";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, "..", relative), "utf8");
}

function createFakeClock() {
  let nextId = 1;
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();

  function due(): Array<{ id: number; at: number; callback: () => void }> {
    return [...timers.entries()]
      .map(([id, timer]) => ({ id, ...timer }))
      .filter((timer) => timer.at <= now)
      .sort((left, right) => left.at - right.at || left.id - right.id);
  }

  function flush(): void {
    let guard = 0;
    while (due().length > 0) {
      guard += 1;
      if (guard > 100) {
        throw new Error("fake clock flushed too many timers");
      }
      const next = due()[0];
      if (!next) {
        return;
      }
      timers.delete(next.id);
      next.callback();
    }
  }

  return {
    now: () => now,
    pendingDelays(): number[] {
      return [...timers.values()]
        .sort((left, right) => left.at - right.at)
        .map((timer) => timer.at - now);
    },
    schedule(callback: () => void, delayMs: number) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clear(handle: unknown) {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      now += ms;
      flush();
    },
    flush,
  };
}

describe("G.0.12 execution poll visibility + backoff", () => {
  it("pauses when the document is not visible", () => {
    assert.equal(pageIsVisible("visible"), true);
    assert.equal(pageIsVisible("hidden"), false);
    assert.equal(pageIsVisible("prerender"), false);
    assert.equal(pageIsVisible(undefined), true);
    assert.equal(executionPollDelayMs({ visible: false }), null);
    assert.equal(
      executionPollDelayMs({
        visible: true,
        consecutiveFailures: 0,
        random: () => 0.5,
      }),
      EXECUTION_STATUS_POLL_MS,
    );
  });

  it("keeps a ~2s visible cadence and adds jitter so the interval is not fixed", () => {
    assert.equal(EXECUTION_STATUS_POLL_MS, 2000);
    assert.equal(EXECUTION_STATUS_POLL_JITTER, 0.2);
    const low = executionPollDelayMs({
      visible: true,
      consecutiveFailures: 0,
      random: () => 0,
    });
    const mid = executionPollDelayMs({
      visible: true,
      consecutiveFailures: 0,
      random: () => 0.5,
    });
    const high = executionPollDelayMs({
      visible: true,
      consecutiveFailures: 0,
      random: () => 0.999,
    });
    assert.equal(low, 1600);
    assert.equal(mid, 2000);
    assert.ok((high ?? 0) > 2000 && (high ?? 0) <= 2400);
    assert.notEqual(low, high);
  });

  it("backs off exponentially on consecutive failures and caps the delay", () => {
    assert.equal(EXECUTION_STATUS_POLL_MAX_MS, 30_000);
    assert.equal(
      executionPollDelayMs({
        visible: true,
        consecutiveFailures: 1,
        random: () => 0.5,
      }),
      4000,
    );
    assert.equal(
      executionPollDelayMs({
        visible: true,
        consecutiveFailures: 2,
        random: () => 0.5,
      }),
      8000,
    );
    assert.equal(
      executionPollDelayMs({
        visible: true,
        consecutiveFailures: 4,
        random: () => 0.5,
      }),
      EXECUTION_STATUS_POLL_MAX_MS,
    );
    assert.equal(
      executionPollDelayMs({
        visible: true,
        consecutiveFailures: 12,
        random: () => 0.5,
      }),
      EXECUTION_STATUS_POLL_MAX_MS,
    );
    assert.equal(
      executionPollDelayMs({
        visible: true,
        consecutiveFailures: 4,
        random: () => 0.999,
      }),
      EXECUTION_STATUS_POLL_MAX_MS,
    );
  });

  it("does not schedule ticks while hidden and resumes immediately when visible", async () => {
    const clock = createFakeClock();
    let visible = false;
    let ticks = 0;
    let listener: (() => void) | undefined;
    const loop = startExecutionStatusPoll({
      tick: () => {
        ticks += 1;
        return true;
      },
      isVisible: () => visible,
      random: () => 0.5,
      schedule: clock.schedule,
      clear: clock.clear,
      subscribeVisibility: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });
    assert.deepEqual(clock.pendingDelays(), []);
    assert.equal(ticks, 0);

    visible = true;
    listener?.();
    assert.deepEqual(clock.pendingDelays(), [0]);
    clock.flush();
    await Promise.resolve();
    assert.equal(ticks, 1);
    assert.deepEqual(clock.pendingDelays(), [EXECUTION_STATUS_POLL_MS]);

    visible = false;
    listener?.();
    assert.deepEqual(clock.pendingDelays(), []);
    clock.advance(EXECUTION_STATUS_POLL_MS);
    await Promise.resolve();
    assert.equal(ticks, 1);

    visible = true;
    listener?.();
    clock.flush();
    await Promise.resolve();
    assert.equal(ticks, 2);
    loop.stop();
    clock.flush();
    await Promise.resolve();
    assert.equal(ticks, 2);
  });

  it("waits the jittered interval on first visible tick and backs off after a failed tick", async () => {
    const clock = createFakeClock();
    let visible = true;
    const results = [false, true];
    let ticks = 0;
    const loop = startExecutionStatusPoll({
      tick: () => {
        ticks += 1;
        return results.shift() ?? true;
      },
      isVisible: () => visible,
      random: () => 0.5,
      schedule: clock.schedule,
      clear: clock.clear,
      subscribeVisibility: () => () => {},
    });
    assert.deepEqual(clock.pendingDelays(), [EXECUTION_STATUS_POLL_MS]);
    clock.advance(EXECUTION_STATUS_POLL_MS);
    await Promise.resolve();
    assert.equal(ticks, 1);
    assert.deepEqual(clock.pendingDelays(), [4000]);

    clock.advance(4000);
    await Promise.resolve();
    assert.equal(ticks, 2);
    assert.deepEqual(clock.pendingDelays(), [EXECUTION_STATUS_POLL_MS]);
    loop.stop();
    visible = false;
  });

  it("wires detail + Runs overlay to the helper and leaves inbox as a one-shot load", () => {
    const detail = source("components/executions/ExecutionDetail.tsx");
    const operator = source("components/workflows/WorkflowOperator.tsx");
    const history = source("components/executions/ExecutionHistory.tsx");
    const drawer = source("components/workflows/EditorRunsDrawer.tsx");
    assert.match(detail, /startExecutionStatusPoll/);
    assert.match(operator, /startExecutionStatusPoll/);
    assert.doesNotMatch(detail, /setInterval/);
    assert.doesNotMatch(operator, /setInterval/);
    assert.doesNotMatch(history, /startExecutionStatusPoll/);
    assert.doesNotMatch(history, /setInterval/);
    assert.doesNotMatch(drawer, /startExecutionStatusPoll/);
    assert.doesNotMatch(drawer, /setInterval/);
    assert.doesNotMatch(detail, /EventSource|text\/event-stream|new WebSocket/);
    assert.doesNotMatch(operator, /EventSource|text\/event-stream|new WebSocket/);
    assert.match(STATUS_POLL_HELP, /visible/);
    assert.match(STATUS_POLL_HELP, /backoff/);
    assert.match(STATUS_POLL_HELP, /Hidden tabs pause/);
    assert.match(STATUS_POLL_HELP, /never calls \/jobs\/\*/);
    assert.equal(R4_GUARDRAILS.draftsNeverRun, true);
    assert.equal(EDITOR_RUNS.noSse, true);
    assert.equal(EDITOR_RUNS.noDraftExecute, true);
  });
});
