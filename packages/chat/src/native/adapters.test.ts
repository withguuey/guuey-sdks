import { describe, expect, it, vi } from "vitest";
import { AgentResponseError, type InvokeRequest } from "@guuey/agent-client";
import {
  asyncStorageThreadStore,
  createNativeAdapters,
  type NativeKeyValueStorage,
} from "./adapters.js";

/** A well-formed guest secret: 64 lowercase hex chars. */
const SECRET = "0123456789abcdef".repeat(4);
const ENDPOINT = "https://pod.example.com/agent/invoke";
const API = "https://api.example.com/v1";

/** An in-memory store with the AsyncStorage shape. */
function fakeStorage(): NativeKeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => Promise.resolve(data.get(key) ?? null),
    setItem: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

type FetchArgs = Parameters<typeof fetch>;

/** A `fetch` that answers from a queue and records every call. */
function fakeFetch(responses: Response[]) {
  const queue = [...responses];
  return vi.fn((_input: FetchArgs[0], _init?: FetchArgs[1]): Promise<Response> => {
    const next = queue.shift();
    if (!next) throw new Error("fakeFetch: no queued response");
    return Promise.resolve(next);
  });
}

function headersOf(init: FetchArgs[1]): Record<string, string> {
  const headers = init?.headers;
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function invokeRequest(): InvokeRequest {
  return {
    url: ENDPOINT,
    body: { input: "hi", clientMessageId: "cmid-1" },
    signal: new AbortController().signal,
  };
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

describe("asyncStorageThreadStore", () => {
  it("round-trips a thread id through the injected storage", async () => {
    const storage = fakeStorage();
    const store = asyncStorageThreadStore(storage);
    expect(await store.load("thread:app-1")).toBeNull();
    await store.save("thread:app-1", "t_1");
    expect(await store.load("thread:app-1")).toBe("t_1");
    expect(storage.data.get("thread:app-1")).toBe("t_1");
  });

  it("namespaces every key under the prefix", async () => {
    const storage = fakeStorage();
    const store = asyncStorageThreadStore(storage, { prefix: "chat/" });
    await store.save("thread:app-1", "t_1");
    expect([...storage.data.keys()]).toEqual(["chat/thread:app-1"]);
    expect(await store.load("thread:app-1")).toBe("t_1");
  });

  it("settles a failed write instead of rejecting — the id stays in memory only", async () => {
    const store = asyncStorageThreadStore({
      getItem: () => Promise.resolve(null),
      setItem: () => Promise.reject(new Error("disk full")),
    });
    await expect(store.save("thread:app-1", "t_1")).resolves.toBeUndefined();
  });
});

describe("createNativeAdapters — transport", () => {
  it("streams through the injected fetch, chunk by chunk as the body arrives", async () => {
    const encoder = new TextEncoder();
    let push: ((text: string) => void) | undefined;
    let end: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(encoder.encode(text));
        end = () => controller.close();
      },
    });
    const fetchImpl = fakeFetch([new Response(body, { status: 200 })]);
    const global = vi.spyOn(globalThis, "fetch");
    try {
      const adapters = createNativeAdapters({ fetch: fetchImpl, storage: fakeStorage() });
      const it = adapters.transport(invokeRequest())[Symbol.asyncIterator]();
      push?.('data: {"type":"session"}\n\n');
      // The first chunk arrives while the body is still open.
      expect(await it.next()).toEqual({ done: false, value: 'data: {"type":"session"}\n\n' });
      push?.('data: {"type":"done"}\n\n');
      expect(await it.next()).toEqual({ done: false, value: 'data: {"type":"done"}\n\n' });
      end?.();
      expect((await it.next()).done).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][0]).toBe(ENDPOINT);
      expect(global).not.toHaveBeenCalled();
    } finally {
      global.mockRestore();
    }
  });

  it("turns a refused invoke into the SDK's AgentResponseError", async () => {
    const fetchImpl = fakeFetch([
      new Response(JSON.stringify({ code: "QUOTA_EXCEEDED", message: "Upgrade to keep chatting." }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    ]);
    const adapters = createNativeAdapters({ fetch: fetchImpl, storage: fakeStorage() });
    const err = await drain(adapters.transport(invokeRequest())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentResponseError);
    expect(err).toMatchObject({ status: 429, code: "QUOTA_EXCEEDED", message: "Upgrade to keep chatting." });
  });

  it("sends an async guest secret as the one identity carrier", async () => {
    const fetchImpl = fakeFetch([new Response("data: ok\n\n", { status: 200 })]);
    const adapters = createNativeAdapters({
      fetch: fetchImpl,
      storage: fakeStorage(),
      getGuestSecret: () => Promise.resolve(SECRET),
    });
    await drain(adapters.transport(invokeRequest()));
    const init = fetchImpl.mock.calls[0][1];
    expect(headersOf(init)["x-guuey-guest"]).toBe(SECRET);
    expect(headersOf(init).Authorization).toBeUndefined();
    expect(init?.credentials).toBeUndefined();
  });

  it("sends only the bearer when a token is present — never two carriers", async () => {
    const fetchImpl = fakeFetch([new Response("data: ok\n\n", { status: 200 })]);
    const adapters = createNativeAdapters({
      fetch: fetchImpl,
      storage: fakeStorage(),
      getAccessToken: () => Promise.resolve("tok_abc"),
      getGuestSecret: () => Promise.resolve(SECRET),
    });
    await drain(adapters.transport(invokeRequest()));
    const init = fetchImpl.mock.calls[0][1];
    expect(headersOf(init).Authorization).toBe("Bearer tok_abc");
    expect(headersOf(init)["x-guuey-guest"]).toBeUndefined();
    expect(init?.credentials).toBeUndefined();
  });
});

describe("createNativeAdapters — storage, ids, history", () => {
  it("persists the thread id through the injected storage under the prefix", async () => {
    const storage = fakeStorage();
    const adapters = createNativeAdapters({ fetch: fakeFetch([]), storage, storagePrefix: "p/" });
    await adapters.storage.save("k", "t_9");
    expect(storage.data.get("p/k")).toBe("t_9");
  });

  it("uses an injected id generator", () => {
    const adapters = createNativeAdapters({
      fetch: fakeFetch([]),
      storage: fakeStorage(),
      generateId: () => "id-1",
    });
    expect(adapters.generateId()).toBe("id-1");
  });

  it("installs no history without an identity the read plane can see", () => {
    const adapters = createNativeAdapters({ fetch: fakeFetch([]), storage: fakeStorage(), apiBaseUrl: API });
    expect(adapters.history).toBeUndefined();
  });

  it("reads history through the injected fetch with the guest header", async () => {
    const fetchImpl = fakeFetch([
      new Response(
        JSON.stringify({
          rows: [{ seq: 1, at: "2026-01-01T00:00:00Z", kind: "text", authorRole: "user", text: "hello" }],
          nextToken: null,
        }),
        { status: 200 },
      ),
    ]);
    const adapters = createNativeAdapters({
      fetch: fetchImpl,
      storage: fakeStorage(),
      apiBaseUrl: API,
      getGuestSecret: () => Promise.resolve(SECRET),
    });
    const result = await adapters.history?.load("t_1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(`${API}/threads/t_1/messages`);
    expect(headersOf(fetchImpl.mock.calls[0][1])["x-guuey-guest"]).toBe(SECRET);
    expect(result).toMatchObject({ messages: [{ role: "user", text: "hello", seq: 1 }] });
  });
});
