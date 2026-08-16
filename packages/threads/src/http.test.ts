/**
 * `HttpThreadPersistence` wire + retry contract (guuey#208). The server half
 * (guuey's `threadsApi` Lambda) runs the port contract suite THROUGH this
 * client in its own tests; here we pin the client's side of the wire —
 * URL/headers/body shape, `null → undefined` on point-reads, the read-only
 * retry budget, and error mapping — against a scripted `fetch`.
 */
import { describe, expect, it } from "vitest";
import { HttpThreadPersistence, HttpThreadStoreError } from "./http.js";
import type { ThreadRow } from "./rows.js";

interface Call {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A `fetch` that replays scripted responses (or throws) and records every call. */
function scripted(steps: Array<Response | Error>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const step = steps.shift();
    if (step === undefined) throw new Error("scripted fetch exhausted");
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetch: fetchImpl, calls };
}

function client(fetchImpl: typeof fetch): HttpThreadPersistence {
  return new HttpThreadPersistence({
    baseUrl: "https://api.example.test/",
    appId: "app_1",
    token: "tok",
    fetchImpl,
  });
}

const THREAD: ThreadRow = {
  id: "t1",
  userId: "byo_x",
  appId: "app_1",
  servingRegion: "us-east-1",
  title: "New thread",
  status: "active",
  pinned: false,
  lastSeq: 0,
  lastMessageAt: "2026-08-17T00:00:00.000Z",
  lastMessagePreview: "",
  threadMode: "single",
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
};

describe("HttpThreadPersistence — wire shape", () => {
  it("POSTs {context:{appId}, args} with the bearer to /v1/thread-store/<op> (trailing slash trimmed)", async () => {
    const { fetch, calls } = scripted([jsonResponse(200, { result: null })]);
    await client(fetch).createThread(THREAD);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.example.test/v1/thread-store/createThread");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tok");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      context: { appId: "app_1" },
      args: { row: THREAD },
    });
  });

  it("maps a null point-read result to undefined (JSON has no undefined)", async () => {
    const { fetch } = scripted([
      jsonResponse(200, { result: null }),
      jsonResponse(200, { result: null }),
      jsonResponse(200, { result: null }),
    ]);
    const c = client(fetch);
    expect(await c.getThread("t-missing")).toBeUndefined();
    expect(await c.getSnapshot("t-missing")).toBeUndefined();
    expect(await c.findByClientMessageId("t-missing", "c1")).toBeUndefined();
  });

  it("returns the server's scope verbatim", async () => {
    const scope = { appId: "app_1", userId: "byo_abc", region: "us-east-1" };
    const { fetch } = scripted([jsonResponse(200, { result: scope })]);
    expect(await client(fetch).scope()).toEqual(scope);
  });
});

describe("HttpThreadPersistence — retry budget", () => {
  it("retries a read ONCE on a network failure, then succeeds", async () => {
    const { fetch, calls } = scripted([new Error("ECONNRESET"), jsonResponse(200, { result: THREAD })]);
    expect(await client(fetch).getThread("t1")).toEqual(THREAD);
    expect(calls).toHaveLength(2);
  });

  it("retries a read ONCE on a 5xx, and surfaces the second failure", async () => {
    const { fetch, calls } = scripted([
      jsonResponse(500, { code: "TRANSPORT", message: "internal error" }),
      jsonResponse(500, { code: "TRANSPORT", message: "internal error" }),
    ]);
    await expect(client(fetch).listRecentMessages("t1", 10)).rejects.toMatchObject({
      status: 500,
      code: "TRANSPORT",
    });
    expect(calls).toHaveLength(2);
  });

  it("NEVER retries a write — a network failure surfaces after one attempt", async () => {
    const { fetch, calls } = scripted([new Error("ECONNRESET")]);
    const err = await client(fetch)
      .incrementSeq("t1", "p", "2026-08-17T00:00:00.000Z")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpThreadStoreError);
    expect((err as HttpThreadStoreError).status).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 4xx and carries the server's code + message", async () => {
    const { fetch, calls } = scripted([
      jsonResponse(404, { code: "THREAD_NOT_FOUND", message: "thread not found" }),
    ]);
    await expect(client(fetch).getSnapshot("t1")).rejects.toMatchObject({
      status: 404,
      code: "THREAD_NOT_FOUND",
      message: "thread not found",
    });
    expect(calls).toHaveLength(1);
  });
});
