/**
 * `BlockFold` — the pinned reducer plus `_meta` carriage onto `tool-result`
 * blocks.
 *
 * The carriage exists because the reducer drops `ev._meta` on `tool.done`
 * (only its `text.start` / `reasoning.start` arms carry `_meta` through), and
 * BOTH generative-UI channels — MCP-Apps `_meta.ui` and ggui's
 * `_meta["ai.ggui/render"]` bootstrap — live there and nowhere else. The first
 * test below pins the upstream gap directly, so the day the pin moves and the
 * reducer carries `_meta` itself, this suite says so out loud.
 */
import { describe, expect, it } from "vitest";
import { Reducer, type AgEvent, type AgMeta } from "@silverprotocol/core";
import { BlockFold, withToolResultMeta } from "./fold";

const TURN = "turn_1";
const MSG = "msg_1";
const CALL = "toolu_1";

const RENDER_META: AgMeta = {
  "ai.ggui/render": { sessionId: "render_1", runtimeUrl: "https://ggui.test/r.js" },
};

/** A minimal but REAL turn: one assistant message, one tool call, one result. */
function turnEvents(meta?: AgMeta): AgEvent[] {
  return [
    { type: "turn.start", seq: 0, turnId: TURN },
    { type: "message.start", seq: 1, id: MSG, turnId: TURN, role: "assistant" },
    { type: "tool.start", seq: 2, turnId: TURN, toolCallId: CALL, name: "ggui_render", index: 0, messageId: MSG },
    { type: "tool.args.assembled", seq: 3, toolCallId: CALL, input: {} },
    { type: "message.end", seq: 4, id: MSG },
    {
      type: "tool.done",
      seq: 5,
      turnId: TURN,
      toolCallId: CALL,
      content: [],
      outcome: "ok",
      isError: false,
      messageId: `${CALL}:result`,
      uiData: { resourceUri: "ui://ggui/render/render_1/hash" },
      ...(meta !== undefined ? { _meta: meta } : {}),
    },
    { type: "turn.end", seq: 6, turnId: TURN },
  ];
}

function toolResultBlocks(messages: { content: { type: string }[] }[]) {
  return messages.flatMap((m) => m.content).filter((b) => b.type === "tool-result");
}

describe("the upstream gap this wrapper repairs", () => {
  it("the pinned Reducer drops `_meta` from a tool.done", () => {
    const reducer = new Reducer();
    for (const ev of turnEvents(RENDER_META)) reducer.push(ev);
    const blocks = toolResultBlocks(reducer.result().messages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).not.toHaveProperty("_meta");
  });
});

describe("BlockFold", () => {
  it("re-attaches a tool.done's `_meta` onto its folded tool-result block", () => {
    const fold = new BlockFold();
    for (const ev of turnEvents(RENDER_META)) fold.push(ev);
    const blocks = toolResultBlocks(fold.result().messages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toHaveProperty("_meta", RENDER_META);
  });

  it("folds identically to the Reducer when nothing carries `_meta`", () => {
    const fold = new BlockFold();
    const reducer = new Reducer();
    for (const ev of turnEvents()) {
      fold.push(ev);
      reducer.push(ev);
    }
    expect(fold.result()).toEqual(reducer.result());
  });

  it("proxies `needsResync` — a parked fold stays visibly parked", () => {
    const fold = new BlockFold();
    expect(fold.needsResync).toBe(false);
    // A seq gap is the reducer's own park trigger; the wrapper must not mask it.
    fold.push({ type: "turn.start", seq: 0, turnId: TURN });
    fold.push({ type: "turn.end", seq: 9, turnId: TURN });
    expect(fold.needsResync).toBe(true);
  });

  it("ignores an extension event that borrows the `tool.done` type name", () => {
    // `AgEvent`'s open `AgExtEvent` arm allows `type: "tool.done"` with a
    // non-string toolCallId; it must never become a carriage key.
    const fold = new BlockFold();
    const extEvent: AgEvent = { type: "tool.done", seq: 0, toolCallId: 42, _meta: RENDER_META };
    fold.push(extEvent);
    expect(fold.result().messages).toEqual([]);
  });
});

describe("withToolResultMeta", () => {
  const result = {
    messages: [
      {
        id: MSG,
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "hi" },
          { type: "tool-result" as const, toolCallId: CALL, content: [] },
        ],
      },
    ],
    artifacts: [],
    memory: [],
    turns: [],
  };

  it("returns the SAME object when there is nothing to attach", () => {
    expect(withToolResultMeta(result, new Map())).toBe(result);
    expect(withToolResultMeta(result, new Map([["other-call", RENDER_META]]))).toBe(result);
  });

  it("never overwrites a `_meta` the fold already produced", () => {
    const own: AgMeta = { ui: { resourceUri: "ui://already-there" } };
    const withOwn = {
      ...result,
      messages: [
        {
          ...result.messages[0],
          content: [{ type: "tool-result" as const, toolCallId: CALL, content: [], _meta: own }],
        },
      ],
    };
    const out = withToolResultMeta(withOwn, new Map([[CALL, RENDER_META]]));
    expect(out).toBe(withOwn);
  });

  it("leaves untouched messages reference-identical (React identity)", () => {
    const two = {
      ...result,
      messages: [
        { id: "m0", role: "user" as const, content: [{ type: "text" as const, text: "q" }] },
        ...result.messages,
      ],
    };
    const out = withToolResultMeta(two, new Map([[CALL, RENDER_META]]));
    expect(out).not.toBe(two);
    expect(out.messages[0]).toBe(two.messages[0]);
    expect(out.messages[1]).not.toBe(two.messages[1]);
  });
});
