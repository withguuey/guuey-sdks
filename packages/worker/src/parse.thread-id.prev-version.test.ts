/**
 * N−1 across a rolling release for the invoke's `threadId`:
 *
 * - An OLDER worker (its `parseControl` frozen in
 *   `fixtures/parse-control.pre-thread-id.prev.ts`) reads a NEWER Router's invoke
 *   that carries `threadId`: the field is dropped and the turn is the same as
 *   without it.
 * - The current parser reads an OLDER Router's invoke (no `threadId`) exactly
 *   as the previous parser did, and keeps `threadId` when a newer Router sends
 *   it.
 * - The current worker serves both shapes: the handler sees `threadId` only
 *   when the invoke carried it.
 */
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { parseControl, parseEvent } from "./parse.js";
import { serveNativeOn } from "./serve-native.js";
import type { WorkerEvent } from "./protocol.js";
import { parseControl as parseControlPrev } from "./fixtures/parse-control.pre-thread-id.prev.js";
import { drained } from "./fixtures/drained.js";

/** The previous release's invoke shape: no `threadId`. */
const OLD_INVOKE = {
  type: "invoke",
  input: "hello",
  identity: { userId: "u1", authMode: "authenticated" },
  fs: { app: "/app", home: "/home", session: "/session" },
  fsBound: true,
  history: [{ role: "user", text: "earlier" }],
  gguiAttached: true,
  threadClose: {},
};
const THREAD_ID = "0b5c3f1e-8d2a-4c7b-9e1f-3a4b5c6d7e8f";
const NEW_INVOKE = { ...OLD_INVOKE, threadId: THREAD_ID };

describe("the previous worker's parseControl (frozen) × a new Router's invoke with threadId", () => {
  it("reads the new invoke and drops threadId: the same turn as without it", () => {
    const fromNew = parseControlPrev(JSON.stringify(NEW_INVOKE));
    expect(fromNew).toEqual(parseControlPrev(JSON.stringify(OLD_INVOKE)));
    expect("threadId" in fromNew).toBe(false);
  });
});

describe("the current parseControl × an old Router's invoke (no threadId)", () => {
  it("reads it as the previous parser does, with no threadId", () => {
    const now = parseControl(JSON.stringify(OLD_INVOKE));
    expect(now).toEqual(parseControlPrev(JSON.stringify(OLD_INVOKE)));
    expect("threadId" in now).toBe(false);
  });

  it("keeps threadId on the new invoke, and differs from the previous parser ONLY by it", () => {
    const now = parseControl(JSON.stringify(NEW_INVOKE));
    const prev = parseControlPrev(JSON.stringify(NEW_INVOKE));
    expect(now).toEqual({ ...prev, threadId: THREAD_ID });
  });

  it.each([
    ["an empty string", ""],
    ["a number", 42],
    ["an object", { id: "t" }],
    ["null", null],
  ])("drops a malformed threadId (%s) without throwing", (_label, threadId) => {
    const now = parseControl(JSON.stringify({ ...OLD_INVOKE, threadId }));
    expect(now).toEqual(parseControl(JSON.stringify(OLD_INVOKE)));
    expect("threadId" in now).toBe(false);
  });
});

describe("the current worker serves both invoke shapes", () => {
  /** Serve one invoke line; return the fd-3 events and what the handler saw as `threadId`. */
  async function serveOne(invoke: object): Promise<{ events: WorkerEvent[]; seen: string[] }> {
    const input = new PassThrough();
    const output = new PassThrough();
    const seen: string[] = [];
    const done = serveNativeOn(
      async (inv) => {
        seen.push("threadId" in inv ? (inv.threadId ?? "UNDEFINED") : "ABSENT");
        return "ok";
      },
      { framework: "claude-agent-sdk", sdkName: "sdk", sdkVersion: "1.0.0" },
      { input, output },
    );
    input.end(JSON.stringify(invoke) + "\n");
    await done;
    const raw = drained(output);
    const events = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => parseEvent(l));
    return { events, seen };
  }

  it("an old Router's invoke (no threadId) runs the turn to done; the handler sees no threadId", async () => {
    const { events, seen } = await serveOne(OLD_INVOKE);
    expect(events.map((e) => e.type)).toEqual(["hello", "done"]);
    expect(seen).toEqual(["ABSENT"]);
  });

  it("a new Router's invoke runs the turn to done; the handler sees its threadId", async () => {
    const { events, seen } = await serveOne(NEW_INVOKE);
    expect(events.map((e) => e.type)).toEqual(["hello", "done"]);
    expect(seen).toEqual([THREAD_ID]);
  });
});
