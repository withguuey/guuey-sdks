import { describe, expect, it } from "vitest";
import { ingestMessageFrame } from "./blocks";

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

  it("returns [] for non-JSON-value / malformed input", () => {
    expect(ingestMessageFrame(undefined)).toEqual([]);
    expect(ingestMessageFrame(() => 0)).toEqual([]);
    expect(ingestMessageFrame(Number.NaN)).toEqual([]);
    expect(ingestMessageFrame("keepalive")).toEqual([]);
    expect(ingestMessageFrame(null)).toEqual([]);
  });
});
