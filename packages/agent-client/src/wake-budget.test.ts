/**
 * The wake budget: a sleeping app's address answers `503` + `Retry-After` +
 * `X-Guuey-Waking: 1` while it wakes. The budget opens ONLY on that marker;
 * inside it an envelope-less 503 keeps the wait going; a coded answer, a
 * non-503, a success, the end of the budget or an abort ends it. One policy
 * for the invoke ({@link withColdStartRetry}) and the other wake doors
 * ({@link sendUnderWakeBudget}).
 *
 * The clock is vitest's fake one: every wait advances it by exactly the
 * waited time, so the budget's elapsed time is deterministic and no test
 * sleeps for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WAKE_BUDGET_MS,
  sendUnderWakeBudget,
  withColdStartRetry,
  type WakeWaitInfo,
} from "./saturation-retry.js";
import {
  AgentResponseError,
  WAKE_TIMED_OUT_MESSAGE,
  WAKING_HEADER,
  WakeTimedOutError,
  isWakingRefusal,
} from "./errors.js";
import { AGENT_ERROR_CODES, CLIENT_ERROR_CODES } from "./error-codes.js";
import { STALL_RECOVERY_DEFAULTS } from "./useAgentInvoke.js";
import { fetchStreamTransport } from "./transport.js";
import type { InvokeRequest } from "./types.js";

function request(signal: AbortSignal = new AbortController().signal): InvokeRequest {
  return { url: "https://pod.example/agent/invoke", body: {}, signal };
}

/** The waking refusal as the transport builds it from the wake path's answer. */
const waking = (retryAfterSeconds?: number): AgentResponseError =>
  new AgentResponseError("agent responded 503", 503, undefined, retryAfterSeconds, true);
/** An envelope-less 503 with no marker: the cold-start shape. */
const plain = (retryAfterSeconds?: number): AgentResponseError =>
  new AgentResponseError("agent responded 503", 503, undefined, retryAfterSeconds);
const coded = (): AgentResponseError =>
  new AgentResponseError("full", 503, AGENT_ERROR_CODES.POD_SATURATED, 5);

type Outcome = AgentResponseError | Error | "ok";

/** A transport that answers each attempt with the next scripted outcome. */
function scripted(outcomes: readonly Outcome[]): {
  t: (req: InvokeRequest) => AsyncGenerator<string>;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    t: async function* (_req: InvokeRequest) {
      const next = outcomes[calls];
      calls += 1;
      if (next === undefined) throw new Error("scripted: no outcome left");
      if (next === "ok") {
        yield "ok";
        return;
      }
      throw next;
    },
  };
}

/** A wait that records the time and moves the fake clock by it. */
function clockSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
      vi.advanceTimersByTime(ms);
    },
  };
}

async function drain(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

async function rejection(gen: AsyncIterable<string>): Promise<unknown> {
  try {
    await drain(gen);
  } catch (err) {
    return err;
  }
  throw new Error("expected the stream to reject");
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("withColdStartRetry — the wake budget", () => {
  it("opens on the waking marker: waits the hint, re-sends, streams the woken answer", async () => {
    const s = scripted([waking(10), "ok"]);
    const { sleep, waits } = clockSleep();
    const infos: WakeWaitInfo[] = [];
    const out = await drain(
      withColdStartRetry(s.t, { sleep, onWakeWait: (i) => infos.push(i) })(request()),
    );
    expect(out).toEqual(["ok"]);
    expect(s.calls()).toBe(2);
    expect(waits).toEqual([10_000]);
    expect(infos).toEqual([{ elapsedMs: 0, budgetMs: WAKE_BUDGET_MS, attempt: 1 }]);
  });

  it("a plain 503 without the marker follows the cold-start path exactly: 2s/4s/8s, then the refusal", async () => {
    const s = scripted([plain(), plain(), plain(), plain(), "ok"]);
    const { sleep, waits } = clockSleep();
    const onWakeWait = vi.fn();
    const err = await rejection(withColdStartRetry(s.t, { sleep, onWakeWait })(request()));
    expect(err).toBeInstanceOf(AgentResponseError);
    expect(err).toMatchObject({ status: 503 });
    expect(isWakingRefusal(err)).toBe(false);
    expect(s.calls()).toBe(4);
    expect(waits).toEqual([2_000, 4_000, 8_000]);
    expect(onWakeWait).not.toHaveBeenCalled();
  });

  it("inside an open budget an envelope-less 503 means keep waiting, past the cold-start attempts", async () => {
    // Four unmarked 503s after the wake opened: the cold-start budget (3)
    // alone would have surfaced the fourth.
    const s = scripted([waking(5), plain(5), plain(5), plain(5), plain(5), "ok"]);
    const { sleep, waits } = clockSleep();
    const out = await drain(withColdStartRetry(s.t, { sleep })(request()));
    expect(out).toEqual(["ok"]);
    expect(s.calls()).toBe(6);
    expect(waits).toEqual([5_000, 5_000, 5_000, 5_000, 5_000]);
  });

  it("keeps waiting even with the cold-start retry budgeted to zero: the wake is its own policy", async () => {
    const s = scripted([waking(3), plain(3), "ok"]);
    const { sleep } = clockSleep();
    const out = await drain(withColdStartRetry(s.t, { sleep, attempts: 0 })(request()));
    expect(out).toEqual(["ok"]);
    expect(s.calls()).toBe(3);
  });

  it("a coded 503 ends the wait: it is the pod answering", async () => {
    const s = scripted([waking(5), coded(), "ok"]);
    const { sleep } = clockSleep();
    const err = await rejection(withColdStartRetry(s.t, { sleep })(request()));
    expect(err).toMatchObject({ code: AGENT_ERROR_CODES.POD_SATURATED });
    expect(s.calls()).toBe(2);
  });

  it("a non-503 ends the wait", async () => {
    const s = scripted([waking(5), new AgentResponseError("bad gateway", 502), "ok"]);
    const { sleep } = clockSleep();
    const err = await rejection(withColdStartRetry(s.t, { sleep })(request()));
    expect(err).toMatchObject({ status: 502 });
    expect(s.calls()).toBe(2);
  });

  it("a network failure ends the wait", async () => {
    const s = scripted([waking(5), new TypeError("Failed to fetch"), "ok"]);
    const { sleep } = clockSleep();
    const err = await rejection(withColdStartRetry(s.t, { sleep })(request()));
    expect(err).toBeInstanceOf(TypeError);
    expect(s.calls()).toBe(2);
  });

  it("the budget opens mid cold-start: a plain 503 first, then the marker", async () => {
    const s = scripted([plain(), waking(10), plain(10), plain(10), plain(10), "ok"]);
    const { sleep, waits } = clockSleep();
    const out = await drain(withColdStartRetry(s.t, { sleep })(request()));
    expect(out).toEqual(["ok"]);
    expect(waits).toEqual([2_000, 10_000, 10_000, 10_000, 10_000]);
  });

  it("the end of the budget throws a WakeTimedOutError: the client code, the one sentence, the last refusal's fields", async () => {
    const answers = Array.from({ length: 30 }, () => waking(15));
    const s = scripted(answers);
    const { sleep, waits } = clockSleep();
    const err = await rejection(withColdStartRetry(s.t, { sleep })(request()));
    expect(err).toBeInstanceOf(WakeTimedOutError);
    expect(err).toBeInstanceOf(AgentResponseError);
    expect(err).toMatchObject({
      code: CLIENT_ERROR_CODES.WAKE_TIMED_OUT,
      message: WAKE_TIMED_OUT_MESSAGE,
      status: 503,
      retryAfterSeconds: 15,
      waking: true,
      refusal: answers[s.calls() - 1],
    });
    // A coded answer is never itself read as waking.
    expect(isWakingRefusal(err)).toBe(false);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(WAKE_BUDGET_MS);
    expect(s.calls()).toBe(waits.length + 1);
  });

  it("the end of the budget after unmarked answers carries the last WAKING refusal", async () => {
    const last = waking(15);
    const s = scripted([last, ...Array.from({ length: 30 }, () => plain(15))]);
    const { sleep } = clockSleep();
    const err = await rejection(withColdStartRetry(s.t, { sleep })(request()));
    expect(err).toBeInstanceOf(WakeTimedOutError);
    expect(err instanceof WakeTimedOutError && err.refusal).toBe(last);
  });

  it("counts the cold-start waits before the marker against the budget: the budgets do not add up", async () => {
    // Three hinted cold-start waits (10 s each, the cold-start ceiling) spend
    // 30 s of the turn before the marker appears; the wake then has 60 s left.
    const s = scripted([plain(10), plain(10), plain(10), ...Array.from({ length: 30 }, () => waking(15))]);
    const { sleep, waits } = clockSleep();
    const infos: WakeWaitInfo[] = [];
    const err = await rejection(
      withColdStartRetry(s.t, { sleep, onWakeWait: (i) => infos.push(i) })(request()),
    );
    expect(err).toBeInstanceOf(WakeTimedOutError);
    expect(waits).toEqual([10_000, 10_000, 10_000, 15_000, 15_000, 15_000, 15_000]);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(WAKE_BUDGET_MS);
    expect(infos[0]).toEqual({ elapsedMs: 30_000, budgetMs: WAKE_BUDGET_MS, attempt: 1 });
  });

  it("never re-asks closer than the 2 s floor: a remainder under it ends the budget", async () => {
    // Each request takes 700 ms, so the waits never land on the budget's edge.
    const outcomes: Outcome[] = Array.from({ length: 30 }, () => waking(15));
    let calls = 0;
    const t = async function* (_req: InvokeRequest): AsyncGenerator<string> {
      vi.advanceTimersByTime(700);
      const next = outcomes[calls];
      calls += 1;
      if (next === undefined || next === "ok") throw new Error("unexpected");
      throw next;
      yield "unreachable";
    };
    const { sleep, waits } = clockSleep();
    const started = Date.now();
    const err = await rejection(withColdStartRetry(t, { sleep })(request()));
    expect(err).toBeInstanceOf(WakeTimedOutError);
    expect(waits.every((w) => w >= 2_000)).toBe(true);
    expect(Date.now() - started).toBeLessThanOrEqual(WAKE_BUDGET_MS + 700);
    // 5 × (0.7 + 15) = 78.5 s, then 0.7 → 79.2 s: 10.8 s left, waited in full;
    // the next answer lands at 90.7 s, past the budget.
    expect(waits).toEqual([15_000, 15_000, 15_000, 15_000, 15_000, 10_800]);
  });

  it("never waits past the budget: the last wait is what remains of it", async () => {
    const s = scripted(Array.from({ length: 30 }, () => waking(7)));
    const { sleep, waits } = clockSleep();
    await rejection(withColdStartRetry(s.t, { sleep })(request()));
    expect(waits.reduce((a, b) => a + b, 0)).toBe(WAKE_BUDGET_MS);
    expect(waits.at(-1)).toBe(WAKE_BUDGET_MS % 7_000);
    expect(waits.slice(0, -1).every((w) => w === 7_000)).toBe(true);
  });

  it("clamps Retry-After to [2 s, 15 s], with a fallback when the answer sent none", async () => {
    const s = scripted([waking(0), waking(1), waking(600), waking(undefined), plain(undefined), "ok"]);
    const { sleep, waits } = clockSleep();
    await drain(withColdStartRetry(s.t, { sleep })(request()));
    expect(waits).toEqual([2_000, 2_000, 15_000, 5_000, 5_000]);
  });

  it("an abort during a wait surfaces the refusal that caused it", async () => {
    const controller = new AbortController();
    const refusal = waking(10);
    const s = scripted([refusal, "ok"]);
    const err = await rejection(
      withColdStartRetry(s.t, { onWakeWait: () => controller.abort() })(request(controller.signal)),
    );
    expect(err).toBe(refusal);
    expect(s.calls()).toBe(1);
  });

  it("an abort mid-wait on the real timer surfaces the refusal without sitting out the wait", async () => {
    const controller = new AbortController();
    const refusal = waking(10);
    const s = scripted([refusal, "ok"]);
    const settled = rejection(withColdStartRetry(s.t)(request(controller.signal)));
    await vi.advanceTimersByTimeAsync(3_000);
    controller.abort();
    expect(await settled).toBe(refusal);
    expect(s.calls()).toBe(1);
  });

  it("nothing is retried once a chunk was yielded", async () => {
    let calls = 0;
    const t = async function* (_req: InvokeRequest): AsyncGenerator<string> {
      calls += 1;
      yield "partial";
      throw waking(5);
    };
    const onWakeWait = vi.fn();
    const chunks: string[] = [];
    const err = await (async () => {
      try {
        for await (const c of withColdStartRetry(t, { onWakeWait })(request())) chunks.push(c);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(isWakingRefusal(err)).toBe(true);
    expect(chunks).toEqual(["partial"]);
    expect(calls).toBe(1);
    expect(onWakeWait).not.toHaveBeenCalled();
  });

  it("reports elapsed time since the budget opened, the budget, and the wait's number", async () => {
    const s = scripted([waking(10), waking(10), plain(4), "ok"]);
    const { sleep } = clockSleep();
    const infos: WakeWaitInfo[] = [];
    await drain(withColdStartRetry(s.t, { sleep, onWakeWait: (i) => infos.push(i) })(request()));
    expect(infos).toEqual([
      { elapsedMs: 0, budgetMs: WAKE_BUDGET_MS, attempt: 1 },
      { elapsedMs: 10_000, budgetMs: WAKE_BUDGET_MS, attempt: 2 },
      { elapsedMs: 20_000, budgetMs: WAKE_BUDGET_MS, attempt: 3 },
    ]);
  });
});

describe("WAKE_BUDGET_MS", () => {
  it("is the 90 s estimate", () => {
    expect(WAKE_BUDGET_MS).toBe(90_000);
  });

  it("leaves room under the stall watchdog's pre-first-byte window for one capacity wait at the pod's usual 15 s hint", () => {
    expect(WAKE_BUDGET_MS + 15_000).toBeLessThan(STALL_RECOVERY_DEFAULTS.preFirstByteWindowMs);
  });

  it("the composed worst case through the stream transport's defaults reaches the first byte inside the window", async () => {
    // Every request takes 500 ms. Three hinted cold-start 503s (10 s each),
    // then waking answers until the budget's last re-ask, which meets a
    // saturated pod (the inner capacity retry waits its 15 s hint), then the
    // stream. Nothing re-arms the watchdog in between: the whole span counts.
    const ROUND_TRIP_MS = 500;
    const plain503 = (): Response =>
      new Response("Service Unavailable", { status: 503, headers: { "Retry-After": "10" } });
    const wakingAnswer = (): Response =>
      new Response(null, { status: 503, headers: { [WAKING_HEADER]: "1", "Retry-After": "15" } });
    const saturated = (): Response =>
      new Response(JSON.stringify({ code: AGENT_ERROR_CODES.POD_SATURATED, message: "full" }), {
        status: 503,
        headers: { "Retry-After": "15" },
      });
    const sse = (): Response =>
      new Response("data: ok\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const answers: Array<() => Response> = [plain503, plain503, plain503, wakingAnswer, wakingAnswer, wakingAnswer, wakingAnswer, saturated, sse];
    const fetchImpl = vi.fn((): Promise<Response> => {
      vi.advanceTimersByTime(ROUND_TRIP_MS);
      const next = answers.shift();
      if (next === undefined) throw new Error("no answer left");
      return Promise.resolve(next());
    });
    const { sleep } = clockSleep();
    const started = Date.now();
    let firstByteAt: number | undefined;
    for await (const _chunk of fetchStreamTransport(request(), null, "0123456789abcdef".repeat(4), {
      fetchImpl,
      sleep,
    })) {
      firstByteAt ??= Date.now();
    }
    expect(answers).toEqual([]);
    expect(firstByteAt).toBeDefined();
    expect((firstByteAt ?? Infinity) - started).toBeLessThan(STALL_RECOVERY_DEFAULTS.preFirstByteWindowMs);
  });
});

/** A waking answer from a wake door. */
const wakingResponse = (retryAfter = "5"): Response =>
  new Response(null, { status: 503, headers: { [WAKING_HEADER]: "1", "Retry-After": retryAfter } });

/** A response as a host `fetch` that cannot clone hands it back (Expo's `clone()` throws). */
class NoCloneResponse extends Response {
  override clone(): Response {
    throw new Error("Not implemented");
  }
}

/** A `send` that answers each call with the next scripted response. */
function doorSends(responses: ReadonlyArray<() => Response>): {
  send: () => Promise<Response>;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    send: async () => {
      const next = responses[calls];
      calls += 1;
      if (next === undefined) throw new Error("doorSends: no response left");
      return next();
    },
  };
}

describe("sendUnderWakeBudget — the wake doors' policy", () => {
  it("hands back the first answer untouched when it is not a wake", async () => {
    for (const make of [
      () => new Response("{}", { status: 200 }),
      () => new Response(null, { status: 404 }),
      () => new Response("Service Unavailable", { status: 503 }),
    ]) {
      const d = doorSends([make]);
      const { sleep, waits } = clockSleep();
      const res = await sendUnderWakeBudget(d.send, { sleep });
      expect(d.calls()).toBe(1);
      expect(waits).toEqual([]);
      expect(res.status).toBe(make().status);
    }
  });

  it("re-sends on a waking answer and hands back the woken one", async () => {
    const d = doorSends([() => wakingResponse("4"), () => new Response('{"ok":1}', { status: 200 })]);
    const { sleep, waits } = clockSleep();
    const infos: WakeWaitInfo[] = [];
    const res = await sendUnderWakeBudget(d.send, { sleep, onWakeWait: (i) => infos.push(i) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: 1 });
    expect(d.calls()).toBe(2);
    expect(waits).toEqual([4_000]);
    expect(infos).toEqual([{ elapsedMs: 0, budgetMs: WAKE_BUDGET_MS, attempt: 1 }]);
  });

  it("keeps waiting on an envelope-less 503 inside the open budget", async () => {
    const d = doorSends([
      () => wakingResponse("3"),
      () => new Response(null, { status: 503 }),
      () => new Response(null, { status: 200 }),
    ]);
    const { sleep } = clockSleep();
    const res = await sendUnderWakeBudget(d.send, { sleep });
    expect(res.status).toBe(200);
    expect(d.calls()).toBe(3);
  });

  it("a coded 503 ends the wait, and its body is still the door's to read", async () => {
    const d = doorSends([
      () => wakingResponse("3"),
      () => new Response(JSON.stringify({ code: "DRAINING", message: "draining" }), { status: 503 }),
    ]);
    const { sleep } = clockSleep();
    const res = await sendUnderWakeBudget(d.send, { sleep });
    expect(d.calls()).toBe(2);
    expect(await res.json()).toEqual({ code: "DRAINING", message: "draining" });
  });

  it("the end of the budget hands back the last answer", async () => {
    const d = doorSends(Array.from({ length: 30 }, () => () => wakingResponse("15")));
    const { sleep, waits } = clockSleep();
    const res = await sendUnderWakeBudget(d.send, { sleep });
    expect(res.status).toBe(503);
    expect(res.headers.get(WAKING_HEADER)).toBe("1");
    expect(waits.reduce((a, b) => a + b, 0)).toBe(WAKE_BUDGET_MS);
    expect(d.calls()).toBe(waits.length + 1);
  });

  it("the end of the budget after unmarked answers hands back the latest waking answer, as the invoke does", async () => {
    const d = doorSends([
      () => wakingResponse("15"),
      ...Array.from({ length: 30 }, () => () => new Response("Service Unavailable", { status: 503 })),
    ]);
    const { sleep } = clockSleep();
    const res = await sendUnderWakeBudget(d.send, { sleep });
    expect(res.status).toBe(503);
    expect(res.headers.get(WAKING_HEADER)).toBe("1");
    expect(res.bodyUsed).toBe(false);
  });

  it("a door's own budgetMs bounds its wait", async () => {
    const d = doorSends(Array.from({ length: 30 }, () => () => wakingResponse("15")));
    const { sleep, waits } = clockSleep();
    const infos: WakeWaitInfo[] = [];
    await sendUnderWakeBudget(d.send, { sleep, budgetMs: 40_000, onWakeWait: (i) => infos.push(i) });
    expect(waits).toEqual([15_000, 15_000, 10_000]);
    expect(infos.every((i) => i.budgetMs === 40_000)).toBe(true);
  });

  it("a budget of nothing hands back the first waking answer without a wait", async () => {
    const d = doorSends([() => wakingResponse("5"), () => new Response(null, { status: 200 })]);
    const { sleep, waits } = clockSleep();
    const res = await sendUnderWakeBudget(d.send, { sleep, budgetMs: 0 });
    expect(res.status).toBe(503);
    expect(waits).toEqual([]);
    expect(d.calls()).toBe(1);
  });

  it("never clones or reads an answer while no budget is open: a host fetch that cannot clone sees the old path", async () => {
    // An old server's coded 503 reaches the door exactly as it did before the wake budget.
    const coded503 = new NoCloneResponse(JSON.stringify({ code: "DRAINING", message: "draining" }), {
      status: 503,
      headers: { "Retry-After": "5" },
    });
    const res = await sendUnderWakeBudget(async () => coded503);
    expect(res).toBe(coded503);
    expect(res.bodyUsed).toBe(false);
  });

  it("waits out a wake on a host fetch that cannot clone, reading each waited answer in full", async () => {
    const first = new NoCloneResponse("", { status: 503, headers: { [WAKING_HEADER]: "1", "Retry-After": "3" } });
    const d = doorSends([() => first, () => new NoCloneResponse('{"ok":1}', { status: 200 })]);
    const { sleep } = clockSleep();
    const res = await sendUnderWakeBudget(d.send, { sleep });
    expect(await res.json()).toEqual({ ok: 1 });
    // The waited-out answer was consumed, not left holding its connection.
    expect(first.bodyUsed).toBe(true);
  });

  it("an abort during a wait hands back the answer that caused it", async () => {
    const controller = new AbortController();
    const d = doorSends([() => wakingResponse("5"), () => new Response(null, { status: 200 })]);
    const res = await sendUnderWakeBudget(d.send, {
      signal: controller.signal,
      onWakeWait: () => controller.abort(),
    });
    expect(res.status).toBe(503);
    expect(d.calls()).toBe(1);
  });
});
