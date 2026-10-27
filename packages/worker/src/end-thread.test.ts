/**
 * Ending a conversation from a worker: `NativeEmit.endThread`, its validation,
 * the offer that gates it (`Invoke.threadClose`), and the `done` that carries
 * it.
 */
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { serveNativeOn, type NativeEmit } from "./serve-native.js";
import { parseControl, parseEvent } from "./parse.js";
import { endThreadProblem, END_THREAD_MESSAGE_MAX_CHARS } from "./end-thread.js";
import { drained } from "./fixtures/drained.js";

const BASE_INVOKE = {
  type: "invoke",
  input: "hi",
  identity: { userId: "u1", authMode: "anonymous" },
  fs: { app: "/app", home: "/home", session: "/session" },
  history: [],
};

async function runOne(extra: object, body: (emit: NativeEmit) => unknown): Promise<{ bytes: string; result: unknown }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let result: unknown;
  const done = serveNativeOn(
    async (_invoke, emit) => {
      result = body(emit);
      return "final answer";
    },
    { framework: "claude-agent-sdk", sdkName: "sdk", sdkVersion: "1.0.0" },
    { input, output },
  );
  input.end(JSON.stringify({ ...BASE_INVOKE, ...extra }) + "\n");
  await done;
  return { bytes: drained(output), result };
}

function lastEvent(bytes: string): unknown {
  const lines = bytes.trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "null");
}

describe("endThreadProblem", () => {
  it("accepts an upper-case code and a 1–500 character message", () => {
    expect(endThreadProblem({ code: "CHAT_FULL", message: "This chat is full." })).toBeUndefined();
    expect(endThreadProblem({ code: "A", message: "x" })).toBeUndefined();
    expect(endThreadProblem({ code: "A" + "B".repeat(39), message: "x" })).toBeUndefined();
    expect(endThreadProblem({ code: "X", message: "line one\nline two" })).toBeUndefined();
    expect(endThreadProblem({ code: "X", message: "é".repeat(END_THREAD_MESSAGE_MAX_CHARS) })).toBeUndefined();
  });

  it.each([
    ["lower case", "chat_full"],
    ["a leading digit", "1CHAT"],
    ["a leading underscore", "_CHAT"],
    ["a hyphen", "CHAT-FULL"],
    ["41 characters", "A" + "B".repeat(40)],
    ["empty", ""],
    ["a prefix", "app:CHAT_FULL"],
  ])("refuses a code with %s", (_label, code) => {
    expect(endThreadProblem({ code, message: "x" })).toMatch(/code/);
  });

  it.each([
    ["empty", ""],
    ["over 500 characters", "x".repeat(END_THREAD_MESSAGE_MAX_CHARS + 1)],
    ["a tab", "a\tb"],
    ["a carriage return", "a\r\nb"],
    ["a NUL", "a\u0000b"],
    ["a C1 control", "a\u0085b"],
  ])("refuses a message that is %s", (_label, message) => {
    expect(endThreadProblem({ code: "CHAT_FULL", message })).toMatch(/message/);
  });

  it("counts characters, not UTF-16 units", () => {
    // 500 astral characters are 1000 UTF-16 units, and still 500 characters.
    expect(endThreadProblem({ code: "X", message: "😀".repeat(END_THREAD_MESSAGE_MAX_CHARS) })).toBeUndefined();
  });
});

describe("NativeEmit.endThread", () => {
  const close = { code: "CHAT_FULL", message: "This chat is full. Start a new one." };

  it("on an offered invoke: answers ok and the turn's done carries endThread", async () => {
    const { bytes, result } = await runOne({ threadClose: {} }, (emit) => emit.endThread(close));
    expect(result).toBe("ok");
    expect(lastEvent(bytes)).toEqual({ type: "done", stopReason: "end_turn", result: "final answer", endThread: close });
  });

  it("without the offer: answers not_offered and the bytes are today's", async () => {
    const { bytes, result } = await runOne({}, (emit) => emit.endThread(close));
    const baseline = await runOne({}, () => undefined);
    expect(result).toBe("not_offered");
    expect(bytes).toBe(baseline.bytes);
    expect(bytes).not.toContain("endThread");
  });

  it("throws a TypeError on an invalid code or message, offered or not, and writes nothing for it", async () => {
    for (const extra of [{ threadClose: {} }, {}]) {
      const { bytes, result } = await runOne(extra, (emit) => {
        try {
          emit.endThread({ code: "chat_full", message: "x" });
          return "no throw";
        } catch (e) {
          return e instanceof TypeError ? "TypeError" : "other";
        }
      });
      expect(result).toBe("TypeError");
      expect(bytes).not.toContain("endThread");
    }
  });

  it("writes only the two fields, as given", async () => {
    const { bytes } = await runOne({ threadClose: {} }, (emit) => {
      const extra = { code: "CHAT_FULL", message: "full", other: "dropped" };
      return emit.endThread(extra);
    });
    expect(lastEvent(bytes)).toEqual({
      type: "done",
      stopReason: "end_turn",
      result: "final answer",
      endThread: { code: "CHAT_FULL", message: "full" },
    });
  });

  it("the last call of the turn wins", async () => {
    const { bytes } = await runOne({ threadClose: {} }, (emit) => {
      emit.endThread({ code: "FIRST", message: "first" });
      return emit.endThread({ code: "SECOND", message: "second" });
    });
    expect(lastEvent(bytes)).toMatchObject({ endThread: { code: "SECOND", message: "second" } });
  });

  it("does not carry over to the next invoke", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let turn = 0;
    const done = serveNativeOn(
      async (_invoke, emit) => {
        turn += 1;
        if (turn === 1) emit.endThread(close);
        return "r";
      },
      { framework: "claude-agent-sdk", sdkName: "sdk", sdkVersion: "1.0.0" },
      { input, output },
    );
    const line = JSON.stringify({ ...BASE_INVOKE, threadClose: {} }) + "\n";
    input.end(line + line);
    await done;
    const dones = drained(output)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "done");
    expect(dones).toEqual([
      { type: "done", stopReason: "end_turn", result: "r", endThread: close },
      { type: "done", stopReason: "end_turn", result: "r" },
    ]);
  });

  it("a handler that throws after endThread ends with error, never a closing done", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const done = serveNativeOn(
      async (_invoke, emit) => {
        emit.endThread(close);
        throw new Error("boom");
      },
      { framework: "claude-agent-sdk", sdkName: "sdk", sdkVersion: "1.0.0" },
      { input, output },
    );
    input.end(JSON.stringify({ ...BASE_INVOKE, threadClose: {} }) + "\n");
    await done;
    const bytes = drained(output);
    expect(lastEvent(bytes)).toEqual({ type: "error", message: "boom" });
    expect(bytes).not.toContain("endThread");
  });
});

describe("parseControl: invoke.threadClose", () => {
  it("keeps an object offer as {}", () => {
    const parsed = parseControl(JSON.stringify({ ...BASE_INVOKE, threadClose: { future: 1 } }));
    expect(parsed).toMatchObject({ threadClose: {} });
    expect(parsed.type === "invoke" && parsed.threadClose).toEqual({});
  });

  it.each([["true", true], ["a string", "yes"], ["null", null], ["an array", []]])(
    "drops %s: no offer",
    (_label, threadClose) => {
      const parsed = parseControl(JSON.stringify({ ...BASE_INVOKE, threadClose }));
      expect("threadClose" in parsed).toBe(false);
    },
  );
});

describe("parseEvent: done.endThread", () => {
  const done = { type: "done", stopReason: "end_turn", result: "r" };

  it("keeps a valid endThread, reduced to its two fields", () => {
    expect(parseEvent(JSON.stringify({ ...done, endThread: { code: "CHAT_FULL", message: "full", x: 1 } }))).toEqual({
      ...done,
      endThread: { code: "CHAT_FULL", message: "full" },
    });
  });

  it.each([
    ["a bad code", { code: "chat", message: "m" }],
    ["an empty message", { code: "CHAT", message: "" }],
    ["a missing message", { code: "CHAT" }],
    ["a string", "CHAT_FULL"],
    ["null", null],
  ])("drops %s and keeps the done", (_label, endThread) => {
    expect(parseEvent(JSON.stringify({ ...done, endThread }))).toEqual(done);
  });
});
