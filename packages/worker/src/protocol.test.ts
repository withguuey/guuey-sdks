import { describe, it, expect } from "vitest";
import {
  PROTOCOL_VERSION,
  type ControlMessage,
  type WorkerEvent,
  type Invoke,
  type JsonValue,
} from "./protocol.js";

describe("protocol v1 shapes", () => {
  it("pins the version to v1", () => {
    expect(PROTOCOL_VERSION).toBe("v1");
  });

  it("models the control union (invoke / answer / shutdown)", () => {
    const invoke: ControlMessage = {
      type: "invoke",
      input: "hi",
      identity: { userId: "u1", authMode: "anonymous" },
      fs: { app: "/app", home: "/home", session: "/session" },
      history: [{ role: "user", text: "earlier" }],
    };
    const answer: ControlMessage = { type: "answer", value: { ok: true } };
    const shutdown: ControlMessage = { type: "shutdown" };
    expect(invoke.type).toBe("invoke");
    expect(answer.type).toBe("answer");
    expect(shutdown.type).toBe("shutdown");
  });

  it("models the event union (text / ask / done / error)", () => {
    const events: WorkerEvent[] = [
      { type: "text", text: "hello" },
      { type: "ask", prompt: "Formal or casual?", schema: { enum: ["formal", "casual"] } },
      { type: "done", stopReason: "end_turn", result: "final" },
      { type: "error", message: "boom" },
    ];
    expect(events.map((e) => e.type)).toEqual(["text", "ask", "done", "error"]);
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
