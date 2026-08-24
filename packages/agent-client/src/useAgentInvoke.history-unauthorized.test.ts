// @vitest-environment jsdom
/**
 * guuey#413 — the fail-LOUD carve-out from history's best-effort rule: an
 * UNAUTHORIZED read on a RESUMED threadId surfaces an error item (a
 * transcript the user expects exists and cannot be shown), never the
 * silent fresh-looking boot that hid the identity-drift outage. Every
 * other failure keeps the swallow.
 */
import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
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


describe("useAgentInvoke — the gone arm is loud too (guuey#413 guard)", () => {
  it("a 403/404 gone resume clears + mints fresh AND surfaces the notice — never silent", async () => {
    const store: Record<string, string> = { [THREAD_KEY]: "t-drifted" };
    const adapters: AgentInvokeAdapters = {
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
      history: { load: async () => ({ gone: true }) },
    };
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
