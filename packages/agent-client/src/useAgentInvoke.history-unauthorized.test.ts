// @vitest-environment jsdom
/**
 * guuey#413 — the fail-LOUD carve-out from history's best-effort rule: an
 * UNAUTHORIZED read on a RESUMED threadId surfaces an error item (a
 * transcript the user expects exists and cannot be shown), never the
 * silent fresh-looking boot that hid the identity-drift outage. Every
 * other failure keeps the swallow.
 */
import { describe, it, expect } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import { HistoryUnauthorizedError } from "./history.js";
import { CLIENT_ERROR_CODES } from "./error-codes.js";
import type { AgentInvokeAdapters, InvokeRequest } from "./types.js";

const APP_ID = "app-413";
const THREAD_KEY = `guuey:thread:${APP_ID}`;

function adaptersWith(store: Record<string, string>, load: () => Promise<never>): AgentInvokeAdapters {
  return {
    storage: {
      load: (k) => (k in store ? store[k] : null),
      save: (k, v) => {
        store[k] = v;
      },
    },
    generateId: () => "cmid-413",
    transport: async function* (_req: InvokeRequest): AsyncGenerator<string> {
      yield "event: done\ndata: {}\n\n";
    },
    history: { load },
  };
}

describe("useAgentInvoke — unauthorized history on a resumed thread (guuey#413)", () => {
  it("surfaces THREAD_HISTORY_UNAVAILABLE loudly instead of a fresh-looking boot", async () => {
    const store = { [THREAD_KEY]: "t-old" };
    const adapters = adaptersWith(store, async () => {
      throw new HistoryUnauthorizedError();
    });
    const { result } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example/agent/invoke", appId: APP_ID, adapters }),
    );
    await waitFor(() =>
      expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.THREAD_HISTORY_UNAVAILABLE),
    );
    expect(result.current.error).toContain("started a new one");
    // The guard's FUNCTIONAL half: pointer cleared, fresh session ready.
    expect(result.current.threadId).toBeNull();
    expect(store[THREAD_KEY]).toBe("");
    // The surface stays LIVE — sends are not blocked by the loud error.
    expect(result.current.status).toBe("ready");
  });

  it("a transient failure keeps the best-effort swallow — no error, chat continues", async () => {
    const store = { [THREAD_KEY]: "t-old" };
    const adapters = adaptersWith(store, async () => {
      throw new Error("network down");
    });
    const { result } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example/agent/invoke", appId: APP_ID, adapters }),
    );
    // Give the un-awaited hydration continuation a beat.
    await waitFor(() => expect(result.current.threadId).toBe("t-old"));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
  });
});


/** Adapters whose history answers one `gone` result for the stored thread. */
function goneAdapters(store: Record<string, string>, gone: { gone: true; status?: 403 | 404 }): AgentInvokeAdapters {
  return {
    storage: {
      load: (k) => (k in store ? store[k] : null),
      save: (k, v) => {
        store[k] = v;
      },
    },
    generateId: () => "cmid-413g",
    transport: async function* (_req: InvokeRequest): AsyncGenerator<string> {
      yield "event: done\ndata: {}\n\n";
    },
    history: { load: async () => gone },
  };
}

describe("useAgentInvoke — the gone arm is loud on a refusal (guuey#413 guard)", () => {
  it.each([
    ["403", { gone: true, status: 403 } as const],
    ["a gone without a status (a loader that predates it)", { gone: true } as const],
  ])("%s: clears + mints fresh AND surfaces the notice — never silent (mutant: silence every gone)", async (_label, gone) => {
    const store: Record<string, string> = { [THREAD_KEY]: "t-drifted" };
    const adapters = goneAdapters(store, gone);
    const { result } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example/agent/invoke", appId: APP_ID, adapters }),
    );
    await waitFor(() =>
      expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.THREAD_HISTORY_UNAVAILABLE),
    );
    expect(result.current.error).toContain("started a new one");
    expect(result.current.threadId).toBeNull();
    expect(store[THREAD_KEY]).toBe("");
  });
});

describe("useAgentInvoke — a thread that no longer exists (404) starts fresh with no notice (#3864)", () => {
  it("404: clears + mints fresh, and NO error item (mutant: keep the notice on 404)", async () => {
    const store: Record<string, string> = { [THREAD_KEY]: "t-expired" };
    const adapters = goneAdapters(store, { gone: true, status: 404 });
    const { result } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example/agent/invoke", appId: APP_ID, adapters }),
    );
    // The functional half still runs: the pointer is cleared and a fresh session is ready.
    await waitFor(() => expect(store[THREAD_KEY]).toBe(""));
    expect(result.current.threadId).toBeNull();
    // Give the un-awaited hydration continuation a beat: no notice ever arrives.
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
    expect(result.current.status).toBe("ready");
  });
});

describe("useAgentInvoke — a late gone never clobbers the thread a send just set (the mid-flight guard)", () => {
  it("a 404 that arrives after a send set a fresh thread leaves that thread and its storage alone (mutant: drop the guard)", async () => {
    const store: Record<string, string> = { [THREAD_KEY]: "t-expired" };
    let answer!: (r: { gone: true; status: 404 }) => void;
    let asked!: () => void;
    const loadAsked = new Promise<void>((r) => {
      asked = r;
    });
    const adapters: AgentInvokeAdapters = {
      storage: {
        load: (k) => (k in store ? store[k] : null),
        save: (k, v) => {
          store[k] = v;
        },
      },
      generateId: () => "cmid-guard",
      transport: async function* (_req: InvokeRequest): AsyncGenerator<string> {
        yield 'event: session\ndata: {"threadId":"t-fresh"}\n\n';
        yield "event: done\ndata: {}\n\n";
      },
      history: {
        load: () => {
          asked();
          return new Promise((r) => {
            answer = r;
          });
        },
      },
    };
    const { result } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example/agent/invoke", appId: APP_ID, adapters }),
    );
    await loadAsked; // the history read of the stored thread is in flight
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.threadId).toBe("t-fresh");
    expect(store[THREAD_KEY]).toBe("t-fresh");
    await act(async () => {
      answer({ gone: true, status: 404 });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.threadId).toBe("t-fresh");
    expect(store[THREAD_KEY]).toBe("t-fresh");
    expect(result.current.errorCode).toBeNull();
  });
});
