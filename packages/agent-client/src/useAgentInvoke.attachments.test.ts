// @vitest-environment jsdom
/**
 * A turn may carry parts: `send(input, { parts })` puts them on the invoke body after the hook judged them, and the
 * turn proceeds only when the pod acknowledges them on its `session` frame. A pod that predates a kind parses it and
 * ignores it, so a silent accept is not an accept: without the acknowledgement the turn ends at once with
 * PARTS_UNSUPPORTED instead of an answer that never saw the part. In request shape 2 the acknowledgement is per kind
 * (`accepts.parts`); in shape 1 it is today's image count (`accepts.attachments`).
 */
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import { AGENT_ERROR_CODES, CLIENT_ERROR_CODES } from "./error-codes.js";
import { AgentResponseError } from "./errors.js";
import type { UserPartCandidate } from "./user-parts.js";
import type { AgentInvokeAdapters, InvokeRequest } from "./types.js";

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PNG: UserPartCandidate = { type: "image", source: { type: "base64", mediaType: "image/png", data: PNG_DATA } };

/** What an older runtime answers a shape-2 body: it finds no `input` string. */
const SHAPE1_ONLY_REFUSAL = new AgentResponseError("input: non-empty string required", 400, AGENT_ERROR_CODES.INVALID_REQUEST);

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Whether a body is shape 1 (it carries the `input` string). */
function isShape1(body: unknown): boolean {
  return typeof body === "object" && body !== null && typeof Reflect.get(body, "input") === "string";
}

/**
 * A pod that answers with the given session frame, then a reply and `done`. `shape1Only` makes it an older runtime
 * that refuses every shape-2 body before the stream.
 */
function podAdapters(session: Record<string, unknown>, opts: { shape1Only?: boolean } = {}) {
  const bodies: unknown[] = [];
  const signals: AbortSignal[] = [];
  let n = 0;
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => null, save: () => {} },
    generateId: () => `cmid-${++n}`,
    transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
      bodies.push(req.body);
      signals.push(req.signal);
      if (opts.shape1Only === true && !isShape1(req.body)) throw SHAPE1_ONLY_REFUSAL;
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

describe("useAgentInvoke — parts ride the send (request shape 2)", () => {
  it("puts the parts after the words in the one message, and the acknowledged turn runs as any other", async () => {
    const { adapters, bodies } = podAdapters({ threadId: "t-1", accepts: { parts: { image: 1 } } });
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("make flashcards", { parts: [PNG] });
    });
    expect(bodies[0]).toMatchObject({
      messages: [{ id: "cmid-1", content: [{ type: "text", text: "make flashcards" }, PNG] }],
    });
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "Here are your flashcards." });
    unmount();
  });

  it("a pod that does not acknowledge the parts: the turn ends at the session frame with PARTS_UNSUPPORTED, no reply drawn", async () => {
    const { adapters, signals } = podAdapters({ threadId: "t-1" });
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("make flashcards", { parts: [PNG] });
    });
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.PARTS_UNSUPPORTED);
    // The stream was cut, so the pod stops the run; the reply never reached the transcript.
    expect(signals[0]?.aborted).toBe(true);
    expect(result.current.messages.map((m) => m.role)).toEqual(["user"]);
    expect(result.current.status).toBe("ready");
    // Not a user stop, and the message did reach the pod (no failed-send state).
    expect(result.current.aborted).toBe(false);
    expect(result.current.sendStates).toEqual({});
    unmount();
  });

  it("an acknowledgement for fewer parts of a kind than were sent is no acknowledgement", async () => {
    const { adapters } = podAdapters({ threadId: "t-1", accepts: { parts: { image: 1 } } });
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("compare these", { parts: [PNG, PNG] });
    });
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.PARTS_UNSUPPORTED);
    unmount();
  });

  it("shape 2 never reads the shape-1 image count as an acknowledgement", async () => {
    const { adapters } = podAdapters({ threadId: "t-1", accepts: { attachments: 1 } });
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("make flashcards", { parts: [PNG] });
    });
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.PARTS_UNSUPPORTED);
    unmount();
  });

  it("a turn without parts never looks for the acknowledgement and carries only its words", async () => {
    const { adapters, bodies } = podAdapters({ threadId: "t-1" });
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello", { parts: [] });
    });
    expect(bodies[0]).toMatchObject({ messages: [{ content: [{ type: "text", text: "hello" }] }] });
    expect(result.current.errorCode).toBeNull();
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "Here are your flashcards." });
    unmount();
  });

  it("a list the caps refuse is never sent: nothing on the wire, PARTS_INVALID with the reason, a host-minted id reads failed", async () => {
    const { adapters, bodies } = podAdapters({ threadId: "t-1", accepts: { parts: { image: 5 } } });
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("too many", { clientMessageId: "host-1", parts: [PNG, PNG, PNG, PNG, PNG] });
    });
    expect(bodies).toEqual([]);
    expect(result.current.messages).toEqual([]);
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.PARTS_INVALID);
    expect(result.current.error).toMatch(/at most 4/);
    expect(result.current.sendStates).toEqual({ "host-1": "failed" });
    expect(result.current.status).toBe("ready");
    unmount();
  });
});

describe("useAgentInvoke — parts on a runtime that parses shape 1 only", () => {
  it("images fall back to shape 1's attachments, and the image count is the acknowledgement", async () => {
    const { adapters, bodies } = podAdapters({ threadId: "t-1", accepts: { attachments: 1 } }, { shape1Only: true });
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("make flashcards", { parts: [PNG] });
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({
      input: "make flashcards",
      clientMessageId: "cmid-1",
      attachments: [{ kind: "inline", mimeType: "image/png", data: PNG_DATA }],
    });
    expect(result.current.errorCode).toBeNull();
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "Here are your flashcards." });
    unmount();
  });

  it("a shape-1 runtime that does not acknowledge the images ends the turn with PARTS_UNSUPPORTED", async () => {
    const { adapters } = podAdapters({ threadId: "t-1" }, { shape1Only: true });
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("make flashcards", { parts: [PNG] });
    });
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.PARTS_UNSUPPORTED);
    expect(result.current.error).toMatch(/image/i);
    unmount();
  });

  it("once the hook writes shape 1, an image shape 1 cannot name is refused before the send with PARTS_INVALID", async () => {
    const { adapters, bodies } = podAdapters({ threadId: "t-1" }, { shape1Only: true });
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    expect(bodies).toHaveLength(2);
    const heic: UserPartCandidate = { type: "image", source: { type: "base64", mediaType: "image/heic", data: "AAAA" } };
    await act(async () => {
      await result.current.send("look", { parts: [heic] });
    });
    expect(bodies).toHaveLength(2);
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.PARTS_INVALID);
    expect(result.current.error).toMatch(/JPEG/);
    unmount();
  });
});
