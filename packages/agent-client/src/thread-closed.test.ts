// @vitest-environment jsdom
/**
 * A conversation the agent ended (`threadClosed`): read live from the turn's
 * `event: error` (and its `done`), and on reopen from the transcript read,
 * with the older read plane's fallback (the last row's `app:` failure code).
 * A send on a closed conversation starts a new one.
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import { fetchThreadHistory, type ThreadHistoryRow } from "./history.js";
import { invokeTurn } from "./invoke-turn.js";
import type { AgentInvokeAdapters, HistoryLoadResult, InvokeRequest, InvokeTransport } from "./types.js";

const APP_ID = "app-thread-closed";
const ENDPOINT = "https://pod.example.com";
const CLOSED = { code: "app:CHAT_FULL", message: "This chat is full. Start a new one.", closedAt: "2026-10-15T00:00:00.000Z" };

const frame = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function row(partial: Partial<ThreadHistoryRow>): ThreadHistoryRow {
  return { seq: 1, at: "2026-10-15T00:00:00Z", kind: "text", authorRole: "user", text: "hi", ...partial };
}

async function load(body: object): Promise<HistoryLoadResult> {
  const fetchImpl = vi.fn(async () => jsonResponse(body));
  return fetchThreadHistory({ baseUrl: "https://api.example.com/v1", threadId: "t1", fetchImpl });
}

describe("fetchThreadHistory: closed", () => {
  it("reads the read plane's thread.closed", async () => {
    const result = await load({
      rows: [row({ seq: 1 }), row({ seq: 2, authorRole: "agent", text: CLOSED.message, failure: { code: CLOSED.code } })],
      nextToken: null,
      thread: { closed: CLOSED },
    });
    expect("gone" in result).toBe(false);
    expect("closed" in result && result.closed).toEqual(CLOSED);
  });

  it("reads closed off any page of a paged read", async () => {
    const pages = [
      jsonResponse({ rows: [row({ seq: 1 })], nextToken: "p2", thread: { closed: CLOSED } }),
      jsonResponse({ rows: [row({ seq: 2, authorRole: "agent", text: "x" })], nextToken: null, thread: { closed: CLOSED } }),
    ];
    const fetchImpl = vi.fn(async () => pages.shift() ?? jsonResponse({ rows: [], nextToken: null }));
    const result = await fetchThreadHistory({ baseUrl: "https://api.example.com/v1", threadId: "t1", fetchImpl });
    expect("closed" in result && result.closed).toEqual(CLOSED);
  });

  it("an open thread (no thread.closed, no app: last row) carries no closed", async () => {
    const result = await load({ rows: [row({ seq: 1 }), row({ seq: 2, authorRole: "agent", text: "hello" })], nextToken: null });
    expect("closed" in result).toBe(false);
  });

  it("thread: {} is the read plane saying OPEN, even when the last row is an app: failure row", async () => {
    // A close that failed after its row was written leaves exactly this: the
    // server holds the thread open, and the last-row reading would say closed.
    const result = await load({
      rows: [row({ seq: 1 }), row({ seq: 2, authorRole: "agent", text: CLOSED.message, failure: { code: CLOSED.code } })],
      nextToken: null,
      thread: {},
    });
    expect("gone" in result).toBe(false);
    expect("closed" in result).toBe(false);
  });

  it("drops a malformed thread.closed", async () => {
    const result = await load({ rows: [row({ seq: 1 })], nextToken: null, thread: { closed: { code: 7 } } });
    expect("closed" in result).toBe(false);
  });

  describe("an older read plane (no `thread` field): the last row's app: failure", () => {
    it("reads the conversation as closed, with the row's text as the message and no closedAt", async () => {
      const result = await load({
        rows: [row({ seq: 1 }), row({ seq: 2, authorRole: "agent", text: CLOSED.message, failure: { code: CLOSED.code } })],
        nextToken: null,
      });
      expect("closed" in result && result.closed).toEqual({ code: CLOSED.code, message: CLOSED.message, closedAt: null });
    });

    it("not when the app: row is not the last row", async () => {
      const result = await load({
        rows: [
          row({ seq: 1 }),
          row({ seq: 2, authorRole: "agent", text: CLOSED.message, failure: { code: CLOSED.code } }),
          row({ seq: 3, authorRole: "user", text: "again" }),
        ],
        nextToken: null,
      });
      expect("closed" in result).toBe(false);
    });

    it("not for a platform failure code", async () => {
      const result = await load({
        rows: [row({ seq: 1 }), row({ seq: 2, authorRole: "agent", text: "Something went wrong.", failure: { code: "PLATFORM_ERROR" } })],
        nextToken: null,
      });
      expect("closed" in result).toBe(false);
    });
  });
});

describe("invokeTurn: threadClosed on the error and done frames", () => {
  async function events(...frames: string[]) {
    const transport: InvokeTransport = async function* () {
      for (const f of frames) yield f;
    };
    const out = [];
    for await (const ev of invokeTurn({ url: "u", body: { input: "x" }, signal: new AbortController().signal }, transport)) out.push(ev);
    return out;
  }

  it("carries a well-formed threadClosed, and no key otherwise (today's events unchanged)", async () => {
    const out = await events(
      frame("error", { code: CLOSED.code, message: CLOSED.message, threadClosed: CLOSED }),
      frame("done", { stopReason: "end_turn", threadClosed: CLOSED }),
      frame("error", { code: "PLATFORM_ERROR", message: "m" }),
      frame("done", { stopReason: "error", threadClosed: { code: 1 } }),
    );
    expect(out).toEqual([
      { kind: "error", message: CLOSED.message, code: CLOSED.code, threadClosed: CLOSED },
      { kind: "done", stopReason: "end_turn", threadClosed: CLOSED },
      { kind: "error", message: "m", code: "PLATFORM_ERROR" },
      { kind: "done", stopReason: "error" },
    ]);
  });
});

function mount(opts: { transport: InvokeTransport; storedThreadId?: string; history?: HistoryLoadResult }) {
  const saved: string[] = [];
  const requests: InvokeRequest[] = [];
  let transport = opts.transport;
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => opts.storedThreadId ?? null, save: (_k, v) => void saved.push(v) },
    generateId: () => "cmid",
    transport: (req) => {
      requests.push(req);
      return transport(req);
    },
    ...(opts.history !== undefined ? { history: { load: async () => opts.history as HistoryLoadResult } } : {}),
  };
  const hook = renderHook(() => useAgentInvoke({ endpointUrl: ENDPOINT, appId: APP_ID, adapters }));
  return {
    ...hook,
    saved,
    requests,
    swap: (next: InvokeTransport) => {
      transport = next;
    },
    send: async (input = "hi") => {
      await act(async () => {
        await hook.result.current.send(input);
      });
    },
  };
}

/** The invoke body's `threadId` (the body is opaque JSON to the transport). */
function threadIdOf(body: unknown): unknown {
  return typeof body === "object" && body !== null ? Reflect.get(body, "threadId") : undefined;
}

const streaming =
  (...frames: string[]): InvokeTransport =>
  async function* () {
    for (const f of frames) yield f;
  };

describe("useAgentInvoke.threadClosed", () => {
  it("is null on an ordinary conversation", async () => {
    const h = mount({ transport: streaming(frame("session", { threadId: "t1" }), frame("done", { stopReason: "end_turn" })) });
    await h.send();
    expect(h.result.current.threadClosed).toBeNull();
  });

  it("is set by the closing turn's error frame, beside the error and its app: code", async () => {
    const h = mount({
      transport: streaming(
        frame("session", { threadId: "t1" }),
        frame("error", { code: CLOSED.code, message: CLOSED.message, threadClosed: CLOSED }),
        frame("done", { stopReason: "end_turn", threadId: "t1", threadClosed: CLOSED }),
      ),
    });
    await h.send();
    expect(h.result.current.threadClosed).toEqual(CLOSED);
    expect(h.result.current.errorCode).toBe(CLOSED.code);
    expect(h.result.current.error).toBe(CLOSED.message);
    expect(h.result.current.status).toBe("ready");
  });

  it("is set by done alone (a frame order where the error was not read)", async () => {
    const h = mount({
      transport: streaming(frame("session", { threadId: "t1" }), frame("done", { stopReason: "end_turn", threadClosed: CLOSED })),
    });
    await h.send();
    expect(h.result.current.threadClosed).toEqual(CLOSED);
  });

  it("is set on reopen from history", async () => {
    const h = mount({
      transport: streaming(frame("done", {})),
      storedThreadId: "t1",
      history: { messages: [{ role: "user", text: "hi", seq: 1 }], closed: CLOSED },
    });
    await waitFor(() => expect(h.result.current.threadClosed).toEqual(CLOSED));
    // The transcript is still shown: a closed conversation is read, not hidden.
    expect(h.result.current.messages).toEqual([{ role: "user", text: "hi", seq: 1 }]);
    expect(h.result.current.threadId).toBe("t1");
  });

  it("a send on a closed conversation starts a new one: no threadId on the wire, and the state clears", async () => {
    const h = mount({
      transport: streaming(
        frame("session", { threadId: "t1" }),
        frame("error", { code: CLOSED.code, message: CLOSED.message, threadClosed: CLOSED }),
        frame("done", { stopReason: "end_turn", threadClosed: CLOSED }),
      ),
    });
    await h.send();
    expect(h.result.current.threadId).toBe("t1");
    h.swap(streaming(frame("session", { threadId: "t2" }), frame("done", { stopReason: "end_turn", threadId: "t2" })));
    await h.send("new question");
    expect(threadIdOf(h.requests[1]?.body)).toBeUndefined();
    expect(h.result.current.threadClosed).toBeNull();
    expect(h.result.current.threadId).toBe("t2");
    expect(h.saved).toContain("t2");
  });

  it("reset() clears it", async () => {
    const h = mount({
      transport: streaming(frame("session", { threadId: "t1" }), frame("done", { stopReason: "end_turn", threadClosed: CLOSED })),
    });
    await h.send();
    expect(h.result.current.threadClosed).toEqual(CLOSED);
    act(() => h.result.current.reset());
    expect(h.result.current.threadClosed).toBeNull();
    expect(h.result.current.threadId).toBeNull();
  });
});
