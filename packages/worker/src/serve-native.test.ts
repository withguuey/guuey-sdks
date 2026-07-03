import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { serveNativeOn } from "./serve-native.js";
import type { Invoke } from "./protocol.js";

function invokeLine(input: string): string {
  const invoke: Invoke = {
    type: "invoke",
    input,
    identity: { userId: "u1", authMode: "anonymous" },
    fs: { app: "/app", home: "/home", session: "/session" },
    history: [],
  };
  return JSON.stringify(invoke) + "\n";
}

async function run(lines: string, handler: Parameters<typeof serveNativeOn>[0]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serveNativeOn(
    handler,
    { framework: "claude-agent-sdk", sdkName: "sdk", sdkVersion: "1.0.0" },
    { input, output }
  );
  input.end(lines);
  await done;
  return (
    output
      .read()
      ?.toString("utf8")
      .trim()
      .split("\n")
      .map((l: string) => JSON.parse(l)) ?? []
  );
}

describe("serveNativeOn", () => {
  it("emits hello, native events from the handler, then done with the returned result", async () => {
    const events = await run(invokeLine("hi"), async (invoke, emit) => {
      emit.native({ kind: "sdk-msg", echo: invoke.input });
      return "final answer";
    });
    expect(events[0]).toEqual({
      type: "hello",
      framework: "claude-agent-sdk",
      sdkName: "sdk",
      sdkVersion: "1.0.0",
    });
    expect(events[1]).toEqual({
      type: "native",
      framework: "claude-agent-sdk",
      event: { kind: "sdk-msg", echo: "hi" },
    });
    expect(events[2]).toEqual({ type: "done", stopReason: "end_turn", result: "final answer" });
  });

  it("emits error (not done) when the handler throws", async () => {
    const events = await run(invokeLine("hi"), async () => {
      throw new Error("boom");
    });
    expect(events[0]?.type).toBe("hello");
    expect(events[1]).toEqual({ type: "error", message: "boom" });
  });

  it("a void handler return produces done with empty result", async () => {
    const events = await run(invokeLine("hi"), async () => {});
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn", result: "" });
  });
});
