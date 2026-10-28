/**
 * `HttpThreadPersistence` wire + retry contract (guuey#208). The server half
 * (guuey's `threadsApi` Lambda) runs the port contract suite THROUGH this
 * client in its own tests; here we pin the client's side of the wire —
 * URL/headers/body shape, `null → undefined` on point-reads, the read-only
 * retry budget, and error mapping — against a scripted `fetch`.
 */
import { describe, expect, it, vi } from "vitest";
import { HttpThreadPersistence, HttpThreadStoreError } from "./http.js";
import { ThreadClosedError } from "./closed.js";
import { threadSealState } from "./seal.js";
import type { ThreadMessageRow, ThreadRow, ThreadSnapshotRow } from "./rows.js";

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

describe("HttpThreadPersistence — a closed thread (guuey#2355)", () => {
  it("answers incrementSeq's 409 THREAD_CLOSED with ThreadClosedError, the same typed refusal every binding gives", async () => {
    const { fetch } = scripted([jsonResponse(409, { code: "THREAD_CLOSED", message: "thread t1 is closed" })]);
    const err = await client(fetch).incrementSeq("t1", "p", "2026-10-15T00:00:00.000Z").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThreadClosedError);
    expect(err instanceof ThreadClosedError && err.threadId).toBe("t1");
  });

  it("keeps every other refusal an HttpThreadStoreError", async () => {
    const { fetch } = scripted([jsonResponse(409, { code: "CONFLICT", message: "conditional write rejected" })]);
    const err = await client(fetch).incrementSeq("t1", "p", "2026-10-15T00:00:00.000Z").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpThreadStoreError);
    expect(err).not.toBeInstanceOf(ThreadClosedError);
  });
});

const MESSAGE: ThreadMessageRow = {
  threadId: "t1",
  seq: 3,
  userId: "byo_x",
  clientMessageId: "c3",
  at: "2026-08-17T00:00:03.000Z",
  kind: "text",
  authorRole: "user",
  text: "hello",
  content: { role: "user", content: [{ type: "text", text: "hello" }] },
  untrustedOrigin: true,
  turnOrigin: "chip",
  clientClass: "browser",
  inputKind: "context-only",
  answeredCardSessionId: "s1",
  tapLabels: ["Yes", null],
  event: { type: "handoff", question: "a human?", contactEmail: "a@b.c" },
};

const SNAPSHOT: ThreadSnapshotRow = {
  threadId: "t1",
  userId: "byo_x",
  workingState: { step: 2, items: ["a", null] },
  threadMemory: [{ scope: "thread", key: "k", value: "v1" }],
  carriedThreadMemory: [{ scope: "team", key: "plan", value: { tier: "pro" } }],
  lastTurnId: "turn-1",
  updatedAt: "2026-08-17T00:00:04.000Z",
};

const ok = (result: unknown) => jsonResponse(200, { result });

/** The error a call rejects with (every refusal here is an HttpThreadStoreError). */
async function refusal(p: Promise<unknown>): Promise<HttpThreadStoreError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof HttpThreadStoreError)) throw new Error(`expected an HttpThreadStoreError, got ${String(err)}`);
  return err;
}

describe("HttpThreadPersistence — every answer is read, never assumed (guuey#2899)", () => {
  it("reads a full row of each kind back exactly as it was written", async () => {
    const { fetch } = scripted([
      ok({ ...THREAD, lastMessagePreviewSeq: 2, sealIntervals: [{ fromSeq: 1, toSeq: 2 }], closedAt: "2026-08-18T00:00:00.000Z", closedCode: "app:limit", closedMessage: "done" }),
      ok([MESSAGE]),
      ok(MESSAGE),
      ok(SNAPSHOT),
      ok(4),
    ]);
    const c = client(fetch);
    expect(await c.getThread("t1")).toEqual({
      ...THREAD,
      lastMessagePreviewSeq: 2,
      sealIntervals: [{ fromSeq: 1, toSeq: 2 }],
      closedAt: "2026-08-18T00:00:00.000Z",
      closedCode: "app:limit",
      closedMessage: "done",
    });
    expect(await c.listRecentMessages("t1", 10)).toEqual([MESSAGE]);
    expect(await c.findByClientMessageId("t1", "c3")).toEqual(MESSAGE);
    expect(await c.getSnapshot("t1")).toEqual(SNAPSHOT);
    expect(await c.incrementSeq("t1", "p", "2026-08-17T00:00:00.000Z")).toBe(4);
  });

  it("a 2xx body that is not JSON, or not a { result } envelope, is BAD_RESPONSE with the status", async () => {
    for (const res of [
      new Response("<html>gateway</html>", { status: 200 }),
      jsonResponse(200, {}),
      jsonResponse(200, [THREAD]),
      jsonResponse(200, null),
    ]) {
      const err = await refusal(client(scripted([res]).fetch).getThread("t1"));
      expect(err).toMatchObject({ status: 200, code: "BAD_RESPONSE" });
    }
  });

  it("a result that is not the op's answer is BAD_RESPONSE: a scope missing a member, a seq that is not an integer", async () => {
    const scope = await refusal(client(scripted([ok({ appId: "app_1", userId: "byo_abc" })]).fetch).scope());
    expect(scope.code).toBe("BAD_RESPONSE");
    for (const seq of ["4", 4.5, null]) {
      const err = await refusal(client(scripted([ok(seq)]).fetch).incrementSeq("t1", "p", "2026-08-17T00:00:00.000Z"));
      expect(err.code).toBe("BAD_RESPONSE");
    }
  });

  it("a row missing a required member, or with one of the wrong type, is BAD_RESPONSE", async () => {
    const { lastSeq: _dropped, ...noSeq } = THREAD;
    const rows: Array<[string, (c: HttpThreadPersistence) => Promise<unknown>, unknown]> = [
      ["getThread without lastSeq", (c) => c.getThread("t1"), noSeq],
      ["getThread with a string pinned", (c) => c.getThread("t1"), { ...THREAD, pinned: "false" }],
      ["a message without its clientMessageId", (c) => c.findByClientMessageId("t1", "c3"), { ...MESSAGE, clientMessageId: undefined }],
      ["a list with one unreadable row", (c) => c.listRecentMessages("t1", 10), [MESSAGE, { ...MESSAGE, seq: "4" }]],
      ["a list that is not an array", (c) => c.listRecentMessages("t1", 10), { rows: [MESSAGE] }],
      ["a snapshot whose threadMemory is not an array", (c) => c.getSnapshot("t1"), { ...SNAPSHOT, threadMemory: {} }],
      ["a snapshot whose carried memory is not an array", (c) => c.getSnapshot("t1"), { ...SNAPSHOT, carriedThreadMemory: "x" }],
    ];
    for (const [label, op, result] of rows) {
      const err = await refusal(op(client(scripted([ok(result)]).fetch)));
      expect({ label, code: err.code }).toEqual({ label, code: "BAD_RESPONSE" });
    }
  });

  it("a stored seal this release cannot read is carried as stored, so readSealState reads the thread as wholly sealed (as over DynamoDB)", async () => {
    for (const stored of ["all", [{ fromSeq: 0 }], { fromSeq: 1 }]) {
      const row = await client(scripted([ok({ ...THREAD, sealIntervals: stored })]).fetch).getThread("t1");
      expect(row).toEqual({ ...THREAD, sealIntervals: stored });
      expect(threadSealState(row ?? THREAD)).toEqual({ kind: "unreadable" });
    }
  });

  it("a non-boolean untrustedOrigin would read as trusted if dropped, so that row is refused", async () => {
    const origin = await refusal(
      client(scripted([ok({ ...MESSAGE, untrustedOrigin: "true" })]).fetch).findByClientMessageId("t1", "c3"),
    );
    expect(origin.code).toBe("BAD_RESPONSE");
  });

  it("an optional member an older server omits, or one of the wrong type, reads as absent", async () => {
    const { fetch } = scripted([
      ok({ ...THREAD, sealIntervals: null, closedAt: 5, lastMessagePreviewSeq: "2" }),
      ok({ ...MESSAGE, text: null, turnOrigin: "voice", clientClass: 1, inputKind: "audio", tapLabels: "Yes", event: { type: "poll" } }),
      ok({ threadId: "t1", userId: "byo_x", threadMemory: [], updatedAt: "2026-08-17T00:00:04.000Z", lastTurnId: 9 }),
    ]);
    const c = client(fetch);
    expect(await c.getThread("t1")).toEqual(THREAD);
    const {
      text: _t,
      turnOrigin: _o,
      clientClass: _k,
      inputKind: _i,
      tapLabels: _l,
      event: _e,
      ...bare
    } = MESSAGE;
    expect(await c.findByClientMessageId("t1", "c3")).toEqual(bare);
    expect(await c.getSnapshot("t1")).toEqual({
      threadId: "t1",
      userId: "byo_x",
      threadMemory: [],
      updatedAt: "2026-08-17T00:00:04.000Z",
    });
  });

  it("N-1: a message kind or authorRole this release does not know (a newer writer's, or none on a legacy row) reads as text / agent, and never refuses the thread's history", async () => {
    const newer = { ...MESSAGE, seq: 4, clientMessageId: "c4", kind: "poll", authorRole: "tool" };
    const { kind: _k, authorRole: _a, ...legacy } = { ...MESSAGE, seq: 5, clientMessageId: "c5" };
    const { fetch } = scripted([ok([MESSAGE, newer, legacy]), ok(newer)]);
    const c = client(fetch);
    expect(await c.listRecentMessages("t1", 10)).toEqual([
      MESSAGE,
      { ...newer, kind: "text", authorRole: "agent" },
      { ...legacy, kind: "text", authorRole: "agent" },
    ]);
    expect(await c.findByClientMessageId("t1", "c4")).toEqual({ ...newer, kind: "text", authorRole: "agent" });
  });

  it("N-1: a legacy message row without a userId reads as the token's user, read once from scope", async () => {
    const { userId: _u, ...noUser } = MESSAGE;
    const { fetch, calls } = scripted([
      ok([noUser, { ...noUser, seq: 4 }]),
      ok({ appId: "app_1", userId: "byo_x", region: "us-east-1" }),
      ok(noUser),
      ok([MESSAGE]),
    ]);
    const c = client(fetch);
    expect(await c.listRecentMessages("t1", 10)).toEqual([MESSAGE, { ...MESSAGE, seq: 4 }]);
    expect(await c.findByClientMessageId("t1", "c3")).toEqual(MESSAGE);
    expect(await c.listRecentMessages("t1", 10)).toEqual([MESSAGE]);
    expect(calls.map((call) => call.url.split("/").pop())).toEqual([
      "listRecentMessages",
      "scope",
      "findByClientMessageId",
      "listRecentMessages",
    ]);
  });

  it("a snapshot memory element this release cannot read as a thread record is carried, never dropped", async () => {
    const orphan = { scope: "thread", key: "orphan" };
    const { fetch } = scripted([ok({ ...SNAPSHOT, threadMemory: [...SNAPSHOT.threadMemory, orphan] })]);
    expect(await client(fetch).getSnapshot("t1")).toEqual({
      ...SNAPSHOT,
      carriedThreadMemory: [...(SNAPSHOT.carriedThreadMemory ?? []), orphan],
    });
  });

  it("a write's 2xx is a committed write whatever its body holds: never BAD_RESPONSE, so a caller never retries it into CONFLICT", async () => {
    for (const res of [
      jsonResponse(200, {}),
      new Response("", { status: 200 }),
      new Response("<html>ok</html>", { status: 200 }),
    ]) {
      await expect(client(scripted([res]).fetch).putMessage(MESSAGE)).resolves.toBeUndefined();
    }
    await expect(client(scripted([new Response("not json", { status: 200 })]).fetch).createThread(THREAD)).resolves.toBeUndefined();
    await expect(client(scripted([new Response("", { status: 201 })]).fetch).putSnapshot(SNAPSHOT)).resolves.toBeUndefined();
  });

  it("a write's 2xx whose body stream errors (a reset after the headers) is still a committed write, and the failed release is reported", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const reset = new TypeError("terminated");
      const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(reset) });
      await expect(client(scripted([new Response(body, { status: 200 })]).fetch).putMessage(MESSAGE)).resolves.toBeUndefined();
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("putMessage"), reset));
    } finally {
      warn.mockRestore();
    }
  });

  it("a refusal's code and message are read only when they are strings; anything else keeps the transport defaults", async () => {
    for (const res of [
      jsonResponse(403, { code: 403, message: ["no"] }),
      jsonResponse(403, ["FORBIDDEN"]),
      new Response("<html>forbidden</html>", { status: 403 }),
    ]) {
      const err = await refusal(client(scripted([res]).fetch).getThread("t1"));
      expect(err).toMatchObject({ status: 403, code: "TRANSPORT", message: "guuey thread API error (HTTP 403)" });
    }
  });
});
