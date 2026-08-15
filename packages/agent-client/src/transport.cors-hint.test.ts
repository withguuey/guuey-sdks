// @vitest-environment jsdom
/**
 * guuey#186 Gap 2 (error-site half): a network-level `TypeError` on a
 * cross-origin invoke from a browser very often means the app's
 * `allowedDomains` is missing the embedding origin — and the web platform
 * deliberately says nothing more specific. The transport adds a HINT at the
 * error site; these tests pin that it fires ONLY where a CORS refusal is
 * possible (browser + cross-origin) and preserves the original error.
 *
 * jsdom gives this file a real `location` (http://localhost:3000); the
 * node-environment suite in `transport.test.ts` pins the no-`location` case.
 */
import { describe, it, expect, vi } from "vitest";
import { fetchStreamTransport } from "./transport.js";
import type { InvokeRequest } from "./types.js";

function request(url: string): InvokeRequest {
  return {
    url,
    body: { input: "hi", clientMessageId: "cmid-1" },
    signal: new AbortController().signal,
  };
}

async function rejection(stream: AsyncIterable<string>): Promise<unknown> {
  try {
    for await (const chunk of stream) void chunk;
  } catch (err) {
    return err;
  }
  throw new Error("expected the stream to reject");
}

async function withFailingFetch<T>(failure: Error, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(() => Promise.reject(failure));
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe("fetchStreamTransport — cross-origin TypeError hint", () => {
  it("appends the allowedDomains hint on a cross-origin network TypeError, preserving the original as cause", async () => {
    const original = new TypeError("Failed to fetch");
    const err = await withFailingFetch(original, () =>
      rejection(fetchStreamTransport(request("https://pod.example.com/agent/invoke"))),
    );
    expect(err).toBeInstanceOf(TypeError);
    const typed = err as TypeError;
    expect(typed.message).toContain("Failed to fetch");
    expect(typed.message).toContain("allowedDomains");
    expect(typed.cause).toBe(original);
  });

  it("leaves a same-origin TypeError untouched — that cannot be a CORS refusal", async () => {
    const original = new TypeError("Failed to fetch");
    const err = await withFailingFetch(original, () =>
      rejection(fetchStreamTransport(request(`${location.origin}/agent/invoke`))),
    );
    expect(err).toBe(original);
  });

  it("leaves a non-TypeError failure untouched", async () => {
    const original = new Error("boom");
    const err = await withFailingFetch(original, () =>
      rejection(fetchStreamTransport(request("https://pod.example.com/agent/invoke"))),
    );
    expect(err).toBe(original);
  });
});
