/**
 * The native entry on a runtime without a global `structuredClone` (Hermes):
 * from @silverprotocol/core 0.12.7 the fold clones with its own routine, so
 * importing `./native` installs nothing and a block-preserving fold still runs.
 * React Native's primitives are inert stand-ins; nothing here renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgEvent } from "@silverprotocol/core";

vi.mock("react-native", () => {
  const Inert = () => null;
  return {
    View: Inert,
    Text: Inert,
    Pressable: Inert,
    Image: Inert,
    FlatList: Inert,
    AccessibilityInfo: { isReduceMotionEnabled: () => Promise.resolve(false) },
    Linking: { openURL: () => Promise.resolve() },
  };
});

const nativeClone = globalThis.structuredClone;

const THREAD = "thread-1";
const TURN_ID = "turn-1";
const MSG = "msg-1";
const TEXT = "msg-1:text:0";
const TURN: AgEvent[] = [
  { type: "turn.start", seq: 0, turnId: TURN_ID, threadId: THREAD },
  { type: "message.start", seq: 1, id: MSG, turnId: TURN_ID, threadId: THREAD, role: "assistant" },
  { type: "text.start", seq: 2, id: TEXT, messageId: MSG, turnId: TURN_ID },
  { type: "text.delta", seq: 3, id: TEXT, messageId: MSG, delta: "Hello", turnId: TURN_ID },
  { type: "text.end", seq: 4, id: TEXT, messageId: MSG, turnId: TURN_ID },
  { type: "message.end", seq: 5, id: MSG },
  {
    type: "turn.done",
    seq: 6,
    turnId: TURN_ID,
    outcome: { type: "success", result: "Hello" },
    finishReason: "stop",
  },
];

describe("@guuey/chat/native without a global structuredClone", () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, "structuredClone");
    vi.resetModules();
  });
  afterEach(() => {
    globalThis.structuredClone = nativeClone;
    vi.resetModules();
  });

  it("importing the native entry installs nothing, and a fold materializes without the global", async () => {
    expect(typeof Reflect.get(globalThis, "structuredClone")).toBe("undefined");
    await import("./native.js");
    expect(typeof Reflect.get(globalThis, "structuredClone")).toBe("undefined");

    const { Reducer } = await import("@silverprotocol/core");
    const reducer = new Reducer();
    for (const ev of TURN) reducer.push(ev);
    const first = reducer.result();
    expect(first.messages).toHaveLength(1);
    expect(reducer.result().messages).not.toBe(first.messages);
  });
});
