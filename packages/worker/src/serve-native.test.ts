import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { serveNativeOn, resolveInstalledVersion, type NativeServeInfo } from "./serve-native.js";
import { HOST_SUSPEND_CAPABILITY, type Invoke } from "./protocol.js";
import { parseEvent } from "./parse.js";
import { drained } from "./fixtures/drained.js";

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
  const bytes = drained(output).trim();
  return bytes === "" ? [] : bytes.split("\n").map((l: string) => JSON.parse(l));
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

/**
 * The suspend opt-in. Without BOTH the host's `info.suspend` and the invoke's
 * offer, the fd-3 bytes must be exactly today's: an older Router fails the turn
 * on an unknown event, and a capability it never asked for is noise.
 */
describe("serveNativeOn — suspend", () => {
  const offered = { suspend: { maxEnvelopeBytes: 1024 } };
  const invokeWith = (input: string, extra: object) =>
    JSON.stringify({
      type: "invoke",
      input,
      identity: { userId: "u1", authMode: "anonymous" },
      fs: { app: "/app", home: "/home", session: "/session" },
      history: [],
      ...extra,
    }) + "\n";
  const baseInfo: NativeServeInfo = { framework: "openai-agents-sdk", sdkName: "sdk", sdkVersion: "1.0.0" };

  /**
   * The fd-3 bytes of two invokes (`hi`, `again`) through a handler that emits
   * a native and a text and returns "final answer", captured from serveNativeOn
   * BEFORE suspend existed. Pinned literally: this is the N−1 contract.
   */
  const BASELINE =
    '{"type":"hello","framework":"openai-agents-sdk","sdkName":"sdk","sdkVersion":"1.0.0"}\n' +
    '{"type":"native","framework":"openai-agents-sdk","event":{"kind":"sdk-msg","echo":"hi"}}\n' +
    '{"type":"text","text":"partial"}\n' +
    '{"type":"done","stopReason":"end_turn","result":"final answer"}\n' +
    '{"type":"hello","framework":"openai-agents-sdk","sdkName":"sdk","sdkVersion":"1.0.0"}\n' +
    '{"type":"native","framework":"openai-agents-sdk","event":{"kind":"sdk-msg","echo":"again"}}\n' +
    '{"type":"text","text":"partial"}\n' +
    '{"type":"done","stopReason":"end_turn","result":"final answer"}\n';

  /** Run two invokes through a handler that tries to pause each turn; return the raw fd-3 bytes and each suspend result. */
  async function runRaw(info: NativeServeInfo, first: object, second: object) {
    const input = new PassThrough();
    const output = new PassThrough();
    const results: string[] = [];
    const done = serveNativeOn(
      async (invoke, emit) => {
        emit.native({ kind: "sdk-msg", echo: invoke.input });
        emit.text("partial");
        results.push(emit.suspend('{"run":"state"}', ["approval_call_1"]));
        return "final answer";
      },
      info,
      { input, output },
    );
    input.end(invokeWith("hi", first) + invokeWith("again", second));
    await done;
    return { bytes: drained(output), results };
  }

  it("without the host's opt-in: the offer is ignored and the bytes are today's", async () => {
    const { bytes, results } = await runRaw(baseInfo, offered, offered);
    expect(bytes).toBe(BASELINE);
    expect(results).toEqual(["not_offered", "not_offered"]);
  });

  it("with the host's opt-in but no offer: the bytes are today's, and the hello names no capability", async () => {
    const { bytes, results } = await runRaw({ ...baseInfo, suspend: true }, {}, {});
    expect(bytes).toBe(BASELINE);
    expect(bytes).not.toContain(HOST_SUSPEND_CAPABILITY);
    expect(results).toEqual(["not_offered", "not_offered"]);
  });

  it("with both: hello{capabilities:[host.suspend.v1]} → native* → suspend → done, and only on the offered invoke", async () => {
    const { bytes, results } = await runRaw({ ...baseInfo, suspend: true }, offered, {});
    const events = bytes.trim().split("\n").map((l) => parseEvent(l));
    expect(events.map((e) => e.type)).toEqual([
      "hello", "native", "text", "suspend", "done",
      "hello", "native", "text", "done",
    ]);
    expect(events[0]).toEqual({
      type: "hello",
      framework: "openai-agents-sdk",
      sdkName: "sdk",
      sdkVersion: "1.0.0",
      capabilities: [HOST_SUSPEND_CAPABILITY],
    });
    expect(events[3]).toEqual({ type: "suspend", envelope: '{"run":"state"}', askIds: ["approval_call_1"] });
    expect(events[5]).toEqual({ type: "hello", framework: "openai-agents-sdk", sdkName: "sdk", sdkVersion: "1.0.0" });
    expect(results).toEqual(["written", "not_offered"]);
    // The second, un-offered invoke's bytes are today's second invoke's bytes.
    expect(bytes.endsWith(BASELINE.split("\n").slice(4).join("\n"))).toBe(true);
  });

  it("reports over_cap and writes nothing when the envelope is larger than the offer", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let result = "";
    const done = serveNativeOn(
      async (_invoke, emit) => {
        result = emit.suspend("x".repeat(64), ["approval_call_1"]);
        return "r";
      },
      { ...baseInfo, suspend: true },
      { input, output },
    );
    input.end(invokeWith("hi", { suspend: { maxEnvelopeBytes: 16 } }));
    await done;
    const types = drained(output).trim().split("\n").map((l) => parseEvent(l).type);
    expect(result).toBe("over_cap");
    expect(types).toEqual(["hello", "done"]);
  });
});

describe("resolveInstalledVersion — the hello handshake's runtime resolution", () => {
  it("resolves an installed package's real version (never the manifest range)", () => {
    const v = resolveInstalledVersion("zod");
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
  it("returns null for a package that is not installed (bundled-worker degradation)", () => {
    expect(resolveInstalledVersion("@guuey/definitely-not-installed")).toBeNull();
  });
});
