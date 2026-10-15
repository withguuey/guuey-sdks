/**
 * N−1 across a rolling release for ending a conversation from a worker.
 *
 * - An OLDER Router (its `parseEvent` frozen in `fixtures/parse-event.prev.ts`)
 *   reads a NEWER worker's closing `done`: it rebuilds the event from
 *   `stopReason` and `result`, so `endThread` is dropped and the turn ends as
 *   an ordinary turn.
 * - An OLDER worker (its `parseControl` frozen in
 *   `fixtures/parse-control.prev.ts`) reads a NEWER Router's invoke with
 *   `threadClose`: the offer is dropped, so it can never close.
 * - The current parsers read the older wires exactly as the previous ones did.
 */
import { describe, it, expect } from "vitest";
import { parseControl, parseEvent } from "./parse.js";
import { parseEvent as parseEventPrev } from "./fixtures/parse-event.prev.js";
import { parseControl as parseControlPrev } from "./fixtures/parse-control.prev.js";

const OLD_DONE = { type: "done", stopReason: "end_turn", result: "This chat is full." };
const NEW_DONE = { ...OLD_DONE, endThread: { code: "CHAT_FULL", message: "This chat is full." } };

const OLD_INVOKE = {
  type: "invoke",
  input: "hello",
  identity: { userId: "u1", authMode: "authenticated" },
  fs: { app: "/app", home: "/home", session: "/session" },
  fsBound: true,
  history: [{ role: "user", text: "earlier" }],
};
const NEW_INVOKE = { ...OLD_INVOKE, threadClose: {} };

describe("the previous Router's parseEvent (frozen) × a new worker's closing done", () => {
  it("reads it as the same done without endThread", () => {
    expect(parseEventPrev(JSON.stringify(NEW_DONE))).toEqual(OLD_DONE);
    expect(parseEventPrev(JSON.stringify(NEW_DONE))).toEqual(parseEventPrev(JSON.stringify(OLD_DONE)));
  });

  it("still reads a malformed endThread without throwing", () => {
    expect(parseEventPrev(JSON.stringify({ ...OLD_DONE, endThread: 7 }))).toEqual(OLD_DONE);
  });
});

describe("the current parseEvent × an old worker's done", () => {
  it("reads it as the previous parser does, with no endThread", () => {
    const now = parseEvent(JSON.stringify(OLD_DONE));
    expect(now).toEqual(parseEventPrev(JSON.stringify(OLD_DONE)));
    expect("endThread" in now).toBe(false);
  });

  it("differs from the previous parser on the new done ONLY by endThread", () => {
    expect(parseEvent(JSON.stringify(NEW_DONE))).toEqual({ ...parseEventPrev(JSON.stringify(NEW_DONE)), endThread: NEW_DONE.endThread });
  });
});

describe("the previous worker's parseControl (frozen) × a new Router's offer", () => {
  it("reads the new invoke and drops threadClose: the same turn as without it", () => {
    const fromNew = parseControlPrev(JSON.stringify(NEW_INVOKE));
    expect(fromNew).toEqual(parseControlPrev(JSON.stringify(OLD_INVOKE)));
    expect("threadClose" in fromNew).toBe(false);
  });
});

describe("the current parseControl × an old Router's invoke", () => {
  it("reads it with no offer", () => {
    const now = parseControl(JSON.stringify(OLD_INVOKE));
    expect(now).toEqual(parseControlPrev(JSON.stringify(OLD_INVOKE)));
    expect("threadClose" in now).toBe(false);
  });

  it("differs from the previous parser on the new invoke ONLY by threadClose", () => {
    expect(parseControl(JSON.stringify(NEW_INVOKE))).toEqual({ ...parseControlPrev(JSON.stringify(NEW_INVOKE)), threadClose: {} });
  });
});
