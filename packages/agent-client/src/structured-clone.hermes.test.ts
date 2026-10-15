// @vitest-environment jsdom
/**
 * Runtimes without a global `structuredClone` (Hermes on React Native): the
 * block-preserving fold in `@silverprotocol/core` clones on the way in and out
 * of the Reducer, so every `preserveBlocks` turn failed there with
 * "Property 'structuredClone' doesn't exist". The package's entry points
 * install a structured clone before the core is first used. These tests
 * delete the global, re-evaluate the entries from scratch (so the install runs
 * against a runtime that lacks it) and drive a real fold.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { AgEvent } from "@silverprotocol/core";
import type { AgentInvokeAdapters, InvokeRequest } from "./types.js";

const nativeClone = globalThis.structuredClone;

/** One full assistant turn, as a live pod emits it (one AgEvent per SSE frame). */
const THREAD = "thread-1";
const TURN_ID = "turn-1";
const MSG = "msg-1";
const TEXT = "msg-1:text:0";
const TURN: AgEvent[] = [
  { type: "turn.start", seq: 0, turnId: TURN_ID, threadId: THREAD },
  { type: "message.start", seq: 1, id: MSG, turnId: TURN_ID, threadId: THREAD, role: "assistant" },
  { type: "text.start", seq: 2, id: TEXT, messageId: MSG, turnId: TURN_ID },
  { type: "text.delta", seq: 3, id: TEXT, messageId: MSG, delta: "Hello ", turnId: TURN_ID },
  { type: "text.delta", seq: 4, id: TEXT, messageId: MSG, delta: "World", turnId: TURN_ID },
  { type: "text.end", seq: 5, id: TEXT, messageId: MSG, turnId: TURN_ID },
  { type: "message.end", seq: 6, id: MSG },
  {
    type: "turn.done",
    seq: 7,
    turnId: TURN_ID,
    outcome: { type: "success", result: "Hello World" },
    finishReason: "stop",
  },
];

const silverFrames = () => TURN.map((ev) => `event: message\ndata: ${JSON.stringify(ev)}\n\n`);

function makeAdapters(frames: string[]): AgentInvokeAdapters {
  const store: Record<string, string> = {};
  return {
    storage: {
      load: (k) => (k in store ? store[k] : null),
      save: (k, v) => {
        store[k] = v;
      },
    },
    generateId: () => "cmid-test",
    transport: async function* (_req: InvokeRequest): AsyncGenerator<string> {
      yield 'event: session\ndata: {"threadId":"t1"}\n\n';
      for (const f of frames) yield f;
      yield "event: done\ndata: {}\n\n";
    },
  };
}

describe("entries on a runtime without structuredClone", () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, "structuredClone");
    vi.resetModules();
  });
  afterEach(() => {
    globalThis.structuredClone = nativeClone;
    vi.resetModules();
  });

  it("the runtime under test really lacks the global before the entry loads", () => {
    expect(typeof Reflect.get(globalThis, "structuredClone")).toBe("undefined");
  });

  it("evaluating either entry installs the clone before any caller can reach the core", async () => {
    await import("./index.js");
    const { structuredCloneSubset } = await import("./structured-clone.js");
    expect(Reflect.get(globalThis, "structuredClone")).toBe(structuredCloneSubset);
    vi.resetModules();
    Reflect.deleteProperty(globalThis, "structuredClone");
    await import("./react.js");
    const fresh = await import("./structured-clone.js");
    expect(Reflect.get(globalThis, "structuredClone")).toBe(fresh.structuredCloneSubset);
  });

  it("a preserveBlocks turn through the ./react entry folds without an error", async () => {
    const { useAgentInvoke } = await import("./react.js");
    const adapters = makeAdapters(silverFrames());
    const { result, unmount } = renderHook(() =>
      useAgentInvoke({
        endpointUrl: "https://pod.example.com",
        appId: "app-hermes",
        adapters,
        preserveBlocks: true,
      })
    );
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.error).toBeNull();
    expect(result.current.reduceResult?.messages).toHaveLength(1);
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "Hello World" });
    unmount();
  });

  it("a host fold with the root entry's Reducer re-export materializes a result", async () => {
    const { Reducer } = await import("./index.js");
    const reducer = new Reducer();
    for (const ev of TURN) reducer.push(ev);
    const first = reducer.result();
    const second = reducer.result();
    expect(first.messages).toHaveLength(1);
    // result() hands out copies: two reads never alias each other.
    expect(second).toEqual(first);
    expect(second.messages).not.toBe(first.messages);
  });
});
