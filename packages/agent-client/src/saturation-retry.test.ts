import { describe, expect, it } from "vitest";
import { withSaturationRetry } from "./saturation-retry.js";
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
