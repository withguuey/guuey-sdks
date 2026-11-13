/**
 * N−1 across a rolling release for a message TYPE one side does not know (guuey#3434, both directions).
 *
 * - The current parsers return a well-formed line of an unknown type as a typed "unknown" (`UnknownControl`,
 *   `UnknownEvent`): a FRESH object with exactly `type` and `rawType`, never the line itself, so no other field of
 *   the sender's object rides along (hardening's ask for guuey#3435).
 * - `parseEvent` keeps today's throw on an unknown type until the Router's readers move to `readEvent` (guuey#3435).
 * - The parser frozen BEFORE this change (`fixtures/parse.pre-unknown-type.prev.ts`) still throws on an unknown type
 *   in both directions. That is why a new type may only be sent to a peer that advertised it (the capability gate):
 *   a side deployed before this fix cannot be fixed after the fact.
 * - Every line the frozen parser accepts, the current one reads exactly the same.
 */
import { describe, expect, it } from "vitest";
import { isUnknownControl, isUnknownEvent, parseControl, parseEvent, readEvent } from "./parse.js";
import { parseControl as parseControlPrev, parseEvent as parseEventPrev } from "./fixtures/parse.pre-unknown-type.prev.js";

const INVOKE = JSON.stringify({
  type: "invoke",
  input: "hi",
  identity: { userId: "u", authMode: "authenticated" },
  fs: { app: "/app", home: "/home", session: "/session" },
  history: [],
});
const FUTURE_CONTROL = JSON.stringify({ type: "cancel", turnId: "t1", reason: "user" });
const FUTURE_EVENT = JSON.stringify({ type: "progress", pct: 40, secret: "s3cr3t" });

describe("control direction: a NEWER Router's control type reaches this release", () => {
  it("comes back as UnknownControl with exactly type and rawType", () => {
    const msg = parseControl(FUTURE_CONTROL);
    expect(isUnknownControl(msg)).toBe(true);
    expect(msg).toEqual({ type: "unknown", rawType: "cancel" });
    expect(Object.keys(msg)).toEqual(["type", "rawType"]);
  });

  it("a line whose type is literally 'unknown' is the same typed value, with no other field", () => {
    const msg = parseControl(JSON.stringify({ type: "unknown", x: 1 }));
    expect(msg).toEqual({ type: "unknown", rawType: "unknown" });
    expect(Object.keys(msg)).toEqual(["type", "rawType"]);
  });

  it("the frozen OLDER parser throws on the same line (an older host would die: the capability gate is required)", () => {
    expect(() => parseControlPrev(FUTURE_CONTROL)).toThrow(/unknown control message type: cancel/);
  });

  it("every line the older parser accepts reads the same now", () => {
    expect(parseControl(INVOKE)).toEqual(parseControlPrev(INVOKE));
    expect(parseControl(JSON.stringify({ type: "shutdown" }))).toEqual(parseControlPrev(JSON.stringify({ type: "shutdown" })));
  });
});

describe("event direction: a NEWER host's event type reaches this release", () => {
  it("readEvent returns UnknownEvent with exactly type and rawType, never the line's other fields", () => {
    const ev = readEvent(FUTURE_EVENT);
    expect(isUnknownEvent(ev)).toBe(true);
    expect(ev).toEqual({ type: "unknown", rawType: "progress" });
    expect(Object.keys(ev)).toEqual(["type", "rawType"]);
    expect(JSON.stringify(ev)).not.toContain("s3cr3t");
  });

  it("a line whose type is literally 'unknown' is the same typed value, with no other field", () => {
    const ev = readEvent(JSON.stringify({ type: "unknown", x: 1 }));
    expect(ev).toEqual({ type: "unknown", rawType: "unknown" });
    expect(Object.keys(ev)).toEqual(["type", "rawType"]);
  });

  it("parseEvent still throws on it, as before, until the Router's readers move (guuey#3435)", () => {
    expect(() => parseEvent(FUTURE_EVENT)).toThrow(/unknown event type: progress/);
  });

  it("the frozen OLDER parser throws on the same line (an older Router ends the turn)", () => {
    expect(() => parseEventPrev(FUTURE_EVENT)).toThrow(/unknown event type: progress/);
  });

  it("a malformed line still throws from readEvent: non-JSON, non-object, no string type, a malformed known event", () => {
    expect(() => readEvent("nope")).toThrow(/non-JSON event line/);
    expect(() => readEvent("42")).toThrow(/event line is not an object/);
    expect(() => readEvent(JSON.stringify({ text: "x" }))).toThrow(/no string `type`/);
    expect(() => readEvent(JSON.stringify({ type: "text" }))).toThrow(/text event missing string/);
  });

  it("every event the older parser accepts reads the same now", () => {
    for (const line of [
      JSON.stringify({ type: "text", text: "a" }),
      JSON.stringify({ type: "done", stopReason: "end_turn", result: "r" }),
      JSON.stringify({ type: "error", message: "m" }),
    ]) {
      expect(readEvent(line)).toEqual(parseEventPrev(line));
      expect(parseEvent(line)).toEqual(parseEventPrev(line));
    }
  });
});
