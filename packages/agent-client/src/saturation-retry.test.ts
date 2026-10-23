import { describe, expect, it } from "vitest";
import { withColdStartRetry, withSaturationRetry } from "./saturation-retry.js";
import { AgentResponseError } from "./errors.js";
import { AGENT_ERROR_CODES } from "./error-codes.js";
import type { InvokeRequest } from "./types.js";

const REQ: InvokeRequest = {
  url: "https://x.example/agent/invoke",
  body: {},
  signal: new AbortController().signal,
};

function saturated(): AgentResponseError {
  return new AgentResponseError("full", 503, AGENT_ERROR_CODES.POD_SATURATED, 1);
}

function transportFailing(times: number): { calls: () => number; t: (req: InvokeRequest) => AsyncGenerator<string> } {
  let calls = 0;
  return {
    calls: () => calls,
    t: async function* (_req: InvokeRequest) {
      calls += 1;
      if (calls <= times) throw saturated();
      yield "ok";
    },
  };
}

const instantSleep = async (): Promise<void> => {};

async function drain(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe("withSaturationRetry — attempts budget (guuey#406)", () => {
  it("default budget: one retry (two attempts), then the refusal propagates", async () => {
    const f = transportFailing(2);
    const wrapped = withSaturationRetry(f.t, { sleep: instantSleep });
    await expect(drain(wrapped(REQ))).rejects.toMatchObject({
      code: AGENT_ERROR_CODES.POD_SATURATED,
    });
    expect(f.calls()).toBe(2);
  });

  it("attempts: 3 survives two saturations and fires onSaturationWait per wait", async () => {
    const f = transportFailing(2);
    const waits: Array<{ attempt: number; totalAttempts: number; waitMs: number }> = [];
    const wrapped = withSaturationRetry(f.t, {
      sleep: instantSleep,
      attempts: 3,
      onSaturationWait: (info) => waits.push(info),
    });
    expect(await drain(wrapped(REQ))).toEqual(["ok"]);
    expect(f.calls()).toBe(3);
    expect(waits.map((w) => w.attempt)).toEqual([1, 2]);
    expect(waits.every((w) => w.totalAttempts === 4)).toBe(true);
  });

  it("exhaustion at the budget throws the LAST refusal, never loops past the cap", async () => {
    const f = transportFailing(99);
    const wrapped = withSaturationRetry(f.t, { sleep: instantSleep, attempts: 3 });
    await expect(drain(wrapped(REQ))).rejects.toMatchObject({
      code: AGENT_ERROR_CODES.POD_SATURATED,
    });
    expect(f.calls()).toBe(4); // attempts:3 = 3 retries + the first send
  });

  it("a non-saturation error never retries or fires the callback", async () => {
    let calls = 0;
    const boom = async function* (_req: InvokeRequest): AsyncGenerator<string> {
      calls += 1;
      if (calls > 0) throw new Error("network down");
      yield "unreachable"; // satisfies require-yield; the throw above always wins
    };
    const waits: unknown[] = [];
    const wrapped = withSaturationRetry(boom, {
      sleep: instantSleep,
      attempts: 3,
      onSaturationWait: (i) => waits.push(i),
    });
    await expect(drain(wrapped(REQ))).rejects.toThrow("network down");
    expect(calls).toBe(1);
    expect(waits).toHaveLength(0);
  });
});

describe("WORKER_POD_RESOURCE_EXHAUSTED before the stream is a capacity retry (guuey#2605)", () => {
  function exhausted(retryAfterSeconds?: number): AgentResponseError {
    return new AgentResponseError("capacity", 503, AGENT_ERROR_CODES.WORKER_POD_RESOURCE_EXHAUSTED, retryAfterSeconds);
  }

  it("is a published wire code", () => {
    expect(AGENT_ERROR_CODES.WORKER_POD_RESOURCE_EXHAUSTED).toBe("WORKER_POD_RESOURCE_EXHAUSTED");
  });

  it("a 503 + Retry-After refusal carrying it is re-sent after the hinted wait", async () => {
    let calls = 0;
    const once = async function* (_req: InvokeRequest): AsyncGenerator<string> {
      calls += 1;
      if (calls === 1) throw exhausted(5);
      yield "ok";
    };
    const slept: number[] = [];
    const waits: Array<{ attempt: number; totalAttempts: number; waitMs: number }> = [];
    const wrapped = withSaturationRetry(once, {
      sleep: async (ms) => {
        slept.push(ms);
      },
      onSaturationWait: (i) => waits.push(i),
    });
    expect(await drain(wrapped(REQ))).toEqual(["ok"]);
    expect(calls).toBe(2);
    expect(slept).toEqual([5_000]);
    expect(waits).toEqual([{ attempt: 1, totalAttempts: 2, waitMs: 5_000 }]);
  });

  it("with no Retry-After it takes the same fallback wait as POD_SATURATED, capped the same way", async () => {
    for (const [hint, expectedMs] of [
      [undefined, 15_000],
      [120, 30_000],
    ] as const) {
      let calls = 0;
      const once = async function* (_req: InvokeRequest): AsyncGenerator<string> {
        calls += 1;
        if (calls === 1) throw exhausted(hint);
        yield "ok";
      };
      const slept: number[] = [];
      const wrapped = withSaturationRetry(once, {
        sleep: async (ms) => {
          slept.push(ms);
        },
      });
      expect(await drain(wrapped(REQ))).toEqual(["ok"]);
      expect(slept).toEqual([expectedMs]);
    }
  });

  it("shares ONE budget with POD_SATURATED: a mix never retries past `attempts`", async () => {
    const sequence = [saturated(), exhausted(1), saturated(), exhausted(1)];
    let calls = 0;
    const mixed = async function* (_req: InvokeRequest): AsyncGenerator<string> {
      const refusal = sequence[calls];
      calls += 1;
      if (refusal !== undefined) throw refusal;
      yield "ok";
    };
    const waits: unknown[] = [];
    const wrapped = withSaturationRetry(mixed, {
      sleep: instantSleep,
      attempts: 2,
      onSaturationWait: (i) => waits.push(i),
    });
    // attempts:2 = the first send + 2 retries; the third refusal propagates.
    await expect(drain(wrapped(REQ))).rejects.toMatchObject({ code: AGENT_ERROR_CODES.POD_SATURATED });
    expect(calls).toBe(3);
    expect(waits).toHaveLength(2);
  });

  it("exhaustion at the budget throws the last WORKER_POD_RESOURCE_EXHAUSTED refusal", async () => {
    let calls = 0;
    const refused = async function* (_req: InvokeRequest): AsyncGenerator<string> {
      calls += 1;
      if (calls > 0) throw exhausted(1);
      yield "unreachable"; // satisfies require-yield; the throw above always wins
    };
    const wrapped = withSaturationRetry(refused, { sleep: instantSleep });
    await expect(drain(wrapped(REQ))).rejects.toMatchObject({
      code: AGENT_ERROR_CODES.WORKER_POD_RESOURCE_EXHAUSTED,
      status: 503,
    });
    expect(calls).toBe(2); // default budget: one retry
  });

  it("mid-turn (after a frame was yielded) it is never re-sent", async () => {
    let calls = 0;
    const midTurn = async function* (_req: InvokeRequest): AsyncGenerator<string> {
      calls += 1;
      yield "partial";
      throw exhausted(1);
    };
    const wrapped = withSaturationRetry(midTurn, { sleep: instantSleep, attempts: 3 });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const c of wrapped(REQ)) seen.push(c);
      })(),
    ).rejects.toMatchObject({ code: AGENT_ERROR_CODES.WORKER_POD_RESOURCE_EXHAUSTED });
    expect(seen).toEqual(["partial"]);
    expect(calls).toBe(1);
  });

  it("a non-capacity 503 + Retry-After code (DRAINING) is still never retried", async () => {
    let calls = 0;
    const draining = async function* (_req: InvokeRequest): AsyncGenerator<string> {
      calls += 1;
      if (calls > 0) throw new AgentResponseError("draining", 503, AGENT_ERROR_CODES.DRAINING, 1);
      yield "unreachable"; // satisfies require-yield; the throw above always wins
    };
    const waits: unknown[] = [];
    const wrapped = withSaturationRetry(draining, {
      sleep: instantSleep,
      attempts: 3,
      onSaturationWait: (i) => waits.push(i),
    });
    await expect(drain(wrapped(REQ))).rejects.toMatchObject({ code: AGENT_ERROR_CODES.DRAINING });
    expect(calls).toBe(1);
    expect(waits).toHaveLength(0);
  });

  it("the cold-start retry never takes it: it carries an envelope, so it is the pod refusing, not an empty ingress", async () => {
    let calls = 0;
    const refused = async function* (_req: InvokeRequest): AsyncGenerator<string> {
      calls += 1;
      if (calls > 0) {
        throw new AgentResponseError("capacity", 503, AGENT_ERROR_CODES.WORKER_POD_RESOURCE_EXHAUSTED, 5);
      }
      yield "unreachable"; // satisfies require-yield; the throw above always wins
    };
    const wrapped = withColdStartRetry(refused, { sleep: instantSleep, attempts: 3 });
    await expect(drain(wrapped(REQ))).rejects.toMatchObject({
      code: AGENT_ERROR_CODES.WORKER_POD_RESOURCE_EXHAUSTED,
    });
    expect(calls).toBe(1);
  });
});
