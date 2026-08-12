// @vitest-environment jsdom
/**
 * `errorCode` (scaling S1-F5, guuey#162): the pod's structured wire code
 * beside the human `error` message, so a surface can branch on WHY a turn
 * failed — a saturated pod, a spent quota, guest access turned off — instead
 * of pattern-matching prose.
 *
 * The pod refuses on two channels and this pins BOTH: a pre-stream refusal
 * (thrown by the transport as `AgentResponseError`) and an in-band
 * `event: error` frame. They share one vocabulary, so they share one field.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import { AgentResponseError } from "./errors.js";
import type { AgentInvokeAdapters, InvokeRequest, InvokeTransport } from "./types.js";

const APP_ID = "app-error-code";
const ENDPOINT = "https://pod.example.com";

const frame = (event: string, data: object) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A transport that yields the given frames and ends cleanly. */
const streaming =
  (...frames: string[]): InvokeTransport =>
  async function* (_req: InvokeRequest): AsyncGenerator<string> {
    for (const f of frames) yield f;
  };

/** A transport that fails before yielding — the pre-stream refusal shape. */
const throwing =
  (err: unknown): InvokeTransport =>
  // eslint-disable-next-line require-yield -- a refusal happens before the first chunk
  async function* (_req: InvokeRequest): AsyncGenerator<string> {
    throw err;
  };

/** Mount the hook over a transport the test can swap between sends. */
function mountWith(initial: InvokeTransport) {
  let transport = initial;
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => null, save: () => {} },
    generateId: () => "cmid-error-code",
    transport: (req) => transport(req),
  };
  const hook = renderHook(() =>
    useAgentInvoke({ endpointUrl: ENDPOINT, appId: APP_ID, adapters }),
  );
  return {
    ...hook,
    swap: (next: InvokeTransport) => {
      transport = next;
    },
    send: async (input = "hi") => {
      await act(async () => {
        await hook.result.current.send(input);
      });
    },
  };
}

describe("useAgentInvoke errorCode", () => {
  it("is null before anything has failed", () => {
    const { result } = mountWith(streaming(frame("done", {})));
    expect(result.current.errorCode).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("carries the code of a pre-stream refusal thrown by the transport", async () => {
    const { result, send } = mountWith(
      throwing(new AgentResponseError("you've reached your plan limit", 429, "QUOTA_EXCEEDED")),
    );
    await send();
    expect(result.current.error).toBe("you've reached your plan limit");
    expect(result.current.errorCode).toBe("QUOTA_EXCEEDED");
    // The failure is terminal for the turn, not a status of its own.
    expect(result.current.status).toBe("ready");
  });

  it("carries the code of an in-band `event: error` frame", async () => {
    const { result, send } = mountWith(
      streaming(
        frame("session", { threadId: "t1" }),
        frame("error", { code: "PLATFORM_ERROR", message: "the model provider is unavailable" }),
      ),
    );
    await send();
    expect(result.current.error).toBe("the model provider is unavailable");
    expect(result.current.errorCode).toBe("PLATFORM_ERROR");
  });

  it("stays null for a failure that carries no code", async () => {
    const { result, send } = mountWith(throwing(new Error("network down")));
    await send();
    expect(result.current.error).toBe("network down");
    expect(result.current.errorCode).toBeNull();
  });

  it("stays null for an error frame with no `code` field", async () => {
    const { result, send } = mountWith(streaming(frame("error", { message: "agent blew up" })));
    await send();
    expect(result.current.error).toBe("agent blew up");
    expect(result.current.errorCode).toBeNull();
  });

  it("clears on the next send, so a stale code never outlives its message", async () => {
    const { result, send, swap } = mountWith(
      throwing(new AgentResponseError("at capacity", 503, "POD_SATURATED")),
    );
    await send();
    expect(result.current.errorCode).toBe("POD_SATURATED");

    swap(streaming(frame("session", { threadId: "t1" }), frame("done", {})));
    await send("again");
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
  });

  it("clears on reset()", async () => {
    const { result, send } = mountWith(
      throwing(new AgentResponseError("guest access is off", 403, "GUEST_ACCESS_DISABLED")),
    );
    await send();
    expect(result.current.errorCode).toBe("GUEST_ACCESS_DISABLED");
    act(() => {
      result.current.reset();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
  });
});
