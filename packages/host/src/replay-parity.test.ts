/**
 * guuey#2549 — the host's replay parity: the current turn's model text and the history preamble
 * read the same sentence for a context-only turn (cto's condition). The substitution itself is
 * `@guuey/worker`'s `model-text.ts`, tested there.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_ONLY_TURN_TEXT, modelInputOf } from "@guuey/worker";
import { buildTurnContextBlocks, promptClassOf } from "./preamble.js";

afterEach(() => vi.restoreAllMocks());

describe("replay parity (cto RED)", () => {
  it("the current turn's model text equals what the history preamble replays for that stored turn", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // The user's words for the turn are the same sentence now (after the frame) and on replay (alone).
    const now = modelInputOf({ input: "<page_context>…</page_context>\n\n", inputKind: "context-only" });
    expect(now.endsWith(CONTEXT_ONLY_TURN_TEXT)).toBe(true);
    const cls = promptClassOf({ identity: { authMode: "anonymous" } }, { noTools: false, surfaceHints: undefined });
    const later = buildTurnContextBlocks({ history: [{ role: "user", text: "", inputKind: "context-only" }] }, cls).join("\n\n");
    expect(later).toContain(`: ${CONTEXT_ONLY_TURN_TEXT}`);
    // And no empty user line is ever replayed for it.
    expect(later).not.toMatch(/: \n/);
  });
});
