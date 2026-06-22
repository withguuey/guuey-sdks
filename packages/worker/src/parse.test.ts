import { describe, it, expect } from "vitest";
import { parseControl, isInvoke, isShutdown } from "./parse.js";
import { parseEvent, isText, isDone, isError } from "./parse.js";

const INVOKE = JSON.stringify({
  type: "invoke",
  input: "hi",
  identity: { userId: "u1", authMode: "anonymous" },
  fs: { app: "/app", home: "/home", session: "/session" },
  history: [{ role: "user", text: "earlier" }],
});

describe("parseControl", () => {
  it("parses a valid invoke into a typed Invoke", () => {
    const msg = parseControl(INVOKE);
    expect(isInvoke(msg)).toBe(true);
    if (isInvoke(msg)) {
      expect(msg.input).toBe("hi");
      expect(msg.identity.userId).toBe("u1");
      expect(msg.fs.session).toBe("/session");
      expect(msg.history).toEqual([{ role: "user", text: "earlier" }]);
    }
  });

  it("parses shutdown", () => {
    expect(isShutdown(parseControl(JSON.stringify({ type: "shutdown" })))).toBe(true);
  });

  it("defaults a missing history to []", () => {
    const noHist = JSON.stringify({
      type: "invoke",
      input: "x",
      identity: { userId: "u", authMode: "authenticated" },
      fs: { app: "/app", home: "/home", session: "/session" },
    });
    const msg = parseControl(noHist);
    if (isInvoke(msg)) expect(msg.history).toEqual([]);
    else throw new Error("expected invoke");
  });

  it("throws on non-JSON", () => {
    expect(() => parseControl("not json")).toThrow(/non-JSON control line/);
  });

  it("throws on an invoke missing required fields", () => {
    expect(() => parseControl(JSON.stringify({ type: "invoke", input: "x" }))).toThrow(/invoke/);
  });

  it("throws on an unknown control type", () => {
    expect(() => parseControl(JSON.stringify({ type: "frobnicate" }))).toThrow(
      /unknown control message type/
    );
  });
});

describe("parseEvent (Worker→Router fd-3 events)", () => {
  it("parses text / done / error", () => {
    expect(parseEvent(JSON.stringify({ type: "text", text: "hi" }))).toEqual({
      type: "text",
      text: "hi",
    });
    const done = parseEvent(JSON.stringify({ type: "done", stopReason: "end_turn", result: "ok" }));
    expect(isDone(done)).toBe(true);
    if (isDone(done)) expect(done.result).toBe("ok");
    expect(isError(parseEvent(JSON.stringify({ type: "error", message: "boom" })))).toBe(true);
    expect(isText(parseEvent(JSON.stringify({ type: "text", text: "x" })))).toBe(true);
  });

  it("done normalizes an unknown stopReason to end_turn + defaults a missing result", () => {
    const d = parseEvent(JSON.stringify({ type: "done", stopReason: "weird" }));
    expect(d).toEqual({ type: "done", stopReason: "end_turn", result: "" });
  });

  it("throws on non-JSON, non-object, missing text, and unknown type", () => {
    expect(() => parseEvent("nope")).toThrow(/non-JSON event line/);
    // A valid-JSON, non-object line (e.g. a bare number) is a protocol violation.
    expect(() => parseEvent("42")).toThrow(/event line is not an object/);
    expect(() => parseEvent(JSON.stringify({ type: "text" }))).toThrow(/text event missing string/);
    expect(() => parseEvent(JSON.stringify({ type: "frob" }))).toThrow(/unknown event type/);
  });
});
