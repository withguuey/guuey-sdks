// @vitest-environment jsdom
/**
 * guuey#2293 — a turn may carry images: `send(input, { attachments })` puts
 * them on the invoke body after the hook judged them, and the turn proceeds
 * only when the pod acknowledges them on its `session` frame. A pod that
 * predates attachments parses them and ignores them, so a silent accept is
 * not an accept: without the acknowledgement the turn ends at once with
 * ATTACHMENTS_UNSUPPORTED instead of an answer that never saw the image.
 */
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import { CLIENT_ERROR_CODES } from "./error-codes.js";
import type { ImageAttachment, ImageAttachmentCandidate } from "./attachments.js";
import type { AgentInvokeAdapters, InvokeRequest } from "./types.js";

const PNG: ImageAttachment = {
  kind: "inline",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
};

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A pod that answers with the given session frame, then a reply and `done`. */
function podAdapters(session: Record<string, unknown>) {
  const bodies: unknown[] = [];
  const signals: AbortSignal[] = [];
  let n = 0;
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => null, save: () => {} },
    generateId: () => `cmid-${++n}`,
    transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
      bodies.push(req.body);
      signals.push(req.signal);
      yield sse("session", session);
      yield sse("message", { type: "text.delta", delta: "Here are your flashcards." });
      yield sse("done", { stopReason: "end_turn" });
    },
  };
  return { adapters, bodies, signals };
}

function hook(adapters: AgentInvokeAdapters) {
  return renderHook(() => useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: "app-img", adapters }));
}

describe("useAgentInvoke — image attachments ride the send (guuey#2293)", () => {
  it("puts the images on the body as the last key, and the acknowledged turn runs as any other", async () => {
    const { adapters, bodies } = podAdapters({ threadId: "t-1", attachments: { accepted: 1 } });
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("make flashcards", { attachments: [PNG] });
    });
    expect(bodies[0]).toEqual({ input: "make flashcards", clientMessageId: "cmid-1", attachments: [PNG] });
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "Here are your flashcards." });
    unmount();
  });

  it("a pod that does not acknowledge the images: the turn ends at the session frame with ATTACHMENTS_UNSUPPORTED, no reply drawn", async () => {
    const { adapters, signals } = podAdapters({ threadId: "t-1" });
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("make flashcards", { attachments: [PNG] });
    });
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.ATTACHMENTS_UNSUPPORTED);
    expect(result.current.error).toMatch(/image/i);
    // The stream was cut, so the pod stops the run; the reply never reached the transcript.
    expect(signals[0]?.aborted).toBe(true);
    expect(result.current.messages.map((m) => m.role)).toEqual(["user"]);
    expect(result.current.status).toBe("ready");
    // Not a user stop, and the message did reach the pod (no failed-send state).
    expect(result.current.aborted).toBe(false);
    expect(result.current.sendStates).toEqual({});
    unmount();
  });

  it("an acknowledgement for fewer images than were sent is no acknowledgement", async () => {
    const { adapters } = podAdapters({ threadId: "t-1", attachments: { accepted: 1 } });
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("compare these", { attachments: [PNG, PNG] });
    });
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.ATTACHMENTS_UNSUPPORTED);
    unmount();
  });

  it("a turn without images never looks for the acknowledgement and sends no attachments key", async () => {
    const { adapters, bodies } = podAdapters({ threadId: "t-1" });
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello", { attachments: [] });
    });
    expect(bodies[0]).toEqual({ input: "hello", clientMessageId: "cmid-1" });
    expect(result.current.errorCode).toBeNull();
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "Here are your flashcards." });
    unmount();
  });

  it("a list the caps refuse is never sent: nothing on the wire, ATTACHMENTS_INVALID with the reason, a host-minted id reads failed", async () => {
    const { adapters, bodies } = podAdapters({ threadId: "t-1", attachments: { accepted: 5 } });
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("too many", { clientMessageId: "host-1", attachments: [PNG, PNG, PNG, PNG, PNG] });
    });
    expect(bodies).toEqual([]);
    expect(result.current.messages).toEqual([]);
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.ATTACHMENTS_INVALID);
    expect(result.current.error).toMatch(/at most 4/);
    expect(result.current.sendStates).toEqual({ "host-1": "failed" });
    expect(result.current.status).toBe("ready");
    unmount();
  });

  it("a type off the allowlist is refused the same way (a JS caller is not held by the type)", async () => {
    const { adapters, bodies } = podAdapters({ threadId: "t-1" });
    const { result, unmount } = hook(adapters);
    const audio: ImageAttachmentCandidate = { kind: "inline", mimeType: "audio/webm", data: "AAAA" };
    await act(async () => {
      await result.current.send("listen", { attachments: [audio] });
    });
    expect(bodies).toEqual([]);
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.ATTACHMENTS_INVALID);
    expect(result.current.error).toMatch(/audio\/webm/);
    unmount();
  });
});
