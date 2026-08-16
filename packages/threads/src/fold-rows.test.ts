import { describe, it, expect } from "vitest";
import type { AgMessage, AgArtifact } from "@silverprotocol/core";
import { AgMessage as AgMessageSchema } from "@silverprotocol/core";
import {
  agMessageToRow,
  agArtifactToCardRow,
  rowToAgMessage,
  cardRowToAgArtifact,
  messageText,
  uiCardArtifactsFromMessages,
} from "./fold-rows.js";

const ctx = {
  threadId: "t1",
  userId: "g_abc",
  seq: 5,
  at: "2026-06-23T00:00:00.000Z",
  clientMessageId: "k#agent#0",
};

const assistantMsg: AgMessage = {
  id: "m1",
  role: "assistant",
  content: [{ type: "text", text: "Hello there" }],
  turnId: "turn1",
  threadId: "t1",
};

describe("agMessageToRow", () => {
  it("stores the verbatim AgMessage in content and projects text + role", () => {
    const row = agMessageToRow(assistantMsg, {
      ...ctx,
      turnRecord: { turnId: "turn1", threadId: "t1" },
    });
    expect(row.content).toEqual(assistantMsg);
    expect(row.text).toBe("Hello there");
    expect(row.authorRole).toBe("agent");
    expect(row.kind).toBe("text");
    expect(row.aiContext).toEqual({ turnId: "turn1", threadId: "t1" });
    expect(row.seq).toBe(5);
  });

  it("round-trips the AgMessage byte-for-byte through rowToAgMessage", () => {
    const row = agMessageToRow(assistantMsg, ctx);
    const back = rowToAgMessage(row);
    expect(back).toEqual(assistantMsg);
    expect(AgMessageSchema.safeParse(back).success).toBe(true);
  });
});

describe("agArtifactToCardRow", () => {
  const art: AgArtifact = {
    artifactId: "a1",
    turnId: "turn1",
    threadId: "t1",
    name: "weather-card",
    parts: [{ type: "text", text: '{"city":"NYC"}' }],
  };
  it("stores the artifact in cardSnapshot under kind=card and round-trips", () => {
    const row = agArtifactToCardRow(art, ctx);
    expect(row.kind).toBe("card");
    expect(row.cardSnapshot).toEqual(art);
    expect(row.authorRole).toBe("agent");
    expect(cardRowToAgArtifact(row)).toEqual(art);
  });
});

describe("rowToAgMessage — user-row synthesis", () => {
  it("synthesizes a user AgMessage from a plain-text content row", () => {
    const userRow = {
      threadId: "t1",
      seq: 1,
      userId: "g_abc",
      clientMessageId: "k",
      at: ctx.at,
      kind: "text" as const,
      authorRole: "user" as const,
      text: "what is the weather",
      content: { kind: "text", text: "what is the weather" },
    };
    const msg = rowToAgMessage(userRow);
    expect(msg.role).toBe("user");
    expect(msg.content).toEqual([{ type: "text", text: "what is the weather" }]);
    expect(AgMessageSchema.safeParse(msg).success).toBe(true);
  });
});

describe("messageText", () => {
  it("joins text blocks with a paragraph break (#98), ignoring non-text", () => {
    expect(
      messageText({
        id: "m",
        role: "assistant",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      } as AgMessage)
    ).toBe("a\n\nb");
  });

  it("skips empty text blocks without stacking separators", () => {
    expect(
      messageText({
        id: "m",
        role: "assistant",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "" },
          { type: "text", text: "b" },
        ],
      } as AgMessage)
    ).toBe("a\n\nb");
  });
});

import { reduce, Reducer, type AgEvent, type AgMemoryRecord } from "@silverprotocol/core";
import { reassembleFold, seedEventsForReducer } from "./fold-rows.js";
import type { ThreadSnapshotRow, ThreadMessageRow } from "./rows.js";

// Build a representative single-turn agent event stream: an assistant message
// with a text block, plus a turn record, plus one artifact.
function agentStream(): AgEvent[] {
  return [
    { seq: 0, type: "turn.start", turnId: "turn1", threadId: "t1" },
    { seq: 1, type: "message.start", id: "m1", role: "assistant", turnId: "turn1", threadId: "t1" },
    { seq: 2, type: "text.start", id: "b1", messageId: "m1" },
    { seq: 3, type: "text.delta", id: "b1", messageId: "m1", delta: "Sunny, 72°F." },
    { seq: 4, type: "text.end", id: "b1", messageId: "m1" },
    { seq: 5, type: "message.end", id: "m1", turnId: "turn1" },
    { seq: 6, type: "artifact.start", artifactId: "art1", turnId: "turn1", threadId: "t1", name: "weather-card" },
    { seq: 7, type: "artifact.delta", artifactId: "art1", part: { type: "text", text: '{"city":"NYC"}' }, append: false },
    { seq: 8, type: "artifact.end", artifactId: "art1", lastChunk: true },
    { seq: 9, type: "turn.done", turnId: "turn1", threadId: "t1", finishReason: "stop", outcome: { type: "success" } },
  ] as AgEvent[];
}

describe("reassembleFold — byte-identity", () => {
  it("rows+snapshot reassemble to the same agent-folded AgReduceResult", () => {
    // Silverprotocol MAJOR batch B / M50 (audit 2026-07-02): batch reduce()
    // now returns { result, needsResync } instead of the bare AgReduceResult
    // (core/src/reduce.ts `export function reduce`) — destructure `.result`.
    const { result: fold } = reduce(agentStream());
    // Verify the artifact was actually produced so the assertion below is non-vacuous.
    expect(fold.artifacts.length).toBeGreaterThanOrEqual(1);
    // Map fold → rows (the write path, simplified: one row per message + one per artifact).
    let seq = 0;
    const msgRows = fold.messages.map((m) =>
      agMessageToRow(m, {
        threadId: "t1",
        userId: "g_abc",
        seq: seq++,
        at: "2026-06-23T00:00:00.000Z",
        clientMessageId: `k#agent#${seq}`,
        turnRecord: fold.turns.find((t) => t.turnId === m.turnId),
      })
    );
    const artRows = fold.artifacts.map((a) =>
      agArtifactToCardRow(a, {
        threadId: "t1",
        userId: "g_abc",
        seq: seq++,
        at: "2026-06-23T00:00:00.000Z",
        clientMessageId: `k#card#${seq}`,
      })
    );
    const rows = [...msgRows, ...artRows];
    const snapshot: ThreadSnapshotRow | undefined =
      fold.state === undefined && fold.memory.length === 0
        ? undefined
        : {
            threadId: "t1",
            userId: "g_abc",
            threadMemory: fold.memory,
            updatedAt: "2026-06-23T00:00:00.000Z",
            ...(fold.state !== undefined ? { workingState: fold.state } : {}),
          };

    const back = reassembleFold(rows, snapshot);
    expect(back.messages).toEqual(fold.messages);
    expect(back.artifacts).toEqual(fold.artifacts);
    expect(back.turns).toEqual(fold.turns);
    expect(back.memory).toEqual(fold.memory);
    expect(back.state).toEqual(fold.state);
  });

  it("orders messages and artifacts by row seq (creation order)", () => {
    const rows: ThreadMessageRow[] = [
      agMessageToRow(
        { id: "m1", role: "assistant", content: [{ type: "text", text: "first" }] },
        { threadId: "t1", userId: "u", seq: 0, at: "x", clientMessageId: "a" }
      ),
      agArtifactToCardRow(
        { artifactId: "a1", turnId: "turn1", threadId: "t1", parts: [] },
        { threadId: "t1", userId: "u", seq: 1, at: "x", clientMessageId: "b" }
      ),
      agMessageToRow(
        { id: "m2", role: "assistant", content: [{ type: "text", text: "second" }] },
        { threadId: "t1", userId: "u", seq: 2, at: "x", clientMessageId: "c" }
      ),
    ];
    const back = reassembleFold(rows.slice().reverse(), undefined); // unsorted input
    expect(back.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(back.artifacts.map((a) => a.artifactId)).toEqual(["a1"]);
  });
});

describe("seedEventsForReducer", () => {
  it("seeds state so a later state.delta applies on the prior base", () => {
    const r = new Reducer();
    for (const ev of seedEventsForReducer({ count: 1 }, [])) r.push(ev);
    // This turn emits a delta incrementing count (RFC-6902 replace).
    r.push({
      seq: 0,
      type: "state.delta",
      patch: [{ op: "replace", path: "/count", value: 2 }],
    } as AgEvent);
    expect(r.result().state).toEqual({ count: 2 });
  });

  it("seeds prior thread-memory so this turn merges (not replaces) by key", () => {
    const r = new Reducer();
    const prior: AgMemoryRecord[] = [{ scope: "thread", key: "name", value: "Ada" }];
    for (const ev of seedEventsForReducer(undefined, prior)) r.push(ev);
    r.push({ seq: 0, type: "memory.write", scope: "thread", key: "city", value: "NYC" } as AgEvent);
    const mem = r.result().memory;
    expect(mem).toHaveLength(2);
    expect(mem.find((m) => m.key === "name")?.value).toBe("Ada");
    expect(mem.find((m) => m.key === "city")?.value).toBe("NYC");
  });

  it("emits nothing to seed when there is no prior state or memory", () => {
    expect(seedEventsForReducer(undefined, [])).toEqual([]);
  });

  it("does not seed messages/artifacts/turns (append components stay empty)", () => {
    const r = new Reducer();
    for (const ev of seedEventsForReducer({ x: 1 }, [{ scope: "thread", key: "k", value: "v" }]))
      r.push(ev);
    const res = r.result();
    expect(res.messages).toEqual([]);
    expect(res.artifacts).toEqual([]);
    expect(res.turns).toEqual([]);
  });

  // AMENDMENT: a re-seeded thread-memory record must carry its turnId so the
  // landed AgMemoryRecord stays byte-identical to a single-batch reduce(). The
  // memory.write SET handler lands turnId onto the record (core/src/reduce.ts),
  // so omitting it from the synthetic event silently drops turnId from turn 2 on.
  // This test deep-equals the FULL memory (turnId included), not just .value, so
  // it fails without the fix and passes with it. (threadId is intentionally NOT
  // asserted to round-trip — memory.write has no threadId on its event arm.)
  it("seeds full thread-memory (incl. turnId) so two-turn memory is byte-identical to single-batch reduce", () => {
    // Prior memory record carries a turnId (as a real fold would land it).
    const prior: AgMemoryRecord[] = [{ scope: "thread", key: "name", value: "Ada", turnId: "turn1" }];
    // This turn writes a different key, naming its own turn.
    const turnEvents: AgEvent[] = [
      { seq: 0, type: "memory.write", scope: "thread", key: "city", value: "NYC", turnId: "turn2" } as AgEvent,
    ];

    // Incremental path: seed prior, then fold this turn.
    const incremental = new Reducer();
    for (const ev of seedEventsForReducer(undefined, prior)) incremental.push(ev);
    for (const ev of turnEvents) incremental.push(ev);
    const incrementalMem = incremental.result().memory;

    // Single-batch reference: the original write that produced `prior` plus this
    // turn's write, folded in one pass. This is the byte-identity target.
    // M50 (audit 2026-07-02): reduce() returns { result, needsResync } — read
    // memory off .result, not the bare return value.
    const singleBatch = reduce([
      { seq: 0, type: "memory.write", scope: "thread", key: "name", value: "Ada", turnId: "turn1" } as AgEvent,
      { seq: 1, type: "memory.write", scope: "thread", key: "city", value: "NYC", turnId: "turn2" } as AgEvent,
    ]).result.memory;

    // Sort both by key so ordering differences don't mask the field-level compare.
    const byKey = (a: AgMemoryRecord, b: AgMemoryRecord) => (a.key ?? "").localeCompare(b.key ?? "");
    expect([...incrementalMem].sort(byKey)).toEqual([...singleBatch].sort(byKey));
    // Explicit turnId assertion (the field the bug drops).
    expect(incrementalMem.find((m) => m.key === "name")?.turnId).toBe("turn1");
    expect(incrementalMem.find((m) => m.key === "city")?.turnId).toBe("turn2");
  });
});

describe("uiCardArtifactsFromMessages (guuey#86 card rehydration)", () => {
  const uiResource = { uri: "ui://checklist/1", mimeType: "text/html", text: "<html>card</html>" };

  const msgWith = (content: AgMessage["content"]): AgMessage => ({
    id: "m9",
    role: "assistant",
    content,
    turnId: "turn9",
    threadId: "t1",
  });

  it("projects a tool-result with uiData into an AgArtifact-shaped card snapshot", () => {
    const block = {
      type: "tool-result" as const,
      toolCallId: "call1",
      content: [],
      uiData: uiResource,
    };
    const arts = uiCardArtifactsFromMessages([msgWith([block])]);
    expect(arts).toHaveLength(1);
    expect(arts[0]).toEqual({
      artifactId: "m9#ui#0",
      turnId: "turn9",
      threadId: "t1",
      parts: [block],
    });
    // The synthesized artifact must survive the existing card-row round trip.
    const row = agArtifactToCardRow(arts[0]!, ctx);
    expect(row.kind).toBe("card");
    expect(cardRowToAgArtifact(row)).toEqual(arts[0]);
  });

  it("accepts uiData wrapped as { resource } (MCP resource content-part shape)", () => {
    const block = {
      type: "tool-result" as const,
      toolCallId: "call1",
      content: [],
      uiData: { resource: uiResource },
    };
    expect(uiCardArtifactsFromMessages([msgWith([block])])).toHaveLength(1);
  });

  it("accepts a ui:// resource degraded into a provider-raw content part", () => {
    const block = {
      type: "tool-result" as const,
      toolCallId: "call1",
      content: [{ type: "provider-raw" as const, vendor: "anthropic", raw: { resource: uiResource } }],
    };
    expect(uiCardArtifactsFromMessages([msgWith([block])])).toHaveLength(1);
  });

  it("rejects non-UI results: no uiData, plain text uiData, and non-ui:// provider-raw", () => {
    const plain = { type: "tool-result" as const, toolCallId: "c", content: [] };
    const textual = { type: "tool-result" as const, toolCallId: "c", content: [], uiData: "done" };
    const file = {
      type: "tool-result" as const,
      toolCallId: "c",
      content: [
        {
          type: "provider-raw" as const,
          vendor: "anthropic",
          raw: { resource: { uri: "file://a.txt", text: "hi" } },
        },
      ],
    };
    expect(uiCardArtifactsFromMessages([msgWith([plain, textual, file])])).toHaveLength(0);
  });

  it("_meta alone never mints — a render-slice-bearing result with no uiData yields no card row (guuey#170)", () => {
    // The card criterion reads uiData/content ONLY; `_meta` is live-turn
    // material the boundary strips. This pins the repo-side half of the
    // #170 coupling: the claude-agent-sdk facet stamps uiData exactly when
    // the result's `_meta.ui` is present, so meta-less ggui amend/no-op
    // results reach this projector without uiData and must persist nothing.
    // If either side of that coupling shifts, this is the test that names it.
    const metaOnly = {
      type: "tool-result" as const,
      toolCallId: "c",
      content: [],
      _meta: {
        "ai.ggui/render": {
          runtimeUrl: "https://mcp.ggui.ai/runtime.js",
          wsUrl: "wss://mcp.ggui.ai/session",
          wsToken: "short-ttl",
        },
      },
    };
    expect(uiCardArtifactsFromMessages([msgWith([metaOnly])])).toHaveLength(0);
  });

  it("indexes multiple UI results within one message distinctly", () => {
    const b = (id: string) => ({
      type: "tool-result" as const,
      toolCallId: id,
      content: [],
      uiData: uiResource,
    });
    const arts = uiCardArtifactsFromMessages([msgWith([b("c1"), { type: "text", text: "x" }, b("c2")])]);
    expect(arts.map((a) => a.artifactId)).toEqual(["m9#ui#0", "m9#ui#2"]);
  });
});

describe("uiCardArtifactsFromMessages — ui:// locators persist as placeholders (#122, reverses the old deliberate exclusion)", () => {
  it("projects a locator-only uiData ({sessionId, resourceUri}) into a placeholder row with no mount material", () => {
    // Pre-#122 the projector deliberately REJECTED this shape (a persisted
    // bootstrap would remount dead on its expired wsToken). The spec-shaped
    // answer landed instead: persist the locator, strip `_meta`, and
    // rehydrate by a fresh `resources/read` of the uri — so the projector
    // now KEEPS the block, minus its mount material.
    const gguiBlock = {
      type: "tool-result" as const,
      toolCallId: "call1",
      content: [],
      uiData: { sessionId: "render_abc", resourceUri: "ui://ggui/render/abc" },
      _meta: {
        "ai.ggui/render": {
          runtimeUrl: "https://mcp.ggui.ai/runtime.js",
          wsUrl: "wss://mcp.ggui.ai/session",
          wsToken: "expired-token",
        },
      },
    };
    const msg: AgMessage = {
      id: "m10",
      role: "assistant",
      content: [gguiBlock],
      turnId: "turn10",
      threadId: "t1",
    };
    const arts = uiCardArtifactsFromMessages([msg]);
    expect(arts).toHaveLength(1);
    expect(arts[0]!.parts[0]).toMatchObject({
      uiData: { resourceUri: "ui://ggui/render/abc" },
    });
    expect(JSON.stringify(arts[0])).not.toContain("wsToken");
  });

  // guuey#209 (route-A finding): a producer that withholds `_meta` gets NO
  // `uiData` from the normalizer (AgJSON §2.1 — no `_meta.ui` sibling ⇒
  // structuredContent is model-channel data), so the locator arrives in
  // `structuredContent.resourceUri`. Before this read the projector minted
  // nothing for it and the read plane 404'd the render's own locator.
  it("projects a META-LESS locator (structuredContent.resourceUri, no uiData, no _meta) into a placeholder row (#209)", () => {
    const metaLess = {
      type: "tool-result" as const,
      toolCallId: "call1",
      content: [{ type: "text" as const, text: "rendered" }],
      outcome: "ok" as const,
      isError: false,
      structuredContent: { resourceUri: "ui://ggui/render/abc/h1", sessionId: "render_abc" },
    };
    const msg: AgMessage = {
      id: "m11",
      role: "tool",
      content: [metaLess],
      turnId: "turn11",
      threadId: "t1",
    };
    const arts = uiCardArtifactsFromMessages([msg]);
    expect(arts).toHaveLength(1);
    expect(arts[0]!.parts[0]).toMatchObject({
      structuredContent: { resourceUri: "ui://ggui/render/abc/h1" },
    });
  });
});

// guuey#122 — the persistence boundary strips tool-result `_meta` (live-turn
// mount material; vendor slices carry short-TTL credentials) and persists a
// placeholder row for ui:// locators. The fixture is ggui-render-shaped
// because that's the concrete producer, but the rule is vendor-neutral.
describe("tool-result _meta never persists; ui:// locators earn placeholder rows (#122)", () => {
  const gguiBlock = {
    type: "tool-result" as const,
    toolCallId: "toolu_g1",
    content: [],
    uiData: {
      resourceUri: "ui://ggui/render/sess-1/hash-1",
      sessionId: "sess-1",
    },
    _meta: {
      "ai.ggui/render": {
        runtimeUrl: "https://runtime.ggui.ai/r.js",
        wsUrl: "wss://live.ggui.ai/sess-1",
        wsToken: "SHORT-TTL-SECRET",
        sessionId: "sess-1",
      },
    },
  };
  const msg: AgMessage = {
    id: "m9",
    role: "assistant",
    content: [gguiBlock],
    turnId: "t9",
    threadId: "th9",
  };
  const ctx = {
    threadId: "th9",
    userId: "u9",
    seq: 3,
    at: "2026-08-08T00:00:00Z",
    clientMessageId: "c9",
  };

  it("projects a ui:// locator result into a card row — locator kept, _meta gone, no wsToken anywhere", () => {
    const artifacts = uiCardArtifactsFromMessages([msg]);
    expect(artifacts).toHaveLength(1);
    const part = artifacts[0]!.parts[0]!;
    expect(part).toMatchObject({
      type: "tool-result",
      uiData: { resourceUri: "ui://ggui/render/sess-1/hash-1", sessionId: "sess-1" },
    });
    expect("_meta" in part).toBe(false);
    const row = agArtifactToCardRow(artifacts[0]!, ctx);
    expect(JSON.stringify(row)).not.toContain("wsToken");
    expect(JSON.stringify(row)).not.toContain("SHORT-TTL-SECRET");
  });

  it("strips _meta from the message row's persisted content too", () => {
    const row = agMessageToRow(msg, ctx);
    expect(JSON.stringify(row)).not.toContain("wsToken");
    const persisted = row.content as AgMessage;
    expect("_meta" in persisted.content[0]!).toBe(false);
    // The locator survives on the persisted block.
    expect(persisted.content[0]).toMatchObject({
      uiData: { resourceUri: "ui://ggui/render/sess-1/hash-1" },
    });
  });

  it("leaves messages without tool-result _meta untouched (identity, no gratuitous copies)", () => {
    const plain: AgMessage = {
      id: "m10",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    };
    const row = agMessageToRow(plain, {
      ...ctx,
      clientMessageId: "c10",
    });
    expect(row.content).toBe(plain);
  });
});

// #122 hardening (five-lens revisit): the artifact LANE — real artifact.*
// events, not the projection — must obey the same persistence boundary.
describe("agArtifactToCardRow strips tool-result _meta and artifact _meta (#122 artifact lane)", () => {
  it("never persists a wsToken riding an artifact's tool-result part or the artifact's own _meta", () => {
    const art = {
      artifactId: "a-leak",
      turnId: "t1",
      threadId: "th1",
      parts: [
        {
          type: "tool-result",
          toolCallId: "c1",
          content: [],
          uiData: { resourceUri: "ui://ggui/render/s/h" },
          _meta: { "ai.ggui/render": { wsToken: "SHORT-TTL-SECRET" } },
        },
        { type: "text", text: "kept" },
      ],
      _meta: { transport: { wsToken: "ALSO-SECRET" } },
    } as unknown as AgArtifact;
    const row = agArtifactToCardRow(art, {
      threadId: "th1",
      userId: "u",
      seq: 9,
      at: "2026-08-08T00:00:00Z",
      clientMessageId: "c-leak",
    });
    expect(JSON.stringify(row)).not.toContain("wsToken");
    expect(JSON.stringify(row)).not.toContain("SECRET");
    const snap = row.cardSnapshot as AgArtifact;
    expect(snap.parts[1]).toEqual({ type: "text", text: "kept" });
    expect(snap.parts[0]).toMatchObject({ uiData: { resourceUri: "ui://ggui/render/s/h" } });
  });
});
