import { describe, expect, it } from "vitest";
import { parseSseEvents, extractAssistantText, reduceAssistantText, parseConsentRequest } from "./sse";

const assistantMsg = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});
const resultMsg = (result: string) => ({ type: "result", subtype: "success", result });

describe("parseSseEvents", () => {
  it("parses a complete event frame and leaves no remainder", () => {
    const { events, rest } = parseSseEvents(
      'event: session\ndata: {"threadId":"t1","userId":"g_x"}\n\n',
    );
    expect(rest).toBe("");
    expect(events).toEqual([
      { event: "session", data: { threadId: "t1", userId: "g_x" } },
    ]);
  });

  it("returns a partial trailing frame as the remainder", () => {
    const { events, rest } = parseSseEvents(
      'event: message\ndata: {"type":"assistant"}\n\nevent: done\ndata: {"stop',
    );
    expect(events).toEqual([{ event: "message", data: { type: "assistant" } }]);
    expect(rest).toBe('event: done\ndata: {"stop');
  });

  it("parses multiple frames in one buffer", () => {
    const { events } = parseSseEvents(
      'event: session\ndata: {"threadId":"t"}\n\nevent: done\ndata: {"stopReason":"end_turn"}\n\n',
    );
    expect(events.map((e) => e.event)).toEqual(["session", "done"]);
  });

  it("keeps non-JSON data as a raw string", () => {
    const { events } = parseSseEvents("event: ping\ndata: keepalive\n\n");
    expect(events[0]).toEqual({ event: "ping", data: "keepalive" });
  });

  it("defaults the event name to 'message' when absent", () => {
    const { events } = parseSseEvents('data: {"a":1}\n\n');
    expect(events[0]?.event).toBe("message");
  });
});

describe("extractAssistantText", () => {
  it("concatenates text blocks from an assistant message", () => {
    const text = extractAssistantText({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello " },
          { type: "tool_use", id: "x", name: "t", input: {} },
          { type: "text", text: "world" },
        ],
      },
    });
    expect(text).toBe("Hello world");
  });

  it("returns '' for an assistant message with only tool_use blocks", () => {
    const text = extractAssistantText({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "x", name: "t", input: {} }] },
    });
    expect(text).toBe("");
  });

  it("returns the result string from a success result", () => {
    expect(
      extractAssistantText({ type: "result", subtype: "success", result: "final answer" }),
    ).toBe("final answer");
  });

  it("ignores an error result", () => {
    expect(
      extractAssistantText({ type: "result", subtype: "error_max_turns" }),
    ).toBe("");
  });

  it("ignores non-assistant message types and non-objects", () => {
    expect(extractAssistantText({ type: "system", subtype: "init" })).toBe("");
    expect(extractAssistantText("nope")).toBe("");
    expect(extractAssistantText(null)).toBe("");
  });
});

describe("reduceAssistantText", () => {
  it("does NOT duplicate when a result echoes the assistant text", () => {
    // The pod emits an assistant message then a result with the SAME final text.
    let acc = "";
    acc = reduceAssistantText(acc, assistantMsg("Hi there!"));
    acc = reduceAssistantText(acc, resultMsg("Hi there!"));
    expect(acc).toBe("Hi there!"); // not "Hi there!Hi there!"
  });

  it("accumulates across multiple assistant messages, then the result replaces", () => {
    let acc = "";
    acc = reduceAssistantText(acc, assistantMsg("Let me check. "));
    acc = reduceAssistantText(acc, assistantMsg("The answer is 42."));
    expect(acc).toBe("Let me check. The answer is 42.");
    acc = reduceAssistantText(acc, resultMsg("The answer is 42."));
    expect(acc).toBe("The answer is 42."); // canonical final supersedes
  });

  it("uses the result as a fallback when no assistant text streamed", () => {
    expect(reduceAssistantText("", resultMsg("only-in-result"))).toBe("only-in-result");
  });

  it("ignores system/empty messages", () => {
    expect(reduceAssistantText("so far", { type: "system", subtype: "init" })).toBe("so far");
  });
});

describe("silver protocol (AgJSON) — the pod DEFAULT (audit G14)", () => {
  // The exact frame family a live claude no-code pod emitted 2026-07-08
  // (captured on dev; reducing it to "" was the confirmed portal/studio
  // empty-render defect).
  const liveTurn = [
    { type: "turn.start", seq: 0, turnId: "t1" },
    { type: "message.start", seq: 1, id: "msg_1", turnId: "t1" },
    { type: "text.start", seq: 2, id: "text:0", turnId: "t1" },
    { type: "text.delta", seq: 3, id: "text:0", delta: "G14-", turnId: "t1" },
    { type: "text.delta", seq: 4, id: "text:0", delta: "PROBE-OK", turnId: "t1" },
    { type: "text.end", seq: 5, id: "text:0", turnId: "t1" },
    { type: "message.end", seq: 6, id: "msg_1", turnId: "t1" },
    { type: "turn.done", seq: 7, turnId: "t1" },
  ];

  it("reduces a live AgJSON turn to the streamed text (deltas append; lifecycle contributes nothing)", () => {
    let text = "";
    for (const f of liveTurn) text = reduceAssistantText(text, f);
    expect(text).toBe("G14-PROBE-OK");
  });

  it("extracts a text.delta's delta and nothing from other AgJSON families", () => {
    expect(extractAssistantText({ type: "text.delta", delta: "hi" })).toBe("hi");
    expect(extractAssistantText({ type: "text.delta" })).toBe("");
    expect(extractAssistantText({ type: "tool.start", name: "todo_create" })).toBe("");
    expect(extractAssistantText({ type: "turn.done" })).toBe("");
  });

  it("reduces a mixed turn (tool.start/tool.done between deltas) to only the streamed text", () => {
    // A tool-using turn: text streams, the tool round-trips mid-message, more
    // text streams. tool.done carries a `content` array of text BLOCKS — that
    // is tool OUTPUT, not assistant prose, and must never leak into the chat.
    const mixedTurn = [
      { type: "turn.start", seq: 0, turnId: "t2" },
      { type: "message.start", seq: 1, id: "msg_1", turnId: "t2" },
      { type: "text.start", seq: 2, id: "text:0", turnId: "t2" },
      { type: "text.delta", seq: 3, id: "text:0", delta: "Creating a todo… ", turnId: "t2" },
      { type: "text.end", seq: 4, id: "text:0", turnId: "t2" },
      { type: "tool.start", seq: 5, toolCallId: "toolu_01", name: "todo_create", turnId: "t2" },
      { type: "tool.args.delta", seq: 6, toolCallId: "toolu_01", delta: '{"title":"buy milk"}', turnId: "t2" },
      { type: "tool.args.assembled", seq: 7, toolCallId: "toolu_01", input: { title: "buy milk" }, turnId: "t2" },
      { type: "message.end", seq: 8, id: "msg_1", turnId: "t2" },
      {
        type: "tool.done",
        seq: 9,
        toolCallId: "toolu_01",
        content: [{ type: "text", text: "TOOL-OUTPUT-NOT-PROSE" }],
        outcome: "ok",
        turnId: "t2",
      },
      { type: "message.start", seq: 10, id: "msg_2", turnId: "t2" },
      { type: "text.start", seq: 11, id: "text:1", turnId: "t2" },
      { type: "text.delta", seq: 12, id: "text:1", delta: "Done!", turnId: "t2" },
      { type: "text.end", seq: 13, id: "text:1", turnId: "t2" },
      { type: "message.end", seq: 14, id: "msg_2", turnId: "t2" },
      { type: "turn.done", seq: 15, turnId: "t2" },
    ];
    let text = "";
    for (const f of mixedTurn) text = reduceAssistantText(text, f);
    expect(text).toBe("Creating a todo… Done!");
    expect(text).not.toContain("TOOL-OUTPUT-NOT-PROSE");
  });

  it("concatenates text across two message.start/message.end cycles in one turn", () => {
    // Multi-message turns (assistant → tool → assistant) render as ONE
    // bubble in the base client: deltas from BOTH messages append in order.
    const twoMessages = [
      { type: "turn.start", seq: 0, turnId: "t3" },
      { type: "message.start", seq: 1, id: "msg_1", turnId: "t3" },
      { type: "text.start", seq: 2, id: "text:0", turnId: "t3" },
      { type: "text.delta", seq: 3, id: "text:0", delta: "First part.", turnId: "t3" },
      { type: "text.end", seq: 4, id: "text:0", turnId: "t3" },
      { type: "message.end", seq: 5, id: "msg_1", turnId: "t3" },
      { type: "message.start", seq: 6, id: "msg_2", turnId: "t3" },
      { type: "text.start", seq: 7, id: "text:1", turnId: "t3" },
      { type: "text.delta", seq: 8, id: "text:1", delta: " Second part.", turnId: "t3" },
      { type: "text.end", seq: 9, id: "text:1", turnId: "t3" },
      { type: "message.end", seq: 10, id: "msg_2", turnId: "t3" },
      { type: "turn.done", seq: 11, turnId: "t3" },
    ];
    let text = "";
    for (const f of twoMessages) text = reduceAssistantText(text, f);
    expect(text).toBe("First part. Second part.");
  });

  it("treats malformed and unknown frames as '' and never throws", () => {
    const junk: unknown[] = [
      // text.delta with a non-string / missing delta (malformed)
      { type: "text.delta", delta: 42 },
      { type: "text.delta", delta: { nested: "no" } },
      { type: "text.delta", delta: null },
      // unknown / future AgJSON families
      { type: "reasoning.delta", delta: "chain-of-thought" },
      { type: "memory.write", scope: "thread", key: "k", value: "v" },
      { type: "some.future.event", payload: { text: "nope" } },
      // structurally hostile payloads
      { type: 123 },
      {},
      [],
      "bare string",
      7,
      true,
      null,
      undefined,
    ];
    for (const frame of junk) {
      let out = "";
      expect(() => {
        out = reduceAssistantText("kept", frame);
      }).not.toThrow();
      expect(out).toBe("kept"); // contributed exactly ''
      expect(extractAssistantText(frame)).toBe("");
    }
  });

  it("replays the FULL G14 probe capture off the wire — state.delta/content.block don't corrupt the text", () => {
    // The complete captured stream shape from the G14 probe: session frame,
    // then the AgJSON turn INCLUDING a state.delta (RFC-6902 patch) and a
    // content.block carrying provider-raw — both of which embed strings that
    // must NOT surface as assistant prose — then done. Delivered as SSE wire
    // bytes and folded exactly the way useAgentInvoke does (parseSseEvents
    // per chunk, carry `rest`, reduce only `message` events).
    const frames = [
      { type: "turn.start", seq: 0, turnId: "t1" },
      { type: "message.start", seq: 1, id: "msg_1", turnId: "t1" },
      { type: "text.start", seq: 2, id: "text:0", turnId: "t1" },
      { type: "text.delta", seq: 3, id: "text:0", delta: "G14-", turnId: "t1" },
      { type: "text.delta", seq: 4, id: "text:0", delta: "PROBE-OK", turnId: "t1" },
      { type: "text.end", seq: 5, id: "text:0", turnId: "t1" },
      {
        type: "state.delta",
        seq: 6,
        patch: [{ op: "replace", path: "/status", value: "STATE-LEAK" }],
        turnId: "t1",
      },
      {
        type: "content.block",
        seq: 7,
        block: {
          type: "provider-raw",
          vendor: "anthropic",
          raw: { type: "text", text: "RAW-LEAK" },
        },
        turnId: "t1",
      },
      { type: "message.end", seq: 8, id: "msg_1", turnId: "t1" },
      { type: "turn.done", seq: 9, turnId: "t1" },
    ];
    const wire =
      'event: session\ndata: {"sessionId":"s1","userId":"g_x","threadId":"th1"}\n\n' +
      frames.map((f) => `event: message\ndata: ${JSON.stringify(f)}\n\n`).join("") +
      'event: done\ndata: {"stopReason":"end_turn","threadId":"th1"}\n\n';

    // Chunk at an awkward mid-frame boundary to exercise the rest-carry the
    // hook relies on (transport chunks never align with frame boundaries).
    const cut = wire.indexOf("PROBE-OK") + 4; // mid-JSON, mid-delta
    const chunks = [wire.slice(0, cut), wire.slice(cut)];

    let buffer = "";
    let text = "";
    const eventNames: string[] = [];
    for (const chunk of chunks) {
      buffer += chunk;
      const { events, rest } = parseSseEvents(buffer);
      buffer = rest;
      for (const ev of events) {
        eventNames.push(ev.event);
        if (ev.event === "message") text = reduceAssistantText(text, ev.data);
      }
    }
    expect(buffer).toBe(""); // whole capture consumed
    expect(eventNames[0]).toBe("session");
    expect(eventNames[eventNames.length - 1]).toBe("done");
    expect(eventNames.filter((e) => e === "message")).toHaveLength(frames.length);
    expect(text).toBe("G14-PROBE-OK");
    expect(text).not.toContain("STATE-LEAK");
    expect(text).not.toContain("RAW-LEAK");
  });
});

describe("parseConsentRequest", () => {
  it("accepts a well-formed read grant", () => {
    expect(parseConsentRequest({ appId: "app_1", requested: "read" })).toEqual({
      appId: "app_1",
      requested: "read",
    });
  });

  it("accepts a well-formed read-write grant", () => {
    expect(parseConsentRequest({ appId: "app_1", requested: "read-write" })).toEqual({
      appId: "app_1",
      requested: "read-write",
    });
  });

  it("strips extra junk, returning only the typed shape", () => {
    expect(
      parseConsentRequest({ appId: "app_1", requested: "read", extra: 9, nested: { x: 1 } }),
    ).toEqual({ appId: "app_1", requested: "read" });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "app_1"],
    ["a number", 5],
    ["an array", [{ appId: "app_1", requested: "read" }]],
    ["missing appId", { requested: "read" }],
    ["an empty appId", { appId: "", requested: "read" }],
    ["a non-string appId", { appId: 5, requested: "read" }],
    ["missing requested", { appId: "app_1" }],
    ["an out-of-range requested", { appId: "app_1", requested: "write" }],
    ["a non-string requested", { appId: "app_1", requested: 2 }],
  ])("rejects %s", (_label, input) => {
    expect(parseConsentRequest(input)).toBeNull();
  });
});
