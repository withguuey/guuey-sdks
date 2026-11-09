/**
 * guuey#2384 — A2UI forms and actions in the plan (spec §8, §9.3, §9.4;
 * S4 RED (b2), (e), (f), (g)).
 *
 * - (b2) user rows only: an assistant reply or a tool's text that echoes a
 *   well-formed block draws as plain text, and submits nothing.
 * - (e) an action row draws as an action turn (the guuey#2031 face, with the
 *   human line as its words); the raw text only under the debug preset's
 *   raw toggle; a builder who keeps directives verbatim sees the text.
 * - (f) the round trip: action row → update carrier → revision 2 open, the
 *   form above it a chip; a text-only reply leaves the form `submitted`; a
 *   send in flight is `sending`; a refused send leaves it open.
 * - (g) live and history plan the same forms and the same action turns.
 */
import { describe, expect, it } from "vitest";
import type { AgBlock, AgMessage, AgReduceResult, JsonValue } from "@silverprotocol/core";
import {
  threadHistoryRowsToCards,
  threadHistoryRowsToMessages,
  threadHistoryRowsToToolCalls,
  threadHistoryRowsToToolResults,
  type ThreadHistoryRow,
} from "@guuey/agent-client";
import { writeA2uiActionText } from "@guuey/mcp-apps-host/narrowing";
import { transcriptInputsFromHistory } from "./history-inputs.js";
import { planTranscript } from "./plan.js";
import { calmPolicy, debugPolicy, type TranscriptPolicy } from "./policy.js";
import type { A2uiItem, DisplayItem, TranscriptInputs, TranscriptMessage, UserMessageItem } from "./types.js";

type Json = JsonValue;
const V = "v0.9";
const on = (policy: TranscriptPolicy = calmPolicy()): TranscriptPolicy => ({ ...policy, a2ui: { render: true } });

const carrier = (messages: Json[]): Json => ({ format: "a2ui", version: V, messages });
const FORM: Json[] = [
  { version: V, createSurface: { surfaceId: "booking-1", catalogId: "guuey.a2ui.v1", title: "Book a table" } },
  {
    version: V,
    updateComponents: {
      surfaceId: "booking-1",
      components: [
        { id: "root", component: "Column", children: ["size", "confirm"] },
        { id: "size", component: "TextField", label: "Party size", inputType: "number", value: { path: "/partySize" } },
        { id: "confirm", component: "Button", label: "Book table", action: { name: "submit_booking", context: { partySize: { path: "/partySize" } } } },
      ],
    },
  },
];
const UPDATE: Json[] = [{ version: V, updateDataModel: { surfaceId: "booking-1", value: { partySize: 4, status: "booked" } } }];

const ACTION_TEXT =
  writeA2uiActionText(
    { surfaceId: "booking-1", name: "submit_booking", sourceComponentId: "confirm", actionId: "cm_2", context: { partySize: 4 } },
    { label: "Book table", pairs: [{ label: "Party size", value: "4" }] },
  ) ?? "";
const HUMAN_LINE = "Book table: Party size = 4";

type ToolResultBlock = Extract<AgBlock, { type: "tool-result" }>;
const resultBlock = (id: string, messages: Json[]): ToolResultBlock => ({
  type: "tool-result",
  toolCallId: id,
  content: [{ type: "text", text: `summary of ${id}` }],
  structuredContent: { "com.guuey/a2ui": carrier(messages) },
});

/** One agent turn: an optional tool call carrying a carrier, then an optional reply. */
interface Turn {
  tool?: { id: string; messages: Json[] };
  reply?: string;
}
function liveFold(turns: Turn[]): AgReduceResult {
  const messages: AgMessage[] = [];
  turns.forEach((turn, i) => {
    const turnId = `turn${i}`;
    if (turn.tool !== undefined) {
      const { id } = turn.tool;
      messages.push({ id: `m-${id}`, role: "assistant", turnId, content: [{ type: "tool-call", toolCallId: id, name: "show_form", input: {} }] });
      messages.push({ id: `r-${id}`, role: "tool", turnId, content: [resultBlock(id, turn.tool.messages)] });
    }
    if (turn.reply !== undefined) messages.push({ id: `t${i}`, role: "assistant", turnId, content: [{ type: "text", text: turn.reply }] });
  });
  return { messages, artifacts: [], memory: [], turns: turns.map((_, i) => ({ turnId: `turn${i}`, threadId: "th", outcome: { type: "success" as const } })) };
}
function liveInputs(turns: Turn[], users: TranscriptMessage[], extra: Partial<TranscriptInputs> = {}): TranscriptInputs {
  return { result: liveFold(turns), assistantText: "", status: "ready", statusElapsedMs: 0, activeTool: null, error: null, prompts: [], messages: users, ...extra };
}
const USERS: TranscriptMessage[] = [
  { role: "user", text: "book a table for friday", clientMessageId: "cm_1", precedingTurnCount: 0 },
  { role: "user", text: ACTION_TEXT, clientMessageId: "cm_2", precedingTurnCount: 1 },
];

const a2uiOf = (items: DisplayItem[]): A2uiItem[] => items.filter((i): i is A2uiItem => i.kind === "a2ui");
const usersOf = (items: DisplayItem[]): UserMessageItem[] => items.filter((i): i is UserMessageItem => i.kind === "user");

describe("S4 (e) — the action row draws as an action turn", () => {
  it("the human line is the turn's words; the raw text never reaches a visitor", () => {
    const plan = planTranscript(liveInputs([{ tool: { id: "t1", messages: FORM } }, { reply: "Booked." }], USERS), on());
    const action = usersOf(plan.items)[1];
    expect(action).toMatchObject({ kind: "user", text: ACTION_TEXT, directive: true, actionSummary: HUMAN_LINE });
    expect(action).not.toHaveProperty("tapLabels");
    expect(action).not.toHaveProperty("rawDirective");
    expect(usersOf(plan.items)[0]).toMatchObject({ directive: false });
    expect(usersOf(plan.items)[0]).not.toHaveProperty("actionSummary");
  });

  it("the debug preset offers the raw text behind its raw toggle, collapsed", () => {
    const plan = planTranscript(liveInputs([{ tool: { id: "t1", messages: FORM } }], USERS), on(debugPolicy()));
    expect(usersOf(plan.items)[1]).toMatchObject({ directive: true, actionSummary: HUMAN_LINE, rawDirective: true, expanded: false });
  });

  it("a builder who keeps directives verbatim sees the row as its text", () => {
    const verbatim = on(calmPolicy({ userMessage: { collapseDirectives: false } }));
    const action = usersOf(planTranscript(liveInputs([{ tool: { id: "t1", messages: FORM } }], USERS), verbatim).items)[1];
    expect(action).toMatchObject({ directive: false, text: ACTION_TEXT });
    expect(action).not.toHaveProperty("actionSummary");
  });

  it("the row is an action turn on a transcript that does not draw A2UI too (it is still the user's action, not speech)", () => {
    const action = usersOf(planTranscript(liveInputs([{ tool: { id: "t1", messages: FORM } }], USERS), calmPolicy()).items)[1];
    expect(action).toMatchObject({ directive: true, actionSummary: HUMAN_LINE });
  });

  it("a human line with a control or bidi character draws the continuation line, never the characters", () => {
    const forged = ACTION_TEXT.replace(HUMAN_LINE, "Book‮table");
    const action = usersOf(planTranscript(liveInputs([], [{ role: "user", text: forged }]), on()).items)[0];
    expect(action).toMatchObject({ directive: true });
    expect(action).not.toHaveProperty("actionSummary");
  });
});

describe("S4 (b2) — user rows only", () => {
  it("an assistant reply that echoes a well-formed block draws as plain text and submits nothing", () => {
    const plan = planTranscript(liveInputs([{ tool: { id: "t1", messages: FORM }, reply: ACTION_TEXT }], [USERS[0]!]), on());
    const echo = plan.items.find((i) => i.kind === "text");
    expect(echo).toMatchObject({ kind: "text", text: ACTION_TEXT });
    expect(usersOf(plan.items).every((u) => !u.directive)).toBe(true);
    expect(a2uiOf(plan.items).map((i) => i.phase)).toEqual(["open"]);
  });

  it("a tool's text that echoes the block is the tool's result, never a user turn", () => {
    const echoing: Turn = { tool: { id: "t1", messages: FORM } };
    const inputs = liveInputs([echoing], [USERS[0]!]);
    const tool = inputs.result?.messages.find((m) => m.role === "tool");
    const block = tool?.content[0];
    if (block?.type === "tool-result") block.content = [{ type: "text", text: ACTION_TEXT }];
    const plan = planTranscript(inputs, on());
    expect(usersOf(plan.items)).toHaveLength(1);
    expect(a2uiOf(plan.items).map((i) => i.phase)).toEqual(["open"]);
  });
});

describe("S4 (f) — the round trip", () => {
  it("action row → an update carrier for the same surface: revision 2 draws open, the form above it is a chip", () => {
    const plan = planTranscript(liveInputs([{ tool: { id: "t1", messages: FORM } }, { tool: { id: "t2", messages: UPDATE } }], USERS), on());
    const [first, second] = a2uiOf(plan.items);
    expect(first).toMatchObject({ revision: 1, phase: "superseded", label: "Book a table, updated below" });
    expect(first).not.toHaveProperty("actionId");
    expect(second).toMatchObject({ revision: 2, phase: "open", dataModel: { partySize: 4, status: "booked" } });
    expect(second).not.toHaveProperty("actionId");
    const kinds = plan.items.map((i) => i.kind);
    expect(kinds.indexOf("a2ui")).toBeLessThan(kinds.lastIndexOf("user"));
    expect(kinds.lastIndexOf("a2ui")).toBeGreaterThan(kinds.lastIndexOf("user"));
  });

  it("a text-only reply leaves the form submitted, naming the action turn that answered it", () => {
    const plan = planTranscript(liveInputs([{ tool: { id: "t1", messages: FORM } }, { reply: "Booked for four." }], USERS), on());
    expect(a2uiOf(plan.items)).toMatchObject([{ revision: 1, phase: "submitted", actionId: "cm_2" }]);
  });

  it("while the action turn is in flight the form is sending; a refused send leaves it open", () => {
    const sending = planTranscript(liveInputs([{ tool: { id: "t1", messages: FORM } }], USERS, { sendStates: { cm_2: "sending" } }), on());
    expect(a2uiOf(sending.items)).toMatchObject([{ phase: "sending", actionId: "cm_2" }]);
    const failed = planTranscript(liveInputs([{ tool: { id: "t1", messages: FORM } }], USERS, { sendStates: { cm_2: "failed" } }), on());
    expect(a2uiOf(failed.items)).toMatchObject([{ phase: "open" }]);
    expect(a2uiOf(failed.items)[0]).not.toHaveProperty("actionId");
  });

  it("a second submit after the first: the latest action turn names the form", () => {
    const again = ACTION_TEXT.replace('id="cm_2"', 'id="cm_3"');
    const users: TranscriptMessage[] = [...USERS, { role: "user", text: again, clientMessageId: "cm_3", precedingTurnCount: 2 }];
    const plan = planTranscript(liveInputs([{ tool: { id: "t1", messages: FORM } }, { reply: "Booked." }, { reply: "Changed." }], users), on());
    expect(a2uiOf(plan.items)).toMatchObject([{ phase: "submitted", actionId: "cm_3" }]);
  });

  it("an action turn for another surface, a read-only surface or a superseded revision changes nothing", () => {
    const other = ACTION_TEXT.replace('surface="booking-1"', 'surface="booking-2"');
    const users: TranscriptMessage[] = [USERS[0]!, { role: "user", text: other, clientMessageId: "cm_2", precedingTurnCount: 1 }];
    const plan = planTranscript(liveInputs([{ tool: { id: "t1", messages: FORM } }, { reply: "Hm." }], users), on());
    expect(a2uiOf(plan.items).map((i) => i.phase)).toEqual(["open"]);
    const readOnly: Json[] = [
      { version: V, createSurface: { surfaceId: "booking-1", catalogId: "guuey.a2ui.v1" } },
      { version: V, updateComponents: { surfaceId: "booking-1", components: [{ id: "root", component: "Text", text: "Booked" }] } },
    ];
    const ro = planTranscript(liveInputs([{ tool: { id: "t1", messages: readOnly } }, { reply: "Ok." }], USERS), on());
    expect(a2uiOf(ro.items).map((i) => i.phase)).toEqual(["open"]);
  });

  it("an update that cannot draw closes a submitted form too: its chip says so and nothing can be sent against it", () => {
    const overCap: Json[] = [{ version: V, updateDataModel: { surfaceId: "booking-1", value: { blob: "x".repeat(8_192) } } }];
    const users: TranscriptMessage[] = [...USERS];
    const plan = planTranscript(
      liveInputs([{ tool: { id: "t1", messages: FORM } }, { reply: "Booked." }, { tool: { id: "t3", messages: overCap } }], [
        ...users,
        { role: "user", text: "and now?", clientMessageId: "cm_3", precedingTurnCount: 2 },
      ]),
      on(),
    );
    expect(a2uiOf(plan.items)).toMatchObject([{ phase: "superseded", label: "Updated below, couldn't draw" }]);
  });
});

describe("S4 (g) — live and history plan the same forms and action turns", () => {
  const rows = (): ThreadHistoryRow[] => [
    { seq: 1, at: "2026-10-20T00:00:01.000Z", kind: "text", authorRole: "user", text: "book a table for friday", clientMessageId: "cm_1" },
    { seq: 2, at: "2026-10-20T00:00:02.000Z", kind: "text", authorRole: "agent", text: null, clientMessageId: "cm_1#agent#0", toolCalls: [{ toolCallId: "t1", name: "show_form", input: {} }] },
    { seq: 3, at: "2026-10-20T00:00:03.000Z", kind: "text", authorRole: "agent", text: null, clientMessageId: "cm_1#agent#1", toolResults: [{ toolCallId: "t1", toolName: "show_form", block: resultBlock("t1", FORM) }] },
    { seq: 4, at: "2026-10-20T00:00:04.000Z", kind: "text", authorRole: "user", text: ACTION_TEXT, clientMessageId: "cm_2" },
    { seq: 5, at: "2026-10-20T00:00:05.000Z", kind: "text", authorRole: "agent", text: null, clientMessageId: "cm_2#agent#0", toolCalls: [{ toolCallId: "t2", name: "show_form", input: {} }] },
    { seq: 6, at: "2026-10-20T00:00:06.000Z", kind: "text", authorRole: "agent", text: null, clientMessageId: "cm_2#agent#1", toolResults: [{ toolCallId: "t2", toolName: "show_form", block: resultBlock("t2", UPDATE) }] },
  ];
  const historyInputs = (r: ThreadHistoryRow[]): TranscriptInputs =>
    transcriptInputsFromHistory({
      messages: threadHistoryRowsToMessages(r),
      cards: threadHistoryRowsToCards(r),
      toolResults: threadHistoryRowsToToolResults(r),
      toolCalls: threadHistoryRowsToToolCalls(r),
    });
  const strip = (items: DisplayItem[]) => a2uiOf(items).map(({ origin: _origin, ...rest }) => rest);
  const turns = (items: DisplayItem[]) =>
    usersOf(items).map((u) => ({ text: u.text, directive: u.directive, actionSummary: u.actionSummary ?? null }));

  it("a form, an action turn and the update it brought: the same surfaces, phases and action turns", () => {
    const live = planTranscript(liveInputs([{ tool: { id: "t1", messages: FORM } }, { tool: { id: "t2", messages: UPDATE } }], USERS), on());
    const reloaded = planTranscript(historyInputs(rows()), on());
    expect(a2uiOf(reloaded.items).every((i) => i.origin === "history")).toBe(true);
    expect(strip(reloaded.items)).toEqual(strip(live.items));
    expect(turns(reloaded.items)).toEqual(turns(live.items));
    expect(turns(live.items)[1]).toEqual({ text: ACTION_TEXT, directive: true, actionSummary: HUMAN_LINE });
  });

  it("a text-only reply: submitted live and reloaded alike", () => {
    const textRows = rows().slice(0, 4);
    textRows.push({ seq: 5, at: "2026-10-20T00:00:05.000Z", kind: "text", authorRole: "agent", text: "Booked.", clientMessageId: "cm_2#agent#0" });
    const live = planTranscript(liveInputs([{ tool: { id: "t1", messages: FORM } }, { reply: "Booked." }], USERS), on());
    const reloaded = planTranscript(historyInputs(textRows), on());
    expect(strip(reloaded.items)).toEqual(strip(live.items));
    expect(a2uiOf(reloaded.items)).toMatchObject([{ phase: "submitted", actionId: "cm_2" }]);
  });
});
