// @vitest-environment jsdom
/**
 * guuey#2549 — a turn without words: `send("", { inputKind: "context-only" })`
 * posts an empty input beside its kind, and the agent's runtime alone judges
 * whether its agent takes it. A runtime that does not refuses it before the
 * stream, storing nothing; the hook reads that refusal as its own code so the
 * reader is told to add words. The session frame's offer is exposed as a hint.
 */
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import { AGENT_ERROR_CODES, CLIENT_ERROR_CODES } from "./error-codes.js";
import { AgentResponseError } from "./errors.js";
import type { AgentInvokeAdapters, InvokeRequest } from "./types.js";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type Step = { session: Record<string, unknown> } | { refuse: AgentResponseError } | { inBand: string };

/** A pod that answers each invoke by the next scripted step. */
function podAdapters(steps: Step[]) {
  const bodies: unknown[] = [];
  let n = 0;
  let call = 0;
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => null, save: () => {} },
    generateId: () => `cmid-${++n}`,
    transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
      bodies.push(req.body);
      const step = steps[call++];
      if (step === undefined) throw new Error("no scripted step");
      if ("refuse" in step) throw step.refuse;
      if ("inBand" in step) {
        yield sse("session", { threadId: "t-1" });
        yield sse("error", { code: step.inBand, message: "This agent no longer accepts a turn without text." });
        yield sse("done", { stopReason: "error" });
        return;
      }
      yield sse("session", step.session);
      yield sse("message", { type: "text.delta", delta: "Nice photo." });
      yield sse("done", { stopReason: "end_turn" });
    },
  };
  return { adapters, bodies };
}

function hook(adapters: AgentInvokeAdapters, appId = "app-ctx") {
  return renderHook((props: { appId: string }) => useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: props.appId, adapters }), {
    initialProps: { appId },
  });
}

const OFFERED = { threadId: "t-1", accepts: { inputKinds: ["context-only"] } };
const OLD_POD_REFUSAL = new AgentResponseError("input: non-empty string required", 400, AGENT_ERROR_CODES.INVALID_REQUEST);
const NEW_POD_REFUSAL = new AgentResponseError(
  "inputKind: context-only is not accepted by this agent yet; send text",
  400,
  AGENT_ERROR_CODES.INVALID_REQUEST,
);

describe("useAgentInvoke — a turn without words (guuey#2549)", () => {
  it("a FIRST turn is sent: an empty input beside its kind, the row drawn with its kind, the offer read from the frame", async () => {
    const { adapters, bodies } = podAdapters([{ session: OFFERED }]);
    const { result, unmount } = hook(adapters);
    expect(result.current.acceptedInputKinds).toBeNull();
    await act(async () => {
      await result.current.send("   ", { inputKind: "context-only" });
    });
    expect(bodies[0]).toEqual({ input: "", clientMessageId: "cmid-1", inputKind: "context-only" });
    expect(result.current.messages[0]).toEqual({
      role: "user",
      text: "",
      clientMessageId: "cmid-1",
      precedingTurnCount: 0,
      inputKind: "context-only",
    });
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "Nice photo." });
    expect(result.current.errorCode).toBeNull();
    expect(result.current.sendStates).toEqual({});
    expect(result.current.acceptedInputKinds).toEqual(["context-only"]);
    unmount();
  });

  it("a runtime that predates input kinds refuses it: INPUT_KIND_NOT_ADVERTISED, the row failed, the runtime's message kept, the offer cleared", async () => {
    const { adapters } = podAdapters([{ session: OFFERED }, { refuse: OLD_POD_REFUSAL }]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    await act(async () => {
      await result.current.send("", { inputKind: "context-only" });
    });
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.INPUT_KIND_NOT_ADVERTISED);
    expect(result.current.error).toBe("input: non-empty string required");
    expect(result.current.sendStates).toEqual({ "cmid-2": "failed" });
    expect(result.current.acceptedInputKinds).toEqual([]);
    unmount();
  });

  it("a runtime whose agent has not declared the kind refuses it the same way", async () => {
    const { adapters } = podAdapters([{ refuse: NEW_POD_REFUSAL }]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("", { inputKind: "context-only" });
    });
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.INPUT_KIND_NOT_ADVERTISED);
    expect(result.current.sendStates).toEqual({ "cmid-1": "failed" });
    expect(result.current.acceptedInputKinds).toEqual([]);
    unmount();
  });

  it("any other 400 on such a turn keeps the runtime's own code and leaves the offer standing", async () => {
    const malformed = new AgentResponseError("pageContext: path must be a string", 400, AGENT_ERROR_CODES.INVALID_REQUEST);
    const { adapters } = podAdapters([{ session: OFFERED }, { refuse: malformed }]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    await act(async () => {
      await result.current.send("", { inputKind: "context-only" });
    });
    expect(result.current.errorCode).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(result.current.acceptedInputKinds).toEqual(["context-only"]);
    unmount();
  });

  it("a refusal message on a turn WITH words is not read as an input-kind refusal", async () => {
    const { adapters } = podAdapters([{ refuse: OLD_POD_REFUSAL }]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello", { inputKind: "context-only" });
    });
    expect(result.current.errorCode).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    unmount();
  });

  it("an admitted turn the agent's worker turns down ends INPUT_KIND_NOT_DECLARED; the row stays sent and keeps its kind", async () => {
    const { adapters } = podAdapters([{ inBand: AGENT_ERROR_CODES.INPUT_KIND_NOT_DECLARED }]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("", { inputKind: "context-only" });
    });
    expect(result.current.errorCode).toBe(AGENT_ERROR_CODES.INPUT_KIND_NOT_DECLARED);
    expect(result.current.sendStates).toEqual({});
    expect(result.current.messages[0]?.inputKind).toBe("context-only");
    unmount();
  });

  it("beside words the kind is ignored: the text is the turn, and nothing is stamped on the row", async () => {
    const { adapters, bodies } = podAdapters([{ session: OFFERED }]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("what is this?", { inputKind: "context-only" });
    });
    expect(bodies[0]).toEqual({ input: "what is this?", clientMessageId: "cmid-1" });
    expect(result.current.messages[0]?.inputKind).toBeUndefined();
    unmount();
  });

  it("a blank send with no kind is still a silent no-op", async () => {
    const { adapters, bodies } = podAdapters([]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("  ");
    });
    expect(bodies).toEqual([]);
    expect(result.current.messages).toEqual([]);
    expect(result.current.errorCode).toBeNull();
    unmount();
  });

  it("each frame replaces the offer (identity kept while unchanged); an app switch forgets it; reset() keeps it", async () => {
    const { adapters } = podAdapters([{ session: OFFERED }, { session: OFFERED }, { session: { threadId: "t-1" } }]);
    const { result, rerender, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("one");
    });
    const first = result.current.acceptedInputKinds;
    await act(async () => {
      await result.current.send("two");
    });
    expect(result.current.acceptedInputKinds).toBe(first);
    act(() => result.current.reset());
    expect(result.current.acceptedInputKinds).toEqual(["context-only"]);
    await act(async () => {
      await result.current.send("three");
    });
    expect(result.current.acceptedInputKinds).toEqual([]);
    rerender({ appId: "app-other" });
    expect(result.current.acceptedInputKinds).toBeNull();
    unmount();
  });
});
