import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgEvent, Normalizer } from "@silverprotocol/core";
import type { OpenAIStreamEvent } from "@silverprotocol/openai-agents";
import type { AdkEvent } from "@silverprotocol/google-adk";
import { makeNormalizer } from "./normalize.js";

// Real captured wire events, copied verbatim from the silverprotocol e2e
// cassette corpus (`packages/e2e/corpus/convergence-echo/openai.native.json`
// and `…/single-tool-call/adk.native.json`) — the same tool-call-then-reply
// scenario each framework actually streamed. See `fixtures/*.json` headers of
// this dir's worker fixtures for the pattern precedent
// (`claude-native-worker.mjs`).
const fixturesDir = join(__dirname, "fixtures");
const openaiNativeEvents = JSON.parse(
  readFileSync(join(fixturesDir, "openai-native-events.json"), "utf8"),
) as OpenAIStreamEvent[];
const adkNativeEvents = JSON.parse(
  readFileSync(join(fixturesDir, "adk-native-events.json"), "utf8"),
) as AdkEvent[];

/** Push every native event through `n`, then flush — one invoke's AgJSON. */
function runThrough(n: Normalizer, native: readonly unknown[]): AgEvent[] {
  const out = native.flatMap((e) => n.push(e));
  out.push(...n.flush());
  return out;
}

/** Type-narrowing filter over the AgEvent discriminated union. */
function ofType<T extends AgEvent["type"]>(events: AgEvent[], type: T): Extract<AgEvent, { type: T }>[] {
  return events.filter((e): e is Extract<AgEvent, { type: T }> => e.type === type);
}

describe("makeNormalizer", () => {
  it("returns a push/flush-able Normalizer for claude-agent-sdk", () => {
    const n = makeNormalizer("claude-agent-sdk");
    expect(typeof n.push).toBe("function");
    expect(typeof n.flush).toBe("function");
  });

  it("throws AGJSON_NO_NORMALIZER:<framework> for an unknown framework", () => {
    expect(() => makeNormalizer("langgraph")).toThrow("AGJSON_NO_NORMALIZER:langgraph");
  });

  describe("openai-agents-sdk (real convergence-echo capture)", () => {
    const out = runThrough(makeNormalizer("openai-agents-sdk"), openaiNativeEvents);

    it("emits monotonic seq from 0 and recognizes every native event (no unparsed ext)", () => {
      expect(out.length).toBeGreaterThan(0);
      out.forEach((e, i) => expect(e.seq).toBe(i));
      // `emitExt(vendor,"unparsed",…)` is the facet's fall-through for shapes
      // its guard did not recognize — a real capture must produce none.
      expect(out.filter((e) => e.type.startsWith("ext."))).toEqual([]);
    });

    it("normalizes the tool turn to tool.start → args → tool.done under the REAL call_id", () => {
      const starts = ofType(out, "tool.start");
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({ toolCallId: "call_EwiJuADOeCUSNTVk5BemtpWp", name: "echo" });

      const assembled = ofType(out, "tool.args.assembled");
      expect(assembled).toHaveLength(1);
      expect(assembled[0]!.toolCallId).toBe("call_EwiJuADOeCUSNTVk5BemtpWp");
      expect(assembled[0]!.input).toEqual({ text: "hi" });
      // The streamed args deltas reassemble to the same JSON the SDK sent.
      const argsJson = ofType(out, "tool.args.delta")
        .map((e) => e.delta)
        .join("");
      expect(JSON.parse(argsJson)).toEqual({ text: "hi" });

      const dones = ofType(out, "tool.done");
      expect(dones).toHaveLength(1);
      expect(dones[0]).toMatchObject({
        toolCallId: "call_EwiJuADOeCUSNTVk5BemtpWp",
        outcome: "ok",
        content: [{ type: "text", text: "echo: hi" }],
      });
      // tool.done lands before the follow-up text turn opens.
      const textStartSeq = ofType(out, "text.start")[0]!.seq;
      expect(dones[0]!.seq).toBeLessThan(textStartSeq);
    });

    it("normalizes the text turn to text.start/delta/end whose deltas join to the reply", () => {
      const textStarts = ofType(out, "text.start");
      expect(textStarts).toHaveLength(1);
      const streamId = textStarts[0]!.id;
      const deltas = ofType(out, "text.delta");
      expect(deltas.length).toBeGreaterThan(1); // genuinely streamed, not one lump
      for (const d of deltas) expect(d.id).toBe(streamId);
      expect(deltas.map((d) => d.delta).join("")).toBe("Done.");
      expect(ofType(out, "text.end").map((e) => e.id)).toEqual([streamId]);
    });

    it("closes BOTH responses as success turn.done (duplicate response.completed is a no-op)", () => {
      const turnDones = ofType(out, "turn.done");
      expect(turnDones).toHaveLength(2);
      for (const td of turnDones) {
        expect(td.outcome).toEqual({ type: "success" });
        expect(td.finishReason).toBe("stop");
      }
      // Two distinct turns — the tool round and the text round.
      expect(new Set(turnDones.map((td) => td.turnId)).size).toBe(2);
    });
  });

  describe("google-adk (real single-tool-call capture)", () => {
    const out = runThrough(makeNormalizer("google-adk"), adkNativeEvents);

    it("emits monotonic seq from 0 and recognizes every native event (no unparsed ext)", () => {
      expect(out.length).toBeGreaterThan(0);
      out.forEach((e, i) => expect(e.seq).toBe(i));
      expect(out.filter((e) => e.type.startsWith("ext."))).toEqual([]);
    });

    it("normalizes the functionCall part to tool.start/args under the REAL adk call id, signature preserved", () => {
      const starts = ofType(out, "tool.start");
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        toolCallId: "adk-5e25963a-5f96-4847-83e1-49cff7dd4ea5",
        name: "echo",
      });

      const assembled = ofType(out, "tool.args.assembled");
      expect(assembled).toHaveLength(1);
      expect(assembled[0]!.input).toEqual({ message: "conformance-probe" });
      // §8.8 echo-or-400: the Gemini thoughtSignature on the functionCall part
      // must ride tool.args.assembled.signature verbatim.
      const capturedSignature = adkNativeEvents[0]!.content!.parts![0]!.thoughtSignature;
      expect(capturedSignature).toBeTruthy();
      expect(assembled[0]!.signature).toBe(capturedSignature);
    });

    it("normalizes the functionResponse part to tool.done with the MCP text content", () => {
      const dones = ofType(out, "tool.done");
      expect(dones).toHaveLength(1);
      expect(dones[0]).toMatchObject({
        toolCallId: "adk-5e25963a-5f96-4847-83e1-49cff7dd4ea5",
        outcome: "ok",
        content: [{ type: "text", text: "conformance-probe" }],
      });
    });

    it("normalizes the final text part to text.start/delta/end and closes the turn success", () => {
      const deltas = ofType(out, "text.delta");
      expect(deltas.map((d) => d.delta).join("")).toBe(
        "The message 'conformance-probe' has been echoed back.",
      );
      expect(ofType(out, "text.end").map((e) => e.id)).toEqual(deltas.map((d) => d.id));

      const turnDones = ofType(out, "turn.done");
      expect(turnDones).toHaveLength(1);
      expect(turnDones[0]!.outcome).toEqual({ type: "success" });
      expect(turnDones[0]!.finishReason).toBe("stop");
      // tool.done precedes the reply text — lifecycle order survived normalization.
      expect(ofType(out, "tool.done")[0]!.seq).toBeLessThan(ofType(out, "text.start")[0]!.seq);
    });
  });
});
