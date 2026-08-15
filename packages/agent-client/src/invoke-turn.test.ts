import { describe, it, expect } from "vitest";
import { invokeTurn, toInvokeUrl, type InvokeTurnEvent } from "./invoke-turn.js";
import type { InvokeRequest, InvokeTransport } from "./types.js";

function request(): InvokeRequest {
  return {
    url: "https://pod.example.com/agent/invoke",
    body: { input: "hi", clientMessageId: "cmid-1" },
    signal: new AbortController().signal,
  };
}

/** A transport that replays fixed SSE chunks. */
function transportOf(...chunks: string[]): InvokeTransport {
  return async function* () {
    for (const chunk of chunks) yield chunk;
  };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function collect(transport: InvokeTransport): Promise<InvokeTurnEvent[]> {
  const events: InvokeTurnEvent[] = [];
  for await (const ev of invokeTurn(request(), transport)) events.push(ev);
  return events;
}

describe("toInvokeUrl", () => {
  it("appends /agent/invoke to a pod base", () => {
    expect(toInvokeUrl("https://pod.example.com")).toBe("https://pod.example.com/agent/invoke");
  });

  it("keeps a full invoke URL as-is — never a double /agent/invoke", () => {
    expect(toInvokeUrl("https://pod.example.com/agent/invoke")).toBe(
      "https://pod.example.com/agent/invoke",
    );
  });

  it("drops trailing slashes from either shape", () => {
    expect(toInvokeUrl("https://pod.example.com/")).toBe("https://pod.example.com/agent/invoke");
    expect(toInvokeUrl("https://pod.example.com/agent/invoke/")).toBe(
      "https://pod.example.com/agent/invoke",
    );
  });
});

describe("invokeTurn", () => {
  it("walks a full turn: session → tool → text → done, with semantic events", async () => {
    const events = await collect(
      transportOf(
        sse("session", { sessionId: "s1", userId: "u1", threadId: "t1" }),
        sse("message", { type: "tool.start", name: "web_search" }),
        sse("message", { type: "tool.done", name: "web_search" }),
        sse("message", { type: "text.delta", delta: "Hello" }),
        sse("message", { type: "text.delta", delta: " world" }),
        sse("done", { stopReason: "end_turn", threadId: "t1" }),
      ),
    );
    expect(events).toEqual([
      { kind: "session", threadId: "t1" },
      {
        kind: "message",
        status: "using-tool",
        activeTool: "web_search",
        assistantText: "",
        agEvents: [],
      },
      { kind: "message", status: "thinking", activeTool: null, assistantText: "", agEvents: [] },
      { kind: "message", status: "responding", assistantText: "Hello", agEvents: [] },
      { kind: "message", status: "responding", assistantText: "Hello world", agEvents: [] },
      { kind: "done", stopReason: "end_turn" },
    ]);
  });

  it("folds the text CUMULATIVELY — every message event carries the whole turn so far", async () => {
    const events = await collect(
      transportOf(
        sse("message", { type: "text.delta", delta: "a" }),
        sse("message", { type: "text.delta", delta: "b" }),
        sse("message", { type: "text.delta", delta: "c" }),
      ),
    );
    expect(
      events.map((ev) => (ev.kind === "message" ? ev.assistantText : "")),
    ).toEqual(["a", "ab", "abc"]);
  });

  it("reassembles SSE frames split across transport chunks", async () => {
    const whole = sse("message", { type: "text.delta", delta: "split" });
    const events = await collect(transportOf(whole.slice(0, 12), whole.slice(12)));
    expect(events).toEqual([
      { kind: "message", status: "responding", assistantText: "split", agEvents: [] },
    ]);
  });

  it("yields a session with a null threadId when the pod sent none", async () => {
    const events = await collect(transportOf(sse("session", { sessionId: "s1", userId: "u1" })));
    expect(events).toEqual([{ kind: "session", threadId: null }]);
  });

  it("leaves status AND activeTool absent for an unknown frame type", async () => {
    const events = await collect(transportOf(sse("message", { type: "telemetry" })));
    expect(events).toEqual([{ kind: "message", assistantText: "", agEvents: [] }]);
    const [ev] = events;
    if (ev.kind !== "message") throw new Error("expected a message event");
    expect("status" in ev).toBe(false);
    expect("activeTool" in ev).toBe(false);
  });

  it("derives the error envelope, with null for a codeless frame", async () => {
    const events = await collect(
      transportOf(
        sse("error", { code: "QUOTA_EXCEEDED", message: "plan limit reached" }),
        sse("error", {}),
      ),
    );
    expect(events).toEqual([
      { kind: "error", message: "plan limit reached", code: "QUOTA_EXCEEDED" },
      { kind: "error", message: "agent error", code: null },
    ]);
  });

  it("yields profile events only for well-formed payloads — malformed ones drop", async () => {
    const events = await collect(
      transportOf(
        sse("profile-consent-needed", { botched: true }),
        sse("profile-link-needed", { alsoBotched: true }),
      ),
    );
    expect(events).toEqual([]);
  });

  it("silently ignores unknown SSE events — additive wire events cost consumers nothing", async () => {
    const events = await collect(
      transportOf(
        sse("some-future-event", { anything: 1 }),
        sse("message", { type: "text.delta", delta: "still fine" }),
      ),
    );
    expect(events).toEqual([
      { kind: "message", status: "responding", assistantText: "still fine", agEvents: [] },
    ]);
  });

  it("propagates a transport throw out of iteration", async () => {
    const failing: InvokeTransport = async function* () {
      yield sse("session", { threadId: "t1" });
      throw new Error("pod unreachable");
    };
    const seen: InvokeTurnEvent[] = [];
    await expect(
      (async () => {
        for await (const ev of invokeTurn(request(), failing)) seen.push(ev);
      })(),
    ).rejects.toThrow("pod unreachable");
    expect(seen).toEqual([{ kind: "session", threadId: "t1" }]);
  });

  it("surfaces validated AgEvents from a silver frame for the caller's reducer", async () => {
    // A minimal VALID AgJSON event — `text.delta` requires { type, id, delta, seq }.
    const agEvent = { type: "text.delta", id: "b1", delta: "hi", seq: 1 };
    const events = await collect(transportOf(sse("message", agEvent)));
    const [ev] = events;
    if (ev.kind !== "message") throw new Error("expected a message event");
    expect(ev.status).toBe("responding");
    expect(ev.assistantText).toBe("hi");
    expect(ev.agEvents.map((e) => e.type)).toEqual(["text.delta"]);
  });
});
