/**
 * guuey#1279 Track A — protocol/lifecycle vocabulary is structurally incapable
 * of reaching the widget's visible chrome.
 *
 * The 0.23.0 `showToolRows` door filtered ggui protocol tool ROWS. It never
 * covered the STATUS LINE, which is always visible and named the live tool:
 * `activeTool: "ggui_render"` rendered "Using ggui render…" because
 * `humanizeToolName` only mapped `mcp__ggui__`-prefixed names that were also in
 * its 4-entry table and fell through to the generic humanizer for everything
 * else — bare rail names and any rail tool the table had not learned.
 *
 * These tests pin BOTH halves of the fix, and the third `describe` is the one
 * that makes it by-construction rather than a filter: `policy.tool.humanizeTitle`
 * is host-overridable, so the guard must hold even when a host supplies a
 * humanizer that returns the wire name verbatim.
 */
import { describe, expect, it } from "vitest";
import type { AgReduceResult } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import { isGguiProtocolTool } from "./listen.js";
import { humanizeToolName } from "./strings.js";
import type { TranscriptPolicy } from "./policy.js";

/**
 * Vocabulary that must never appear in chrome: rail identifiers, MCP wire
 * shapes, lifecycle verbs, and leftover snake_case (the shape of a raw wire
 * name). "Rendering card" is product copy and passes; "ggui render" does not.
 */
const PROTOCOL_VOCABULARY = /ggui|handshake|negotiat|mcp__|ui:\/\/|[a-z]_[a-z]/i;

/** Rail tools: mapped, bare, and the ones the kit has NOT learned yet. */
const RAIL_TOOLS = [
  "ggui_handshake",
  "ggui_render",
  "ggui_consume",
  "ggui_update",
  "mcp__ggui__ggui_handshake",
  "mcp__ggui__ggui_render",
  // The cands-31–34 class: a rail tool that exists on ggui's service but is
  // absent from GGUI_RAIL_TITLES. This is the case that used to leak.
  "ggui_negotiate",
  "ggui_stream_frame",
  "mcp__ggui__ggui_negotiate",
];

const EMPTY: AgReduceResult = { messages: [], artifacts: [], memory: [], turns: [] };

function statusCopy(activeTool: string, policy: TranscriptPolicy): string {
  const status = planTranscript(
    {
      result: EMPTY,
      assistantText: "",
      status: "using-tool",
      statusElapsedMs: 0,
      activeTool,
      error: null,
      prompts: [],
      messages: [{ role: "user", text: "go" }],
    },
    policy,
  ).status;
  expect(status).not.toBeNull();
  return status!.copy;
}

describe("guuey#1279 — humanizeToolName never yields a rail wire name", () => {
  it.each(RAIL_TOOLS)("%s resolves to product words, not machinery", (wireName) => {
    expect(isGguiProtocolTool(wireName)).toBe(true);
    const title = humanizeToolName(wireName);
    expect(title).not.toMatch(PROTOCOL_VOCABULARY);
  });

  it("an UNMAPPED rail tool falls back to product words (the old leak)", () => {
    // Before the fix these returned "ggui negotiate" / "Ggui · ggui negotiate".
    expect(humanizeToolName("ggui_negotiate")).toBe("Preparing interactive card");
    expect(humanizeToolName("mcp__ggui__ggui_negotiate")).toBe("Preparing interactive card");
  });

  it("a MAPPED rail tool keeps its learned title on BOTH wire shapes", () => {
    // Keying on the bare name is what makes the wire shape irrelevant: the
    // bare form used to miss the table entirely.
    expect(humanizeToolName("ggui_render")).toBe("Rendering card");
    expect(humanizeToolName("mcp__ggui__ggui_render")).toBe("Rendering card");
  });

  it("does NOT mute a customer's own tools (the bypass is surgical)", () => {
    expect(humanizeToolName("get_weather")).toBe("get weather");
    expect(humanizeToolName("mcp__stripe__create_invoice")).toBe("Stripe · create invoice");
  });
});

describe("guuey#1279 — the status line never narrates the rail", () => {
  it.each(RAIL_TOOLS)("status for %s carries no protocol vocabulary", (activeTool) => {
    expect(statusCopy(activeTool, calmPolicy())).not.toMatch(PROTOCOL_VOCABULARY);
  });

  it("the rail collapses to ONE product sentence, not 'Using <machinery>…'", () => {
    expect(statusCopy("ggui_render", calmPolicy())).toBe("Preparing interactive card…");
  });

  it("a non-rail tool still names itself (no blanket mute)", () => {
    expect(statusCopy("get_weather", calmPolicy())).toBe("Using get weather…");
  });
});

describe("guuey#1279 — BY CONSTRUCTION: a leaky host humanizer cannot defeat it", () => {
  // `humanizeTitle` is host-overridable. If the guard lived only inside
  // humanizeToolName it would be a filter a host replaces; the plan routes
  // rail tools around the hook entirely, so this humanizer never runs for them.
  const leaky = calmPolicy({ tool: { humanizeTitle: (wireName: string) => wireName } });

  it.each(RAIL_TOOLS)("status for %s stays clean despite a wire-name humanizer", (activeTool) => {
    expect(statusCopy(activeTool, leaky)).not.toMatch(PROTOCOL_VOCABULARY);
  });

  it("the leaky humanizer IS still honoured for non-rail tools", () => {
    // Proves the bypass is scoped to the rail, not a silent override of the hook.
    expect(statusCopy("get_weather", leaky)).toBe("Using get_weather…");
  });
});
