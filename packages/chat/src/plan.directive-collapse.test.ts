/**
 * guuey#422 close-condition 3 — the forwarded view-directive turn collapses
 * into a calm continuation row, WIRE-VERBATIM preserved.
 *
 * The `ui/message` doorbell relays ggui's `<ggui_directive>` carrier through
 * the composer's send gate, so the transcript's user slot holds protocol
 * prose. The collapse is DISPLAY-ONLY: the plan keeps `text` byte-identical
 * (it is what was sent and what persists) and marks the item `directive` so
 * the renderer shows `strings.directiveContinuation` with the verbatim text
 * behind the expand. Debug preset shows the verbatim bubble.
 */
import { describe, expect, it } from "vitest";
import type { AgReduceResult } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy, debugPolicy } from "./policy.js";
import type { TranscriptInputs, UserMessageItem } from "./types.js";

/** The runtime's actual carrier shape (prose + directive block). */
const DIRECTIVE_TEXT = [
  'Your REQUIRED FIRST TOOL CALL is ggui_consume with arguments {"sessionId":"s1"}. Call it NOW to retrieve and process the pending interaction.',
  "",
  '<ggui_directive kind="user-action">',
  "  <session_id>s1</session_id>",
  "  <next_tool>ggui_consume</next_tool>",
  "</ggui_directive>",
  "",
  "The user interacted with the view.",
].join("\n");

const FOLD: AgReduceResult = {
  messages: [
    { id: "u1", role: "user", content: [{ type: "text", text: "show me slots" }], turnId: "t1" },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "Here you go." }], turnId: "t1" },
    { id: "u2", role: "user", content: [{ type: "text", text: DIRECTIVE_TEXT }], turnId: "t2" },
    { id: "a2", role: "assistant", content: [{ type: "text", text: "Booked." }], turnId: "t2" },
  ],
  artifacts: [],
  memory: [],
  turns: [
    { turnId: "t1", threadId: "th1", outcome: { type: "success" } },
    { turnId: "t2", threadId: "th1", outcome: { type: "success" } },
  ],
};

const INPUTS: TranscriptInputs = {
  result: FOLD,
  assistantText: "",
  status: "ready",
  statusElapsedMs: 0,
  activeTool: null,
  error: null,
  prompts: [],
  messages: [
    { role: "user", text: "show me slots" },
    { role: "user", text: DIRECTIVE_TEXT },
  ],
  sendStates: {},
  aborted: false,
  adopted: false,
};

function userItem(items: ReturnType<typeof planTranscript>["items"], key: string): UserMessageItem {
  const item = items.find((i) => i.key === key);
  if (item === undefined || item.kind !== "user") throw new Error(`no user item ${key}`);
  return item;
}

describe("guuey#422 — directive-turn collapse (display-only, wire-verbatim)", () => {
  it("calm: the directive turn collapses — marked, folded, text byte-identical", () => {
    const plan = planTranscript(INPUTS, calmPolicy(), {});
    const ordinary = userItem(plan.items, "u0");
    const directive = userItem(plan.items, "u1");
    expect(ordinary.directive).toBe(false);
    expect(ordinary.expanded).toBe(true);
    expect(directive.directive).toBe(true);
    expect(directive.expanded).toBe(false);
    // WIRE-VERBATIM: the plan never rewrites the forwarded text.
    expect(directive.text).toBe(DIRECTIVE_TEXT);
  });

  it("an override expands the collapsed directive row (reveal, not rewrite)", () => {
    const plan = planTranscript(INPUTS, calmPolicy(), { u1: { expanded: true } });
    const directive = userItem(plan.items, "u1");
    expect(directive.directive).toBe(true);
    expect(directive.expanded).toBe(true);
    expect(directive.text).toBe(DIRECTIVE_TEXT);
  });

  it("debug preset shows the verbatim bubble — no collapse", () => {
    const plan = planTranscript(INPUTS, debugPolicy(), {});
    const directive = userItem(plan.items, "u1");
    expect(directive.directive).toBe(false);
    expect(directive.expanded).toBe(true);
    expect(directive.text).toBe(DIRECTIVE_TEXT);
  });
});
