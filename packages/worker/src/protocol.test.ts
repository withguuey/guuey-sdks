import { describe, it, expect } from "vitest";
import {
  PROTOCOL_VERSION,
  type ControlMessage,
  type WorkerEvent,
  type Invoke,
  type JsonValue,
} from "./protocol.js";
import { parseEvent, isNative } from "./parse.js";
import { createEmitter } from "./emit.js";

describe("protocol v1 shapes", () => {
  it("pins the version to v1", () => {
    expect(PROTOCOL_VERSION).toBe("v1");
  });

  it("models the control union (invoke / shutdown)", () => {
    const invoke: ControlMessage = {
      type: "invoke",
      input: "hi",
      identity: { userId: "u1", authMode: "anonymous" },
      fs: { app: "/app", home: "/home", session: "/session" },
      history: [{ role: "user", text: "earlier" }],
    };
    const shutdown: ControlMessage = { type: "shutdown" };
    expect(invoke.type).toBe("invoke");
    expect(shutdown.type).toBe("shutdown");
  });

  it("models the event union (text / done / error)", () => {
    const events: WorkerEvent[] = [
      { type: "text", text: "hello" },
      { type: "done", stopReason: "end_turn", result: "final" },
      { type: "error", message: "boom" },
    ];
    expect(events.map((e) => e.type)).toEqual(["text", "done", "error"]);
  });

  it("Invoke is the invoke arm of the control union", () => {
    const i: Invoke = {
      type: "invoke",
      input: "x",
      identity: { userId: "u", authMode: "authenticated" },
      fs: { app: "/app", home: "/home", session: "/session" },
      history: [],
    };
    const j: JsonValue = { a: [1, "two", true, null] };
    expect(i.history).toEqual([]);
    expect(j).toEqual({ a: [1, "two", true, null] });
  });
});

describe("NativeEvent carrier", () => {
  it("round-trips a native event", () => {
    const lines: string[] = [];
    const emitter = createEmitter({
      write: (s) => {
        lines.push(s);
      },
    });
    emitter.native("claude-agent-sdk", { type: "assistant", message: { id: "m1" } });
    const ev = parseEvent(lines[0].trim());
    expect(isNative(ev)).toBe(true);
    if (isNative(ev)) {
      expect(ev.framework).toBe("claude-agent-sdk");
      expect(ev.event).toEqual({ type: "assistant", message: { id: "m1" } });
    }
  });

  it("text/done/error still parse (unchanged)", () => {
    expect(isNative(parseEvent('{"type":"text","text":"hi"}'))).toBe(false);
  });
});
