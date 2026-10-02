// @vitest-environment jsdom
/**
 * guuey#186 Gap 2 (error-site half), reworded by guuey#1976: a network-level
 * `TypeError` on a cross-origin invoke from a browser says nothing more than
 * "Failed to fetch". A CORS refusal (the app's `allowedDomains` missing the
 * embedding origin) and a host that is not serving yet (a fresh deploy's
 * address, minutes after it reads live) throw the SAME error. The transport
 * adds a HINT at the error site that names both and diagnoses neither, and a
 * surface whose origin the agent always admits can drop the allowedDomains
 * clause it can never need. These tests pin that the hint fires ONLY where
 * such a failure is possible (browser + cross-origin) and preserves the
 * original error.
 *
 * jsdom gives this file a real `location` (http://localhost:3000); the
 * node-environment suite in `transport.test.ts` pins the no-`location` case.
 */
import { describe, it, expect, vi } from "vitest";
import { fetchStreamTransport } from "./transport.js";
import { createWebAdapters } from "./web-adapters.js";
import type { InvokeRequest } from "./types.js";

const POD = "https://pod.example.com/agent/invoke";
const NOT_SERVING_YET = "A new deploy can take a few minutes to start serving";

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

/** The rejection as a `TypeError`, failing the test when it is anything else. */
function asTypeError(err: unknown): TypeError {
  if (!(err instanceof TypeError)) throw new Error(`expected a TypeError, got ${String(err)}`);
  return err;
}

describe("fetchStreamTransport — cross-origin TypeError hint", () => {
  it("names both causes by default, preserving the original as cause", async () => {
    const original = new TypeError("Failed to fetch");
    const err = asTypeError(
      await withFailingFetch(original, () => rejection(fetchStreamTransport(request(POD)))),
    );
    expect(err.message).toBe(
      "Failed to fetch — couldn't reach the agent. A new deploy can take a few minutes to start serving; " +
        "for a browser embed, also check that this page's origin is in the app's allowedDomains.",
    );
    expect(err.cause).toBe(original);
  });

  it("never reads as a CORS diagnosis: the not-yet-serving cause leads, allowedDomains is an 'also'", async () => {
    // guuey#1976: a fresh deploy's address failed for minutes after it read
    // live, and the old hint pointed only at allowedDomains — the builder
    // went after a setting that was already right.
    const err = asTypeError(
      await withFailingFetch(new TypeError("Failed to fetch"), () =>
        rejection(fetchStreamTransport(request(POD))),
      ),
    );
    expect(err.message).toContain(NOT_SERVING_YET);
    expect(err.message.indexOf(NOT_SERVING_YET)).toBeLessThan(err.message.indexOf("allowedDomains"));
  });

  it("drops the allowedDomains clause when allowedDomainsHint is false, keeping the rest", async () => {
    const original = new TypeError("Failed to fetch");
    const err = asTypeError(
      await withFailingFetch(original, () =>
        rejection(fetchStreamTransport(request(POD), null, null, { allowedDomainsHint: false })),
      ),
    );
    expect(err.message).toBe(
      "Failed to fetch — couldn't reach the agent. A new deploy can take a few minutes to start serving.",
    );
    expect(err.cause).toBe(original);
  });

  it("createWebAdapters forwards allowedDomainsHint to its transport", async () => {
    const adapters = createWebAdapters({ allowedDomainsHint: false });
    const err = asTypeError(
      await withFailingFetch(new TypeError("Failed to fetch"), () =>
        rejection(adapters.transport(request(POD))),
      ),
    );
    expect(err.message).toContain(NOT_SERVING_YET);
    expect(err.message).not.toContain("allowedDomains");
  });

  it("createWebAdapters keeps the allowedDomains clause when the option is omitted", async () => {
    const adapters = createWebAdapters();
    const err = asTypeError(
      await withFailingFetch(new TypeError("Failed to fetch"), () =>
        rejection(adapters.transport(request(POD))),
      ),
    );
    expect(err.message).toContain(NOT_SERVING_YET);
    expect(err.message).toContain("allowedDomains");
  });

  it("leaves a same-origin TypeError untouched — the page's own host is answering", async () => {
    const original = new TypeError("Failed to fetch");
    const err = await withFailingFetch(original, () =>
      rejection(fetchStreamTransport(request(`${location.origin}/agent/invoke`))),
    );
    expect(err).toBe(original);
  });

  it("leaves a non-TypeError failure untouched", async () => {
    const original = new Error("boom");
    const err = await withFailingFetch(original, () =>
      rejection(fetchStreamTransport(request(POD))),
    );
    expect(err).toBe(original);
  });
});
