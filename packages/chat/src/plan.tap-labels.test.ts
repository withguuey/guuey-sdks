/**
 * guuey#2031 — a card tap's turn plans as an ACTION turn, never as typed
 * speech: the tapped control's own words (`tapLabels`) on a forwarded
 * view-directive row, a pending tap before its send, and the raw directive
 * offered only under the debug preset. The text stays wire-verbatim
 * everywhere; the words are display-only.
 */
import { describe, expect, it } from "vitest";
import { threadHistoryRowsToMessages } from "@guuey/agent-client";
import { planTranscript } from "./plan.js";
import { calmPolicy, debugPolicy } from "./policy.js";
import type { DisplayItem, TranscriptInputs, TranscriptMessage, UserMessageItem } from "./types.js";

const DIRECTIVE = [
  'Your REQUIRED FIRST TOOL CALL is ggui_consume with arguments {"sessionId":"render_s1"}.',
  "",
  '<ggui_directive kind="user-action">',
  "  <session_id>render_s1</session_id>",
  "  <next_tool>ggui_consume</next_tool>",
  "</ggui_directive>",
].join("\n");

function inputs(messages: TranscriptMessage[], extra: Partial<TranscriptInputs> = {}): TranscriptInputs {
  return {
    result: null,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages,
    sendStates: {},
    aborted: false,
    adopted: false,
    ...extra,
  };
}

function user(items: readonly DisplayItem[], key: string): UserMessageItem {
  const item = items.find((i) => i.key === key);
  if (item === undefined || item.kind !== "user") throw new Error(`no user item ${key}`);
  return item;
}

describe("a directive row with tap labels (calm)", () => {
  it("(a) carries the labels, stays a directive, and keeps its text byte-identical", () => {
    const plan = planTranscript(inputs([{ role: "user", text: DIRECTIVE, tapLabels: ["Opening hours"] }]), calmPolicy());
    const item = user(plan.items, "u0");
    expect(item.directive).toBe(true);
    expect(item.tapLabels).toEqual(["Opening hours"]);
    expect(item.text).toBe(DIRECTIVE);
    // Calm offers no raw directive: machine text never reaches a visitor.
    expect(item.rawDirective ?? false).toBe(false);
  });

  it("(b) typed text never shows a label, whatever the row carries", () => {
    const plan = planTranscript(inputs([{ role: "user", text: "What are your hours?", tapLabels: ["Opening hours"] }]), calmPolicy());
    const item = user(plan.items, "u0");
    expect(item.directive).toBe(false);
    expect(item).not.toHaveProperty("tapLabels");
  });

  it("(d) a directive row without labels is the SAME item as before the labels existed", () => {
    const plan = planTranscript(inputs([{ role: "user", text: DIRECTIVE }]), calmPolicy());
    // The item this planner emitted before guuey#2031, key for key.
    expect(user(plan.items, "u0")).toEqual({
      kind: "user",
      key: "u0",
      expanded: false,
      text: DIRECTIVE,
      state: "sent",
      retry: false,
      directive: true,
    });
  });

  it("(e) a merged row keeps each tap's entry in its position, nulls included", () => {
    const plan = planTranscript(inputs([{ role: "user", text: DIRECTIVE, tapLabels: ["Opening hours", null, "Author events"] }]), calmPolicy());
    expect(user(plan.items, "u0").tapLabels).toEqual(["Opening hours", null, "Author events"]);
  });

  it("a malformed value is read as no labels (the reader contract): the continuation row", () => {
    const malformed: TranscriptMessage = { role: "user", text: DIRECTIVE, tapLabels: [null] };
    const plan = planTranscript(inputs([malformed]), calmPolicy());
    expect(user(plan.items, "u0")).not.toHaveProperty("tapLabels");
  });

  it("(f) a live row and a history-mapped row with the same labels plan to the same item", () => {
    const live = planTranscript(inputs([{ role: "user", text: DIRECTIVE, tapLabels: ["Opening hours", null] }]), calmPolicy());
    const rehydrated = threadHistoryRowsToMessages([
      { seq: 5, at: "2026-09-30T00:00:00Z", kind: "text", authorRole: "user", text: DIRECTIVE, tapLabels: ["Opening hours", null] },
    ]);
    const history = planTranscript(inputs(rehydrated), calmPolicy());
    expect(user(history.items, "u0")).toEqual(user(live.items, "u0"));
  });
});

describe("the debug preset (the builder surface): the action turn plus the raw directive", () => {
  it("(c) draws the same action turn and offers the raw directive below it, collapsed by default", () => {
    const labeled = user(planTranscript(inputs([{ role: "user", text: DIRECTIVE, tapLabels: ["Opening hours"] }]), debugPolicy()).items, "u0");
    expect(labeled).toMatchObject({ directive: true, tapLabels: ["Opening hours"], rawDirective: true, expanded: false, text: DIRECTIVE });
    const unlabeled = user(planTranscript(inputs([{ role: "user", text: DIRECTIVE }]), debugPolicy()).items, "u0");
    expect(unlabeled).toMatchObject({ directive: true, rawDirective: true, expanded: false });
    expect(unlabeled).not.toHaveProperty("tapLabels");
  });

  it("a builder who turns collapseDirectives off gets the verbatim bubble back: no labels, no action turn", () => {
    const item = user(
      planTranscript(inputs([{ role: "user", text: DIRECTIVE, tapLabels: ["Opening hours"] }]), calmPolicy({ userMessage: { collapseDirectives: false } })).items,
      "u0",
    );
    expect(item.directive).toBe(false);
    expect(item).not.toHaveProperty("tapLabels");
  });
});

describe("(g) a pending tap: drawn at once, replaced in the same plan by its sent row", () => {
  const CARD = {
    seq: 2,
    at: "2026-09-30T00:00:02Z",
    cardSnapshot: {
      artifactId: "a2",
      parts: [{ type: "tool-result", toolCallId: "t2", content: [], uiData: { resourceUri: "ui://ggui/render/render_s1/h" } }],
    },
  };
  const HISTORY: TranscriptMessage[] = [
    { role: "user", text: "Hi!", seq: 1 },
    { role: "assistant", text: "Welcome!", seq: 3 },
  ];
  const PROMPT: TranscriptInputs["prompts"][number] = { id: "l1", kind: "link", appId: "a", requested: "read", state: "pending" };

  it("a pending tap plans as a `tap` item after the history cards and before the prompts", () => {
    const plan = planTranscript(
      inputs(HISTORY, { historyCards: [CARD], prompts: [PROMPT], pendingTaps: [{ id: "tap-1", labels: ["Opening hours"] }] }),
      calmPolicy(),
    );
    const keys = plan.items.map((i) => i.key);
    expect(keys.indexOf("tap.tap-1")).toBeGreaterThan(keys.indexOf("card.2"));
    expect(keys.indexOf("tap.tap-1")).toBeLessThan(keys.indexOf("p.l1"));
    const tap = plan.items.find((i) => i.key === "tap.tap-1");
    expect(tap).toEqual({ kind: "tap", key: "tap.tap-1", expanded: true, labels: ["Opening hours"] });
  });

  it("a [null] pending tap is drawn too — the continuation copy is instant as well", () => {
    const plan = planTranscript(inputs(HISTORY, { pendingTaps: [{ id: "tap-2", labels: [null] }] }), calmPolicy());
    expect(plan.items.find((i) => i.key === "tap.tap-2")).toMatchObject({ kind: "tap", labels: [null] });
  });

  it("the plan that first shows a message with the tap's id hides the pending tap: never both, never neither", () => {
    const pendingTaps = [{ id: "tap-1", labels: ["Opening hours"] }];
    const before = planTranscript(inputs(HISTORY, { pendingTaps }), calmPolicy());
    expect(before.items.some((i) => i.kind === "tap")).toBe(true);
    expect(before.items.filter((i) => i.kind === "user")).toHaveLength(1);
    const after = planTranscript(
      inputs([...HISTORY, { role: "user", text: DIRECTIVE, clientMessageId: "tap-1", tapLabels: ["Opening hours"] }], {
        pendingTaps,
        sendStates: { "tap-1": "sending" },
      }),
      calmPolicy(),
    );
    expect(after.items.some((i) => i.kind === "tap")).toBe(false);
    expect(user(after.items, "u1")).toMatchObject({ directive: true, tapLabels: ["Opening hours"], state: "sending" });
  });

  it("with collapseDirectives off nothing pending is drawn (the builder chose the raw bubble)", () => {
    const plan = planTranscript(
      inputs(HISTORY, { pendingTaps: [{ id: "tap-1", labels: ["Opening hours"] }] }),
      calmPolicy({ userMessage: { collapseDirectives: false } }),
    );
    expect(plan.items.some((i) => i.kind === "tap")).toBe(false);
  });

  it("no pending taps → the plan is exactly as before (no tap item, same keys)", () => {
    const without = planTranscript(inputs(HISTORY, { historyCards: [CARD] }), calmPolicy());
    const empty = planTranscript(inputs(HISTORY, { historyCards: [CARD], pendingTaps: [] }), calmPolicy());
    expect(empty).toEqual(without);
  });
});
