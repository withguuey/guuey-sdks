// @vitest-environment jsdom
/**
 * guuey#2388 — tool rows survive a reload: the history read's stored calls and
 * results (`TranscriptInputs.historyTools`) are spliced by `seq` into the flat
 * groups and planned by the live tool-call arm.
 *
 *  - A tool entry acts like an agent row: it joins the turn it belongs to, so
 *    a turn whose agent rows are all tool-only fills its guuey#1101 slot
 *    instead of leaving it empty, and no slot is added or lost.
 *  - A carded call draws its card at the call's own position (the live R4
 *    place), once: no data row, no second mount, the card right after the
 *    call, titled and attributed by the call, with the call's input.
 *  - A call the read gave no result for draws a settled, plain row: no
 *    spinner, no failure, no "didn't finish" note (the read does not say).
 *  - Without `historyTools` nothing new is drawn: today's reload.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { HistoryCard, HistoryToolCall, HistoryToolResult } from "@guuey/agent-client";
import type { JsonValue } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import { defaultChatStrings } from "./strings.js";
import { DefaultTool, type TranscriptItemContext } from "./react/components.js";
import type { DisplayItem, ToolItem, TranscriptInputs, TranscriptMessage, ViewMountItem } from "./types.js";

afterEach(cleanup);

const AT = (seq: number): string => new Date(Date.UTC(2026, 9, 28, 0, 0, seq)).toISOString();

function inputs(
  messages: TranscriptMessage[],
  extra: Partial<Pick<TranscriptInputs, "historyTools" | "historyCards">> = {},
): TranscriptInputs {
  return {
    result: null,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages,
    ...extra,
  };
}

const call = (seq: number, toolCallId: string, name: string, more: Partial<HistoryToolCall> = {}): HistoryToolCall => ({
  seq,
  at: AT(seq),
  call: { toolCallId, name, input: { q: name } },
  ...more,
});

const result = (seq: number, toolCallId: string, text: string): HistoryToolResult => ({
  seq,
  at: AT(seq),
  toolCallId,
  block: { type: "tool-result", toolCallId, content: [{ type: "text", text }], outcome: "ok" },
});

/** A card row's stored part: an inline MCP-Apps view, as the card row stores it. */
const storedCardPart = (toolCallId: string): JsonValue => ({
  type: "tool-result",
  toolCallId,
  content: [{ type: "text", text: "shown" }],
  outcome: "ok",
  uiData: { uri: `ui://cards/${toolCallId}`, mimeType: "text/html", text: "<p>card</p>" },
});

/** The same part as the client reads it onto `HistoryToolCall.card.result`. */
const cardPart = (toolCallId: string): HistoryToolResult["block"] => ({
  type: "tool-result",
  toolCallId,
  content: [{ type: "text", text: "shown" }],
  outcome: "ok",
  uiData: { uri: `ui://cards/${toolCallId}`, mimeType: "text/html", text: "<p>card</p>" },
});

const card = (seq: number, toolCallId: string, toolName?: string): HistoryCard => ({
  seq,
  at: AT(seq),
  cardSnapshot: { artifactId: `${toolCallId}:result#ui#0`, parts: [storedCardPart(toolCallId)] },
  ...(toolName !== undefined ? { toolName } : {}),
});

const keys = (items: DisplayItem[]): string[] => items.map((i) => i.key);
const plan = (i: TranscriptInputs): DisplayItem[] => planTranscript(i, calmPolicy()).items;

describe("guuey#2388: a tool-only turn fills its guuey#1101 slot, and the slot count is unchanged", () => {
  const messages: TranscriptMessage[] = [
    { role: "user", text: "Q1", seq: 1 },
    { role: "user", text: "Q2", seq: 4 },
    { role: "assistant", text: "A2", seq: 5 },
  ];

  it("without historyTools the tool-only turn is guuey#1101's empty slot: A2 is slot 1", () => {
    expect(keys(plan(inputs(messages)))).toEqual(["u0", "u1", "a1.t0"]);
  });

  it("with historyTools the same slot holds the tool row, and A2 is still slot 1", () => {
    const items = plan(
      inputs(messages, { historyTools: { calls: [call(2, "toolu_a", "look_up")], results: [result(3, "toolu_a", "found")] } }),
    );
    expect(keys(items)).toEqual(["u0", "tool.toolu_a", "u1", "a1.t0"]);
    const tool = items.find((i): i is ToolItem => i.kind === "tool");
    expect(tool?.state).toBe("done");
    expect(tool?.result?.preview).toBe("found");
  });

  it("a tool-only row never enters `messages`: the assembler's rows are the planner's rows", () => {
    const history = { calls: [call(2, "toolu_a", "look_up")], results: [result(3, "toolu_a", "found")] };
    const items = plan(inputs(messages, { historyTools: history }));
    expect(items.filter((i) => i.kind === "text").map((i) => i.key)).toEqual(["a1.t0"]);
  });
});

describe("guuey#2388: a carded call draws its card at the call's own position", () => {
  const messages: TranscriptMessage[] = [
    { role: "user", text: "show me", seq: 1 },
    { role: "assistant", text: "There it is.", seq: 4 },
  ];
  const carded = call(2, "toolu_card", "show_card", { card: { seq: 3, result: cardPart("toolu_card") } });

  it("no data row, no second mount, and the card directly after its call", () => {
    const items = plan(inputs(messages, { historyTools: { calls: [carded], results: [] }, historyCards: [card(3, "toolu_card", "server_join_name")] }));
    expect(keys(items)).toEqual(["u0", "tool.toolu_card", "card.3", "a0.t0"]);
    expect(items.filter((i) => i.kind === "view")).toHaveLength(1);
    expect(items.filter((i) => i.kind === "data-result")).toHaveLength(0);
    const tool = items.find((i): i is ToolItem => i.kind === "tool");
    expect(tool).toMatchObject({ state: "done", result: null, refusal: null, attribution: true });
  });

  it("the card is named and attributed by its call, and is sent the call's input", () => {
    const policy = calmPolicy();
    const items = plan(inputs(messages, { historyTools: { calls: [carded], results: [] }, historyCards: [card(3, "toolu_card", "server_join_name")] }));
    const view = items.find((i): i is ViewMountItem => i.kind === "view");
    const title = policy.tool.humanizeTitle("show_card");
    expect(view?.toolTitle).toBe(title);
    expect(view?.attribution).toBe(policy.strings.viaTool(title));
    expect(view?.toolData).toEqual({ input: { q: "show_card" }, result: { content: [{ type: "text", text: "shown" }] } });
  });

  it("a call's own title outranks its name", () => {
    const titled: HistoryToolCall = { ...carded, call: { ...carded.call, title: "Card picker" } };
    const items = plan(inputs(messages, { historyTools: { calls: [titled], results: [] }, historyCards: [card(3, "toolu_card", "server_join_name")] }));
    const view = items.find((i): i is ViewMountItem => i.kind === "view");
    expect(view?.toolTitle).toBe(calmPolicy().tool.humanizeTitle("Card picker"));
  });

  it("an elided call input sends no tool-input", () => {
    const elided: HistoryToolCall = { ...carded, call: { ...carded.call, input: { "com.guuey/elided": { bytes: 400_000 } } } };
    const items = plan(inputs(messages, { historyTools: { calls: [elided], results: [] }, historyCards: [card(3, "toolu_card")] }));
    const view = items.find((i): i is ViewMountItem => i.kind === "view");
    expect(view?.toolData).toEqual({ result: { content: [{ type: "text", text: "shown" }] } });
  });

  it("a failed carded result reads as a failed call", () => {
    const failed: HistoryToolCall = { ...carded, card: { seq: 3, result: { ...cardPart("toolu_card"), outcome: "error", isError: true } } };
    const items = plan(inputs(messages, { historyTools: { calls: [failed], results: [] }, historyCards: [card(3, "toolu_card")] }));
    expect(items.find((i): i is ToolItem => i.kind === "tool")?.state).toBe("failed");
  });

  it("two parallel calls in one message, A carrying UI and B not: the card sits between tool A and tool B", () => {
    const a = call(2, "toolu_a", "show_card", { card: { seq: 3, result: cardPart("toolu_a") } });
    const b = call(2, "toolu_b", "look_up");
    const items = plan(
      inputs(
        [
          { role: "user", text: "both", seq: 1 },
          { role: "assistant", text: "Done.", seq: 5 },
        ],
        { historyTools: { calls: [a, b], results: [result(4, "toolu_b", "found")] }, historyCards: [card(3, "toolu_a")] },
      ),
    );
    expect(keys(items)).toEqual(["u0", "tool.toolu_a", "card.3", "tool.toolu_b", "a0.t0"]);
  });

  it("a card whose call is not on the read keeps its seq placement and its own tool name", () => {
    const items = plan(inputs(messages, { historyTools: { calls: [], results: [] }, historyCards: [card(3, "toolu_card", "server_join_name")] }));
    expect(keys(items)).toEqual(["u0", "card.3", "a0.t0"]);
    const view = items.find((i): i is ViewMountItem => i.kind === "view");
    expect(view?.toolTitle).toBe(calmPolicy().tool.humanizeTitle("server_join_name"));
    expect(view?.attribution).toBeNull();
  });
});

describe("guuey#2388: blockSeqs stay index-aligned with the blocks", () => {
  it("a card with no call on the read anchors on the text row after the tool rows, not on the next turn", () => {
    // The text row (seq 5) is the third block of its group: its seq must be read at index 2.
    const items = plan(
      inputs(
        [
          { role: "user", text: "go", seq: 1 },
          { role: "assistant", text: "A", seq: 5 },
          { role: "user", text: "next", seq: 6 },
          { role: "assistant", text: "B", seq: 7 },
        ],
        {
          historyTools: { calls: [call(2, "toolu_a", "look_up")], results: [result(3, "toolu_a", "found")] },
          historyCards: [card(4, "toolu_other")],
        },
      ),
    );
    expect(keys(items)).toEqual(["u0", "tool.toolu_a", "card.4", "a0.t0", "u1", "a1.t0"]);
  });
});

describe("guuey#2388: a calls-only read (no result on the read) draws a settled, plain call row", () => {
  const messages: TranscriptMessage[] = [
    { role: "user", text: "look", seq: 1 },
    { role: "assistant", text: "Here.", seq: 3 },
  ];
  const callsOnly = { calls: [call(2, "toolu_a", "look_up")], results: [] };

  function ctx(): TranscriptItemContext {
    return { strings: defaultChatStrings, onToggle: () => {}, resolvedMounts: new Map(), onViewPhase: () => {} };
  }

  it("the plan: no spinner, no failure, no result, and the row is marked as read without one", () => {
    const tool = plan(inputs(messages, { historyTools: callsOnly })).find((i): i is ToolItem => i.kind === "tool");
    expect(tool).toMatchObject({ state: "orphaned", result: null, refusal: null, attribution: false, reloadedWithoutResult: true });
  });

  it("the rendering: the call's title alone, with no \"didn't finish\" note and no failed or running state", () => {
    const tool = plan(inputs(messages, { historyTools: callsOnly })).find((i): i is ToolItem => i.kind === "tool");
    if (tool === undefined) throw new Error("expected a tool row");
    const { container } = render(<DefaultTool item={tool} ctx={ctx()} />);
    expect(container.textContent).not.toContain(defaultChatStrings.toolDidntFinish);
    expect(container.querySelector(".guuey-chat-tool-note")).toBeNull();
    expect(container.querySelector(".guuey-chat-tool-failed, .guuey-chat-tool-running")).toBeNull();
    expect(container.querySelector(".guuey-chat-tool-title")?.textContent).toBe(calmPolicy().tool.humanizeTitle("look_up"));
  });

  it("a live call that did not finish keeps its note", () => {
    const reloaded = plan(inputs(messages, { historyTools: callsOnly })).find((i): i is ToolItem => i.kind === "tool");
    if (reloaded === undefined) throw new Error("expected a tool row");
    const { reloadedWithoutResult: _reloaded, ...live } = reloaded;
    const { container } = render(<DefaultTool item={live} ctx={ctx()} />);
    expect(container.textContent).toContain(defaultChatStrings.toolDidntFinish);
  });
});
