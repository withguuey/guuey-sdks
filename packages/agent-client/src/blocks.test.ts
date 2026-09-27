import { describe, expect, it } from "vitest";
import { ingestMessageFrame } from "./blocks.js";

// A minimal VALID AgJSON event (the pod emits ONE such object per `message`
// frame in silver mode). `text.delta` requires { type, id, delta, seq }.
const delta = (d: string, seq: number) => ({ type: "text.delta", id: "b1", delta: d, seq });
// A bypass-mode SDKMessage shape — valid JSON, but NOT an AgEvent (`assistant`
// / `result` are not AgEvent `type` literals), so it must ingest to nothing.
const bypassAssistant = { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
const bypassResult = { type: "result", subtype: "success", result: "hi" };

describe("ingestMessageFrame", () => {
  it("ingests a single AgEvent OBJECT frame (the pod's shape)", () => {
    const out = ingestMessageFrame(delta("Hello", 1));
    expect(out.map((e) => e.type)).toEqual(["text.delta"]);
  });

  it("ingests an AgEvent[] ARRAY frame (the CLI dev-server's shape)", () => {
    const out = ingestMessageFrame([delta("A", 1), delta("B", 2)]);
    expect(out.map((e) => e.type)).toEqual(["text.delta", "text.delta"]);
  });

  it("object and single-element-array frames ingest identically (parity)", () => {
    const ev = delta("X", 1);
    expect(ingestMessageFrame(ev)).toEqual(ingestMessageFrame([ev]));
  });

  it("drops a bypass-mode SDKMessage object → [] (reducer is silver-only)", () => {
    expect(ingestMessageFrame(bypassAssistant)).toEqual([]);
    expect(ingestMessageFrame(bypassResult)).toEqual([]);
  });

  it("keeps only the valid AgEvents from a mixed array (parse-known-else-skip)", () => {
    const out = ingestMessageFrame([delta("ok", 1), bypassAssistant, delta("ok2", 2)]);
    expect(out.map((e) => e.type)).toEqual(["text.delta", "text.delta"]);
  });

  // A newer producer's frames reach an older client: an event type this core
  // does not know keeps its seq slot as core's `ext.agjson.ignored` stub (so a
  // reducer never parks on the gap), and an unknown field on a known event is
  // carried, not stripped. Neither is rejected, and neither drops its neighbours.
  it("an unknown event type keeps its seq slot as core's ignored stub, and an unknown field on a known event passes through", () => {
    const future = { type: "future.event", seq: 2, payload: { a: 1 } };
    const withFutureField = { ...delta("x", 3), futureField: { deep: true } };
    const out = ingestMessageFrame([delta("ok", 1), future, withFutureField]);
    expect(out.map((e) => [e.type, e.seq])).toEqual([
      ["text.delta", 1],
      ["ext.agjson.ignored", 2],
      ["text.delta", 3],
    ]);
    expect(out[1]).toMatchObject({ ignoredType: "future.event", raw: future });
    expect(out[2]).toMatchObject({ delta: "x", futureField: { deep: true } });
  });

  it("returns [] for non-JSON-value / malformed input", () => {
    expect(ingestMessageFrame(undefined)).toEqual([]);
    expect(ingestMessageFrame(() => 0)).toEqual([]);
    expect(ingestMessageFrame(Number.NaN)).toEqual([]);
    expect(ingestMessageFrame("keepalive")).toEqual([]);
    expect(ingestMessageFrame(null)).toEqual([]);
  });
});
