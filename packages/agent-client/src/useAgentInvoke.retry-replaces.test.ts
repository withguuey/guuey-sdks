// @vitest-environment jsdom
/**
 * guuey#2608 — a Retry of a send that never reached the agent takes its row's
 * place: `send(text, { replaces })` drops the failed row (and its empty reply
 * placeholder) and its ledger entry as the new send starts, so the turn is
 * drawn once. The retry still takes its own id on the wire, and `replaces`
 * never rides the body. A row that is not marked failed is never dropped.
 */
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import { AGENT_ERROR_CODES } from "./error-codes.js";
import { AgentResponseError } from "./errors.js";
import type { AgentInvokeAdapters, InvokeRequest } from "./types.js";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type Step = "refuse" | "answer" | "hold";

const SATURATED = new AgentResponseError("agent is at capacity", 503, AGENT_ERROR_CODES.POD_SATURATED);

function podAdapters(steps: Step[]) {
  const bodies: unknown[] = [];
  let n = 0;
  let call = 0;
  // A "hold" step parks its turn mid-stream (after the session frame) until `release()`.
  let release: () => void = () => {
    throw new Error("no held turn yet");
  };
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => null, save: () => {} },
    generateId: () => `cmid-${++n}`,
    transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
      bodies.push(req.body);
      const step = steps[call++];
      if (step === undefined) throw new Error("no scripted step");
      if (step === "refuse") throw SATURATED;
      yield sse("session", { threadId: "t-1" });
      if (step === "hold") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      yield sse("message", { type: "text.delta", delta: "Hi." });
      yield sse("done", { stopReason: "end_turn" });
    },
  };
  return { adapters, bodies, release: () => release() };
}

function hook(adapters: AgentInvokeAdapters) {
  return renderHook(() => useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: "app-retry", adapters }));
}

describe("useAgentInvoke — a Retry replaces its failed row (guuey#2608)", () => {
  it("the failed row and its placeholder leave; the retried turn is drawn once under its own id", async () => {
    const { adapters, bodies } = podAdapters(["refuse", "answer"]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    expect(result.current.sendStates).toEqual({ "cmid-1": "failed" });
    expect(result.current.messages.filter((m) => m.role === "user")).toHaveLength(1);

    await act(async () => {
      await result.current.send("hello", { replaces: "cmid-1" });
    });
    expect(result.current.messages).toEqual([
      { role: "user", text: "hello", clientMessageId: "cmid-2", precedingTurnCount: 0 },
      { role: "assistant", text: "Hi." },
    ]);
    expect(result.current.sendStates).toEqual({});
    // Local only: the wire carries the retry's own id and nothing about the row it replaced.
    expect(bodies[1]).toEqual({ input: "hello", clientMessageId: "cmid-2" });
    unmount();
  });

  it("a retry that is refused again leaves exactly one failed row", async () => {
    const { adapters } = podAdapters(["refuse", "refuse"]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    await act(async () => {
      await result.current.send("hello", { replaces: "cmid-1" });
    });
    const users = result.current.messages.filter((m) => m.role === "user");
    expect(users).toEqual([{ role: "user", text: "hello", clientMessageId: "cmid-2", precedingTurnCount: 0 }]);
    expect(result.current.sendStates).toEqual({ "cmid-2": "failed" });
    unmount();
  });

  it("a row that reached the agent is never dropped, whatever the caller names", async () => {
    const { adapters } = podAdapters(["answer", "answer"]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    await act(async () => {
      await result.current.send("hello again", { replaces: "cmid-1" });
    });
    const users = result.current.messages.filter((m) => m.role === "user").map((m) => m.text);
    expect(users).toEqual(["hello", "hello again"]);
    unmount();
  });

  it("a Retry the hook refuses because a turn is under way drops nothing", async () => {
    const { adapters, bodies, release } = podAdapters(["refuse", "hold"]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    expect(result.current.sendStates).toEqual({ "cmid-1": "failed" });

    // A second turn starts and is still streaming when the Retry comes in.
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.send("something else");
    });
    expect(result.current.status).not.toBe("ready");
    await act(async () => {
      await result.current.send("hello", { replaces: "cmid-1" });
    });
    expect(result.current.messages.filter((m) => m.role === "user").map((m) => m.clientMessageId)).toEqual([
      "cmid-1",
      "cmid-2",
    ]);
    expect(result.current.sendStates["cmid-1"]).toBe("failed");
    expect(bodies).toHaveLength(2);

    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.sendStates["cmid-1"]).toBe("failed");
    unmount();
  });

  it("a blank send the hook refuses outright drops nothing", async () => {
    const { adapters } = podAdapters(["refuse"]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    await act(async () => {
      await result.current.send("   ", { replaces: "cmid-1" });
    });
    expect(result.current.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(result.current.sendStates).toEqual({ "cmid-1": "failed" });
    unmount();
  });
});
