/**
 * guuey#847 — a provider-raw carry that carries NOTHING renders no row in calm.
 *
 * The google-adk facet rides every ADK event's empty-but-present
 * `actions.artifactDelta` / `requestedAuthConfigs` dicts as lossless
 * provider-raw blocks (the fold-identity cassette: three events → three
 * carries, all `{}`-shaped). QA read them on dev as two "Unrecognized
 * content (provider-raw:google) ▸" rows after every Gemini answer (#798).
 * There is no content to recognise. Calm omits such a carry; debug keeps it
 * (nothing hidden from a builder who asked for everything); a carry WITH a
 * payload still renders as the labeled unknown row — R15's trust invariant
 * is about content, and the rule reads shape, never vendor.
 */
import { describe, expect, it } from "vitest";
import type { AgReduceResult, JsonValue } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy, debugPolicy } from "./policy.js";
import type { DisplayItem, UnknownItem } from "./types.js";

function foldWithRaw(raw: JsonValue, vendor = "google"): AgReduceResult {
  return {
    messages: [
      {
        id: "msg_1",
        role: "assistant",
        content: [
          { type: "text", text: "The message 'conformance-probe' has been echoed back." },
          { type: "provider-raw", vendor, raw },
          { type: "provider-raw", vendor, raw },
        ],
      },
    ],
    artifacts: [],
    memory: [],
    turns: [],
  };
}

function plan(result: AgReduceResult, debug = false): DisplayItem[] {
  return planTranscript(
    {
      result,
      assistantText: "",
      status: "ready",
      statusElapsedMs: 0,
      activeTool: null,
      error: null,
      prompts: [],
      messages: [{ role: "user", text: "echo conformance-probe" }],
    },
    debug ? debugPolicy() : calmPolicy(),
  ).items;
}

const unknowns = (items: DisplayItem[]) => items.filter((i): i is UnknownItem => i.kind === "unknown");

describe("provider-raw carries with no information (guuey#847)", () => {
  it("the ADK empty-actions carry renders NO row in calm — the answer stands alone", () => {
    const adkCarry: JsonValue = { artifactDelta: {}, requestedAuthConfigs: {}, requestedToolConfirmations: {} };
    const items = plan(foldWithRaw(adkCarry));
    expect(unknowns(items)).toEqual([]);
    expect(items.some((i) => i.kind === "text")).toBe(true);
  });

  it("debug keeps every carry visible, labeled by vendor", () => {
    const adkCarry: JsonValue = { artifactDelta: {} };
    const rows = unknowns(plan(foldWithRaw(adkCarry), true));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.typeName).toBe("provider-raw:google");
  });

  it("a carry WITH a payload still renders as the labeled unknown row in calm (R15)", () => {
    const rows = unknowns(plan(foldWithRaw({ shape: 1, payload: "??" }, "futurecorp")));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.typeName).toBe("provider-raw:futurecorp");
  });

  it("the rule reads SHAPE: nested emptiness is empty; a zero, a false, or one non-empty string is information", () => {
    expect(unknowns(plan(foldWithRaw({ a: { b: [] }, c: [{}], d: null, e: "" })))).toEqual([]);
    expect(unknowns(plan(foldWithRaw({ a: { b: [0] } })))).toHaveLength(2);
    expect(unknowns(plan(foldWithRaw({ flag: false })))).toHaveLength(2);
    expect(unknowns(plan(foldWithRaw({ videoMetadata: { startOffset: "1s" } })))).toHaveLength(2);
  });
});
