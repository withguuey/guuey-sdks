import { describe, it, expect, vi } from "vitest";
import { dismissLinkPrompt } from "./link-prompt";

function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("dismissLinkPrompt", () => {
  it("resolves on 204", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      dismissLinkPrompt("https://api.example.com/v1", "tok_abc", fetchImpl),
    ).resolves.toBeUndefined();
  });

  it("POSTs the Task 4 route with the bearer header, no body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await dismissLinkPrompt("https://api.example.com/v1", "tok_abc", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.example.com/v1/link-prompt/dismiss");
    expect(init).toEqual({
      method: "POST",
      headers: { Authorization: "Bearer tok_abc" },
    });
  });

  it.each([401, 403, 500])("throws on a %d response", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(response(status, { code: "X", message: "nope" }));
    await expect(
      dismissLinkPrompt("https://api.example.com/v1", "tok_abc", fetchImpl),
    ).rejects.toThrow(new RegExp(`link prompt dismiss failed: ${status}`));
  });

  it("defaults fetchImpl to the global fetch when omitted", async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = mockFetch as typeof fetch;
    try {
      await dismissLinkPrompt("https://api.example.com/v1", "tok_abc");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
