// @vitest-environment jsdom
/**
 * guuey#207 — the client→pod AgJSON HITL answer channel and the capability
 * advertisement that gates the pod's grant-mode ask.
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { AgHitlAnswer } from "@silverprotocol/core";
import { createHitlAnswerRelay } from "./web-adapters.js";
import { GUEST_HEADER } from "./transport.js";
import { DEFAULT_BLOCK_PRESERVING_CAPABILITIES, useAgentInvoke } from "./useAgentInvoke.js";
import type { AgentInvokeAdapters, InvokeRequest } from "./types.js";

const ANSWER: AgHitlAnswer = { askId: "profile-consent:app_1:t1", status: "resolved", grantModeId: "once" };

function mkFetch(status: number, body?: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  })) as unknown as typeof fetch;
}
function calls(f: typeof fetch): unknown[][] {
  return (f as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

describe("createHitlAnswerRelay", () => {
  it("POSTs the spec AgHitlAnswer verbatim to <pod>/agent/hitl-answer (pod base OR full invoke URL) and returns the door's body", async () => {
    for (const endpointUrl of ["https://pod.example", "https://pod.example/agent/invoke"]) {
      const fetchImpl = mkFetch(200, { askId: ANSWER.askId, status: "resolved", mode: "once" });
      const relay = createHitlAnswerRelay({ endpointUrl, getAccessToken: async () => "tok", fetchImpl });
      const out = await relay(ANSWER);
      expect(out).toEqual({ ok: true, body: { askId: ANSWER.askId, status: "resolved", mode: "once" } });
      const call = calls(fetchImpl)[0]!;
      expect(String(call[0])).toBe("https://pod.example/agent/hitl-answer");
      const init = call[1] as { method: string; headers: Record<string, string>; body: string; credentials?: string };
      expect(init.method).toBe("POST");
      expect(init.headers["content-type"]).toBe("application/json");
      expect(init.headers["authorization"]).toBe("Bearer tok");
      expect(init.credentials).toBeUndefined();
      expect(JSON.parse(init.body)).toEqual(ANSWER); // verbatim — the pod validates
    }
  });

  it("carries exactly ONE identity: bearer wins, else the guest header, else cookie credentials", async () => {
    const bearer = mkFetch(200, {});
    await createHitlAnswerRelay({ endpointUrl: "https://pod.example", getAccessToken: async () => "tok", guestSecret: "a".repeat(64), fetchImpl: bearer })(ANSWER);
    const bInit = calls(bearer)[0]![1] as { headers: Record<string, string>; credentials?: string };
    expect(bInit.headers["authorization"]).toBe("Bearer tok");
    expect(bInit.headers[GUEST_HEADER]).toBeUndefined();
    expect(bInit.credentials).toBeUndefined();

    const guest = mkFetch(200, {});
    await createHitlAnswerRelay({ endpointUrl: "https://pod.example", guestSecret: "a".repeat(64), fetchImpl: guest })(ANSWER);
    const gInit = calls(guest)[0]![1] as { headers: Record<string, string>; credentials?: string };
    expect(gInit.headers[GUEST_HEADER]).toBe("a".repeat(64));
    expect(gInit.headers["authorization"]).toBeUndefined();
    expect(gInit.credentials).toBeUndefined();

    const cookie = mkFetch(200, {});
    await createHitlAnswerRelay({ endpointUrl: "https://pod.example", fetchImpl: cookie })(ANSWER);
    const cInit = calls(cookie)[0]![1] as { headers: Record<string, string>; credentials?: string };
    expect(cInit.credentials).toBe("include");
    expect(cInit.headers["authorization"]).toBeUndefined();
  });

  it("a 2xx with a body the door did not fill still echoes the answer's own askId/status", async () => {
    const out = await createHitlAnswerRelay({ endpointUrl: "https://pod.example", fetchImpl: mkFetch(200) })(ANSWER);
    expect(out).toEqual({ ok: true, body: { askId: ANSWER.askId, status: "resolved" } });
  });

  it("every non-2xx surfaces the pod's {code, message} envelope with the HTTP status — never a throw", async () => {
    const out = await createHitlAnswerRelay({
      endpointUrl: "https://pod.example",
      fetchImpl: mkFetch(404, { code: "NOT_FOUND", message: "No such consent ask" }),
    })(ANSWER);
    expect(out).toEqual({ ok: false, status: 404, code: "NOT_FOUND", message: "No such consent ask" });
    const bare = await createHitlAnswerRelay({ endpointUrl: "https://pod.example", fetchImpl: mkFetch(500) })(ANSWER);
    expect(bare).toEqual({ ok: false, status: 500, code: null, message: "hitl-answer failed (500)" });
  });

  it("retries ONCE with a force-refreshed bearer on 401 (the card relays' recovery), then reports the final answer", async () => {
    let calls401 = 0;
    const fetchImpl = vi.fn(async () => {
      calls401++;
      return calls401 === 1
        ? { ok: false, status: 401, json: async () => ({ code: "UNAUTHORIZED", message: "expired" }) }
        : { ok: true, status: 200, json: async () => ({ askId: ANSWER.askId, status: "resolved", mode: "once" }) };
    }) as unknown as typeof fetch;
    const getAccessToken = vi.fn(async (o?: { forceRefresh?: boolean }) => (o?.forceRefresh ? "fresh" : "stale"));
    const out = await createHitlAnswerRelay({ endpointUrl: "https://pod.example", getAccessToken, fetchImpl })(ANSWER);
    expect(out).toMatchObject({ ok: true, body: { mode: "once" } });
    expect(calls(fetchImpl)).toHaveLength(2);
    const retry = calls(fetchImpl)[1]![1] as { headers: Record<string, string> };
    expect(retry.headers["authorization"]).toBe("Bearer fresh");
  });

  it("a transport failure is `status: 0`, never a rejection", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const out = await createHitlAnswerRelay({ endpointUrl: "https://pod.example", fetchImpl })(ANSWER);
    expect(out).toEqual({ ok: false, status: 0, code: null, message: "offline" });
  });
});

describe("useAgentInvoke — AgJSON client capabilities on the invoke body (guuey#207)", () => {
  function makeAdapters(sentBodies: unknown[]): AgentInvokeAdapters {
    const store: Record<string, string> = {};
    return {
      storage: { load: (k) => store[k] ?? null, save: (k, v) => void (store[k] = v) },
      generateId: () => "cmid-caps",
      transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
        sentBodies.push(req.body);
        yield "event: done\ndata: {}\n\n";
      },
    };
  }

  it("a block-preserving consumer advertises hitl grant modes by default; a text-only one advertises nothing", async () => {
    const withBlocks: unknown[] = [];
    const a = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example", appId: "caps", adapters: makeAdapters(withBlocks), preserveBlocks: true }),
    );
    await act(async () => {
      await a.result.current.send("hi");
    });
    expect(withBlocks[0]).toMatchObject({ input: "hi", capabilities: DEFAULT_BLOCK_PRESERVING_CAPABILITIES });
    expect(DEFAULT_BLOCK_PRESERVING_CAPABILITIES).toEqual({ hitl: { ask: true, grantModes: true } });
    a.unmount();

    const textOnly: unknown[] = [];
    const b = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example", appId: "caps2", adapters: makeAdapters(textOnly) }),
    );
    await act(async () => {
      await b.result.current.send("hi");
    });
    expect(textOnly[0]).not.toHaveProperty("capabilities");
    b.unmount();
  });

  it("an explicit `capabilities` option wins over the default either way", async () => {
    const sent: unknown[] = [];
    const explicit = { hitl: { ask: true }, streaming: { partialMessages: true } };
    const h = renderHook(() =>
      useAgentInvoke({
        endpointUrl: "https://pod.example",
        appId: "caps3",
        adapters: makeAdapters(sent),
        preserveBlocks: true,
        capabilities: explicit,
      }),
    );
    await act(async () => {
      await h.result.current.send("hi");
    });
    expect(sent[0]).toMatchObject({ capabilities: explicit });
    h.unmount();
  });
});
