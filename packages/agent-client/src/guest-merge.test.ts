import { describe, expect, it, vi } from "vitest";
import { mergeGuestThreads } from "./guest-merge.js";

const BASE = "https://api.example/v1";
const SECRET = "0123456789abcdef".repeat(4);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function recorder(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("no scripted response");
    return next;
  });
  return { impl, calls };
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe("mergeGuestThreads — the BYO guest merge door", () => {
  it("POSTs to /agents/:appId/merge-guest with the bearer AND the guest header, cookies included, threadIds in the body", async () => {
    const { impl, calls } = recorder([json({ moved: 2, skipped: 0 })]);
    const out = await mergeGuestThreads({
      apiBaseUrl: BASE,
      appId: "app-a",
      getAccessToken: async () => "byo-token",
      getGuestSecret: () => SECRET,
      threadIds: ["t-1"],
      fetchImpl: impl,
    });
    expect(out).toEqual({ supported: true, ok: true, moved: 2, skipped: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/agents/app-a/merge-guest`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.credentials).toBe("include");
    expect(headersOf(calls[0]!.init)).toEqual({
      authorization: "Bearer byo-token",
      "content-type": "application/json",
      "x-guuey-guest": SECRET,
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ threadIds: ["t-1"] });
  });

  it("a cookie-mode guest (no secret on the device) relies on the cookie: no guest header, the secret never in the body", async () => {
    const { impl, calls } = recorder([json({ moved: 1, skipped: 0 })]);
    await mergeGuestThreads({ apiBaseUrl: BASE, appId: "app-a", getAccessToken: async () => "tok", fetchImpl: impl });
    expect(headersOf(calls[0]!.init)["x-guuey-guest"]).toBeUndefined();
    expect(calls[0]!.init.credentials).toBe("include");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({});
  });

  it("follows nextCursor (threadIds only on the first call) and sums the counts", async () => {
    const { impl, calls } = recorder([json({ moved: 100, skipped: 1, nextCursor: "c1" }), json({ moved: 5, skipped: 0 })]);
    const out = await mergeGuestThreads({
      apiBaseUrl: BASE,
      appId: "app-a",
      getAccessToken: async () => "tok",
      getGuestSecret: () => SECRET,
      threadIds: ["t-1"],
      fetchImpl: impl,
    });
    expect(out).toEqual({ supported: true, ok: true, moved: 105, skipped: 1 });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ cursor: "c1" });
  });

  it("404 (a plane without the route) → { supported: false }", async () => {
    const { impl } = recorder([json({ error: { code: "NOT_FOUND", message: "Unknown route" } }, 404)]);
    const out = await mergeGuestThreads({ apiBaseUrl: BASE, appId: "app-a", getAccessToken: async () => "tok", fetchImpl: impl });
    expect(out).toEqual({ supported: false });
  });

  it("a refusal carries its status, code and Retry-After; nothing throws", async () => {
    const { impl } = recorder([json({ error: { code: "RATE_LIMITED", message: "x" } }, 429, { "Retry-After": "120" })]);
    const out = await mergeGuestThreads({ apiBaseUrl: BASE, appId: "app-a", getAccessToken: async () => "tok", fetchImpl: impl });
    expect(out).toEqual({ supported: true, ok: false, status: 429, code: "RATE_LIMITED", retryAfterSeconds: 120 });
  });

  it("no bearer → no call at all", async () => {
    const { impl, calls } = recorder([]);
    const out = await mergeGuestThreads({ apiBaseUrl: BASE, appId: "app-a", getAccessToken: async () => null, fetchImpl: impl });
    expect(out).toEqual({ supported: true, ok: false, status: 0, code: "NO_ACCESS_TOKEN" });
    expect(calls).toHaveLength(0);
  });

  it("a network failure is a result, not a throw", async () => {
    const impl = vi.fn(async (): Promise<Response> => {
      throw new TypeError("Failed to fetch");
    });
    const out = await mergeGuestThreads({ apiBaseUrl: BASE, appId: "app-a", getAccessToken: async () => "tok", fetchImpl: impl });
    expect(out).toEqual({ supported: true, ok: false, status: 0, code: "NETWORK" });
  });
});

describe("mergeGuestThreads — the answer is read, never assumed (guuey#2899)", () => {
  const merge = (responses: Response[]) =>
    mergeGuestThreads({ apiBaseUrl: BASE, appId: "app-a", getAccessToken: async () => "tok", fetchImpl: recorder(responses).impl });

  it("a 2xx whose body is not an object (an array, null, a scalar, not JSON) is BAD_RESPONSE", async () => {
    for (const res of [json([2, 0]), json(null), json(2), new Response("<html>ok</html>", { status: 200 })]) {
      expect(await merge([res])).toEqual({ supported: true, ok: false, status: 200, code: "BAD_RESPONSE" });
    }
  });

  it("a 2xx whose counts are not numbers is BAD_RESPONSE", async () => {
    expect(await merge([json({ moved: "2", skipped: 0 })])).toEqual({
      supported: true,
      ok: false,
      status: 200,
      code: "BAD_RESPONSE",
    });
  });

  it("a cursor that is not a string ends the walk with the counts so far", async () => {
    expect(await merge([json({ moved: 1, skipped: 1, nextCursor: 7 })])).toEqual({
      supported: true,
      ok: true,
      moved: 1,
      skipped: 1,
    });
  });

  it("a refusal whose error is not an object, or whose code is not a string, carries a null code", async () => {
    for (const body of [{ error: "RATE_LIMITED" }, { error: null }, { error: { code: 429 } }, ["RATE_LIMITED"]]) {
      expect(await merge([json(body, 429)])).toEqual({ supported: true, ok: false, status: 429, code: null });
    }
  });
});
