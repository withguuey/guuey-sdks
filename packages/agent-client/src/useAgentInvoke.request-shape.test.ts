// @vitest-environment jsdom
/**
 * The request shape. Every hook instance writes shape 2 (the `AgInput` body) from its first turn; the runtime's
 * `accepts.requestShape` is information only. W1: a turn sent as shape 2 that an older runtime refuses before the
 * stream (400 INVALID_REQUEST, "input: …") goes once more as shape 1 under the same clientMessageId, and the instance
 * writes shape 1 for every new turn from then on, in memory only. W2: a turn's shape is fixed at its first send, so a
 * Retry goes in its own shape; only the W1 fallback moves a turn, to shape 1.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import { AGENT_ERROR_CODES, CLIENT_ERROR_CODES } from "./error-codes.js";
import { AgentResponseError, agentResponseErrorFrom } from "./errors.js";
import type { UserPartCandidate } from "./user-parts.js";
import type { AgentInvokeAdapters, InvokeRequest } from "./types.js";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const OLD_RUNTIME = new AgentResponseError("input: non-empty string required", 400, AGENT_ERROR_CODES.INVALID_REQUEST);
const OTHER_400 = new AgentResponseError("pageContext: path must be a string", 400, AGENT_ERROR_CODES.INVALID_REQUEST);
const SATURATED = new AgentResponseError("agent is at capacity", 503, AGENT_ERROR_CODES.POD_SATURATED);

const AUDIO: UserPartCandidate = { type: "audio", source: { type: "base64", mediaType: "audio/wav", data: "UklGRg==" } };
const PNG: UserPartCandidate = { type: "image", source: { type: "base64", mediaType: "image/png", data: "iVBORw0KGgo=" } };

type Step = { session: { [key: string]: unknown } } | { refuse: AgentResponseError };
const ANSWER: Step = { session: { threadId: "t-1" } };

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
      yield sse("session", step.session);
      yield sse("message", { type: "text.delta", delta: "Hi." });
      yield sse("done", { stopReason: "end_turn" });
    },
  };
  return { adapters, bodies };
}

function hook(adapters: AgentInvokeAdapters, appId = "app-shape") {
  return renderHook((props: { appId: string }) => useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: props.appId, adapters }), {
    initialProps: { appId },
  });
}

/** The shape a body went in: 1 carries the `input` string, 2 is an `AgInput` start arm. */
function shapeOf(body: unknown): 1 | 2 | "unknown" {
  if (typeof body !== "object" || body === null) return "unknown";
  if (typeof Reflect.get(body, "input") === "string") return 1;
  return Reflect.get(body, "protocol") === "agjson" && Reflect.get(body, "kind") === "start" ? 2 : "unknown";
}

/** The turn id a body carries, in either shape. */
function turnIdOf(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  return shapeOf(body) === 1 ? Reflect.get(body, "clientMessageId") : Reflect.get(body, "turnId");
}

describe("useAgentInvoke — shape 2 first", () => {
  it("the very first turn of a new hook instance is shape 2, with no advertisement seen", async () => {
    const { adapters, bodies } = podAdapters([ANSWER]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    expect(shapeOf(bodies[0])).toBe(2);
    expect(turnIdOf(bodies[0])).toBe("cmid-1");
    expect(result.current.errorCode).toBeNull();
    unmount();
  });

  it("a session frame without requestShape is information only: the next turn is still shape 2", async () => {
    const { adapters, bodies } = podAdapters([ANSWER, ANSWER]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("one");
    });
    await act(async () => {
      await result.current.send("two");
    });
    expect(bodies.map(shapeOf)).toEqual([2, 2]);
    unmount();
  });
});

describe("useAgentInvoke — W1, the one fallback", () => {
  it("a shape-2 send refused as unparseable goes ONCE as shape 1 under the same id, and the NEXT turn is shape 1", async () => {
    const { adapters, bodies } = podAdapters([{ refuse: OLD_RUNTIME }, ANSWER, ANSWER]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    expect(bodies.map(shapeOf)).toEqual([2, 1]);
    expect(bodies.map(turnIdOf)).toEqual(["cmid-1", "cmid-1"]);
    expect(bodies[1]).toEqual({ input: "hello", clientMessageId: "cmid-1" });
    expect(result.current.errorCode).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.sendStates).toEqual({});
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "Hi." });

    await act(async () => {
      await result.current.send("again");
    });
    expect(bodies.map(shapeOf)).toEqual([2, 1, 1]);
    expect(bodies[2]).toEqual({ input: "again", threadId: "t-1", clientMessageId: "cmid-2" });
    unmount();
  });

  it("never more than once per turn: a shape-1 re-send refused the same way is the turn's failure", async () => {
    const { adapters, bodies } = podAdapters([{ refuse: OLD_RUNTIME }, { refuse: OLD_RUNTIME }]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    expect(bodies.map(shapeOf)).toEqual([2, 1]);
    expect(result.current.errorCode).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(result.current.sendStates).toEqual({ "cmid-1": "failed" });
    unmount();
  });

  it("any other 400 is an ordinary failure: not re-sent, and the next turn is still shape 2", async () => {
    const { adapters, bodies } = podAdapters([{ refuse: OTHER_400 }, ANSWER]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    expect(bodies).toHaveLength(1);
    expect(result.current.errorCode).toBe(AGENT_ERROR_CODES.INVALID_REQUEST);
    expect(result.current.error).toBe("pageContext: path must be a string");
    expect(result.current.sendStates).toEqual({ "cmid-1": "failed" });
    await act(async () => {
      await result.current.send("next");
    });
    expect(bodies.map(shapeOf)).toEqual([2, 2]);
    unmount();
  });

  it("a turn whose parts shape 1 cannot carry is not re-sent: it fails with PARTS_INVALID and a plain reason", async () => {
    const { adapters, bodies } = podAdapters([{ refuse: OLD_RUNTIME }]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("listen to this", { parts: [AUDIO] });
    });
    expect(bodies).toHaveLength(1);
    expect(shapeOf(bodies[0])).toBe(2);
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.PARTS_INVALID);
    expect(result.current.error).toMatch(/only attached JPEG, PNG, GIF or WebP images/);
    expect(result.current.sendStates).toEqual({ "cmid-1": "failed" });
    unmount();
  });

  it("the downgrade lives in memory only: an app switch writes shape 2 again", async () => {
    const { adapters, bodies } = podAdapters([{ refuse: OLD_RUNTIME }, ANSWER, ANSWER]);
    const { result, rerender, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    rerender({ appId: "app-other" });
    await act(async () => {
      await result.current.send("other agent");
    });
    expect(bodies.map(shapeOf)).toEqual([2, 1, 2]);
    unmount();
  });
});

/**
 * A refusal face pinned in `fixtures/` (its status, headers and body bytes), read the way every transport reads a
 * refusal: through `agentResponseErrorFrom`.
 */
async function refusalFace(file: "shape2-refusal.runtime.json" | "shape2-refusal.dev-server.json"): Promise<AgentResponseError> {
  const raw: unknown = JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));
  if (typeof raw !== "object" || raw === null) throw new Error(`${file}: not an object`);
  const status: unknown = Reflect.get(raw, "status");
  const headers: unknown = Reflect.get(raw, "headers");
  const body: unknown = Reflect.get(raw, "body");
  if (typeof status !== "number" || typeof body !== "string" || typeof headers !== "object" || headers === null) {
    throw new Error(`${file}: not a refusal face`);
  }
  const h = new Headers();
  for (const [name, value] of Object.entries(headers)) if (typeof value === "string") h.set(name, value);
  return agentResponseErrorFrom(new Response(body, { status, headers: h }));
}

describe("useAgentInvoke — W1 on each released server's face", () => {
  for (const file of ["shape2-refusal.runtime.json", "shape2-refusal.dev-server.json"] as const) {
    it(`${file}: exactly ONE fallback to shape 1 under the same id, and the next turn is shape 1`, async () => {
      const face = await refusalFace(file);
      const { adapters, bodies } = podAdapters([{ refuse: face }, ANSWER, ANSWER]);
      const { result, unmount } = hook(adapters);
      await act(async () => {
        await result.current.send("hello");
      });
      expect(bodies.map(shapeOf)).toEqual([2, 1]);
      expect(bodies.map(turnIdOf)).toEqual(["cmid-1", "cmid-1"]);
      expect(result.current.errorCode).toBeNull();
      await act(async () => {
        await result.current.send("again");
      });
      expect(bodies.map(shapeOf)).toEqual([2, 1, 1]);
      unmount();
    });
  }

  it("the dev server's sentence beside a code is not its face: no fallback, the code stands", async () => {
    const coded = await agentResponseErrorFrom(
      new Response('{"error":"body.input must be a string","code":"X"}', {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { adapters, bodies } = podAdapters([{ refuse: coded }, ANSWER]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    expect(bodies).toHaveLength(1);
    expect(result.current.errorCode).toBe("X");
    expect(result.current.error).toBe("body.input must be a string");
    expect(result.current.sendStates).toEqual({ "cmid-1": "failed" });
    unmount();
  });
});

describe("useAgentInvoke — W2, a turn's shape is fixed at its first send", () => {
  it("a Retry keeps its shape across the downgrade of OTHER turns", async () => {
    // Turn 1 goes as shape 2 and fails before admission; turn 2 trips the downgrade; turn 1's Retry still goes as 2.
    const { adapters, bodies } = podAdapters([{ refuse: SATURATED }, { refuse: OLD_RUNTIME }, ANSWER, ANSWER]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("first");
    });
    expect(result.current.sendStates).toEqual({ "cmid-1": "failed" });
    await act(async () => {
      await result.current.send("second");
    });
    expect(bodies.map(shapeOf)).toEqual([2, 2, 1]);
    await act(async () => {
      await result.current.send("first", { replaces: "cmid-1" });
    });
    expect(bodies.map(shapeOf)).toEqual([2, 2, 1, 2]);
    expect(turnIdOf(bodies[3])).toBe("cmid-3");
    unmount();
  });

  it("a send under an id that already went keeps that turn's shape", async () => {
    const { adapters, bodies } = podAdapters([{ refuse: SATURATED }, { refuse: OLD_RUNTIME }, ANSWER, ANSWER]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("tap", { clientMessageId: "tap-1" });
    });
    await act(async () => {
      await result.current.send("second");
    });
    await act(async () => {
      await result.current.send("tap", { clientMessageId: "tap-1" });
    });
    expect(bodies.map(shapeOf)).toEqual([2, 2, 1, 2]);
    expect(turnIdOf(bodies[3])).toBe("tap-1");
    unmount();
  });

  it("a turn the fallback moved to shape 1 is retried as shape 1", async () => {
    const { adapters, bodies } = podAdapters([{ refuse: OLD_RUNTIME }, { refuse: SATURATED }, ANSWER]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    expect(result.current.sendStates).toEqual({ "cmid-1": "failed" });
    await act(async () => {
      await result.current.send("hello", { replaces: "cmid-1" });
    });
    expect(bodies.map(shapeOf)).toEqual([2, 1, 1]);
    unmount();
  });
});

describe("useAgentInvoke — parts in shape 2: the runtime's acknowledgement is the one word on a kind", () => {
  it("an audio part is sent with no advertisement at all, and runs when the runtime acknowledges it", async () => {
    const { adapters, bodies } = podAdapters([{ session: { threadId: "t-1", accepts: { parts: { audio: 1 } } } }]);
    const { result, unmount } = hook(adapters);
    expect(result.current.acceptedPartKinds).toBeNull();
    await act(async () => {
      await result.current.send("listen to this", { parts: [AUDIO] });
    });
    expect(bodies[0]).toMatchObject({ messages: [{ content: [{ type: "text", text: "listen to this" }, AUDIO] }] });
    expect(result.current.errorCode).toBeNull();
    expect(result.current.messages.at(-1)).toEqual({ role: "assistant", text: "Hi." });
    unmount();
  });

  it("PARTS_UNSUPPORTED when accepts.parts misses a kind that was sent, before any reply", async () => {
    const { adapters } = podAdapters([{ session: { threadId: "t-1", accepts: { parts: { image: 1 } } } }]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("look and listen", { parts: [PNG, AUDIO] });
    });
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.PARTS_UNSUPPORTED);
    expect(result.current.messages.map((m) => m.role)).toEqual(["user"]);
    expect(result.current.sendStates).toEqual({});
    unmount();
  });

  it("acceptedPartKinds is a hint from the frame: it never gates a send of an unlisted kind", async () => {
    const listsImages = { session: { threadId: "t-1", accepts: { partKinds: ["image"] } } };
    const acksAudio = { session: { threadId: "t-1", accepts: { partKinds: ["image"], parts: { audio: 1 } } } };
    const { adapters, bodies } = podAdapters([listsImages, acksAudio]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.acceptedPartKinds).toEqual(["image"]);
    await act(async () => {
      await result.current.send("listen", { parts: [AUDIO] });
    });
    expect(bodies).toHaveLength(2);
    expect(result.current.errorCode).toBeNull();
    unmount();
  });

  it("an uploaded object needs a thread: refused on first contact with PARTS_INVALID, sent once the thread exists", async () => {
    const uploaded: UserPartCandidate = { type: "document", source: { type: "file", fileId: "upl_1" } };
    const { adapters, bodies } = podAdapters([ANSWER, { session: { threadId: "t-1", accepts: { parts: { document: 1 } } } }]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("read this", { clientMessageId: "host-1", parts: [uploaded] });
    });
    expect(bodies).toEqual([]);
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.PARTS_INVALID);
    expect(result.current.error).toMatch(/conversation that has already started/);
    expect(result.current.sendStates).toEqual({ "host-1": "failed" });
    await act(async () => {
      await result.current.send("hello");
    });
    await act(async () => {
      await result.current.send("read this", { parts: [uploaded] });
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ threadId: "t-1", messages: [{ content: [{ type: "text", text: "read this" }, uploaded] }] });
    expect(result.current.errorCode).toBeNull();
    unmount();
  });

  it("an uploaded object without an id is refused before the send with PARTS_INVALID", async () => {
    const { adapters, bodies } = podAdapters([ANSWER]);
    const { result, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("hello");
    });
    await act(async () => {
      await result.current.send("read this", { parts: [{ type: "file", source: { type: "file", fileId: "" } }] });
    });
    expect(bodies).toHaveLength(1);
    expect(result.current.errorCode).toBe(CLIENT_ERROR_CODES.PARTS_INVALID);
    expect(result.current.error).toMatch(/uploaded file/);
    unmount();
  });

  it("the message's context rides run.context in shape 2 and the turnContext key in shape 1", async () => {
    const turnContext = [{ type: "text" as const, text: "The visitor is on the Pro plan." }];
    const { adapters, bodies } = podAdapters([ANSWER, { refuse: OLD_RUNTIME }, ANSWER]);
    const { result, rerender, unmount } = hook(adapters);
    await act(async () => {
      await result.current.send("which plan?", { turnContext });
    });
    expect(bodies[0]).toMatchObject({ run: { context: turnContext } });
    rerender({ appId: "app-old" });
    await act(async () => {
      await result.current.send("which plan?", { turnContext });
    });
    expect(bodies[2]).toEqual({ input: "which plan?", clientMessageId: "cmid-2", turnContext });
    unmount();
  });
});
