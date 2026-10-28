/**
 * The wake budget on the web adapters: `createWebAdapters` forwards the
 * cold-start options and the wake hook to its transport, and the other wake
 * doors (`POST /agent/ui-action`, `POST /agent/hitl-answer`) wait out a
 * waking answer under the same policy — a card action within its own,
 * shorter budget. A refusal without the waking marker reads exactly as
 * before, even on a host `fetch` that cannot clone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgHitlAnswer } from "@silverprotocol/core";
import { MESSAGE_ANSWER_CAP_MS } from "@guuey/mcp-apps-host";
import {
  UI_ACTION_WAKE_BUDGET_MS,
  createHitlAnswerRelay,
  createUiActionRelay,
  createWebAdapters,
} from "./web-adapters.js";
import { AgentResponseError, WAKING_HEADER, isWakingRefusal } from "./errors.js";
import { WAKE_BUDGET_MS, type WakeWaitInfo } from "./saturation-retry.js";
import type { InvokeRequest } from "./types.js";

const SECRET = "0123456789abcdef".repeat(4);
const POD = "https://pod.example";
const POD_ACTION_URL = "https://pod.example/agent/ui-action";
const POD_HITL_URL = "https://pod.example/agent/hitl-answer";
const OK_BODY = { content: [{ type: "text", text: "toggled" }] };
const REQUEST = {
  resourceUri: "ui://ggui/render/s/h",
  name: "ggui_runtime_submit_action",
  arguments: { actionId: "toggle" },
};
const ANSWER: AgHitlAnswer = { askId: "profile-consent:app_1:t1", status: "resolved", grantModeId: "once" };

const wakingResponse = (retryAfter = "5"): Response =>
  new Response(null, { status: 503, headers: { [WAKING_HEADER]: "1", "Retry-After": retryAfter } });
const plain503 = (): Response => new Response("Service Unavailable", { status: 503 });
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
/** A response as a host `fetch` that cannot clone hands it back (Expo's `clone()` throws). */
class NoCloneResponse extends Response {
  override clone(): Response {
    throw new Error("Not implemented");
  }
}
/** An old server's coded 503: no waking marker, the pod's envelope. */
const oldServerCoded503 = (): Response =>
  new NoCloneResponse(JSON.stringify({ code: "DRAINING", message: "draining" }), {
    status: 503,
    headers: { "Retry-After": "5" },
  });
const sse = (body = "data: ok\n\n"): Response =>
  new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });

/** A `fetch` that answers from a queue and records every call. */
function queueFetch(responses: ReadonlyArray<() => Response>) {
  const queue = [...responses];
  return vi.fn(
    (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const next = queue.shift();
      if (!next) throw new Error("queueFetch: no queued response");
      return Promise.resolve(next());
    },
  );
}

function invokeRequest(): InvokeRequest {
  return {
    url: "https://pod.example/agent/invoke",
    body: { input: "hi", clientMessageId: "cmid-1" },
    signal: new AbortController().signal,
  };
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createWebAdapters — the wake budget reaches the transport", () => {
  it("is on by default and forwards onWakeWait", async () => {
    const fetchImpl = queueFetch([() => wakingResponse("4"), () => sse()]);
    const infos: WakeWaitInfo[] = [];
    const adapters = createWebAdapters({ fetchImpl, getGuestSecret: () => SECRET, onWakeWait: (i) => infos.push(i) });
    const streamed = drain(adapters.transport(invokeRequest()));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await streamed).toBe("data: ok\n\n");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(infos).toEqual([{ elapsedMs: 0, budgetMs: WAKE_BUDGET_MS, attempt: 1 }]);
  });

  it("forwards coldStartRetry: a re-budget reaches the cold-start path", async () => {
    const fetchImpl = queueFetch([plain503(), plain503()].map((r) => () => r));
    const adapters = createWebAdapters({
      fetchImpl,
      getGuestSecret: () => SECRET,
      coldStartRetry: { attempts: 1, baseDelayMs: 500 },
    });
    const settled = drain(adapters.transport(invokeRequest())).then(
      () => undefined,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(500);
    const err = await settled;
    expect(err).toBeInstanceOf(AgentResponseError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("coldStartRetry: false turns the wrapper off, the wake budget with it", async () => {
    const fetchImpl = queueFetch([() => wakingResponse("4"), () => sse()]);
    const onWakeWait = vi.fn();
    const adapters = createWebAdapters({ fetchImpl, getGuestSecret: () => SECRET, coldStartRetry: false, onWakeWait });
    const err = await drain(adapters.transport(invokeRequest())).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isWakingRefusal(err)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onWakeWait).not.toHaveBeenCalled();
  });

  it("onWakeWait rides beside a re-budgeted coldStartRetry", async () => {
    const fetchImpl = queueFetch([() => wakingResponse("4"), () => sse()]);
    const onWakeWait = vi.fn();
    const adapters = createWebAdapters({
      fetchImpl,
      getGuestSecret: () => SECRET,
      coldStartRetry: { attempts: 0 },
      onWakeWait,
    });
    const streamed = drain(adapters.transport(invokeRequest()));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await streamed).toBe("data: ok\n\n");
    expect(onWakeWait).toHaveBeenCalledTimes(1);
  });

  it("the top-level onWakeWait wins over one inside coldStartRetry", async () => {
    const fetchImpl = queueFetch([() => wakingResponse("4"), () => sse()]);
    const inner = vi.fn();
    const outer = vi.fn();
    const adapters = createWebAdapters({
      fetchImpl,
      getGuestSecret: () => SECRET,
      coldStartRetry: { onWakeWait: inner },
      onWakeWait: outer,
    });
    const streamed = drain(adapters.transport(invokeRequest()));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await streamed).toBe("data: ok\n\n");
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
  });
});

describe("createUiActionRelay — the pod door waits out a wake", () => {
  it("a waking answer is re-sent under the wake budget and the woken result passes through", async () => {
    const fetchImpl = queueFetch([() => wakingResponse("3"), () => json(OK_BODY)]);
    const infos: WakeWaitInfo[] = [];
    const relay = createUiActionRelay({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      endpointUrl: POD,
      guestSecret: SECRET,
      fetchImpl,
      onWakeWait: (i) => infos.push(i),
    });
    const out = relay(REQUEST);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await out).toEqual(OK_BODY);
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([POD_ACTION_URL, POD_ACTION_URL]);
    expect(infos).toEqual([{ elapsedMs: 0, budgetMs: UI_ACTION_WAKE_BUDGET_MS, attempt: 1 }]);
  });

  it("a 503 without the marker is unchanged: terminal, in-band isError, one send", async () => {
    const fetchImpl = queueFetch([plain503, () => json(OK_BODY)]);
    const relay = createUiActionRelay({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      endpointUrl: POD,
      guestSecret: SECRET,
      fetchImpl,
    });
    const out = await relay(REQUEST);
    expect(out.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an old server's coded 503 on a fetch that cannot clone is unchanged: terminal, one send", async () => {
    const fetchImpl = queueFetch([oldServerCoded503, () => json(OK_BODY)]);
    const relay = createUiActionRelay({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      endpointUrl: POD,
      guestSecret: SECRET,
      fetchImpl,
    });
    const out = await relay(REQUEST);
    expect(out.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("the action's wake budget sits under the view's request timeout, beside the host's own answer cap", () => {
    // A spec MCP App view times its tools/call out at the MCP SDK's default
    // 60 s; the host caps its ui/message answer at MESSAGE_ANSWER_CAP_MS for
    // the same reason.
    expect(UI_ACTION_WAKE_BUDGET_MS).toBeLessThan(MESSAGE_ANSWER_CAP_MS);
    expect(MESSAGE_ANSWER_CAP_MS).toBeLessThan(60_000);
  });

  it("a wake that outlasts the action's budget answers the view in-band and stops sending", async () => {
    const fetchImpl = queueFetch(Array.from({ length: 30 }, () => () => wakingResponse("15")));
    const relay = createUiActionRelay({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      endpointUrl: POD,
      guestSecret: SECRET,
      fetchImpl,
    });
    let settled = false;
    const out = relay(REQUEST).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(UI_ACTION_WAKE_BUDGET_MS);
    expect(settled).toBe(true);
    expect((await out).isError).toBe(true);
    // 15 s, 15 s, then the 10 s left: four sends, all to the pod door.
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual(Array(4).fill(POD_ACTION_URL));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("one wake budget covers every door the action tries", async () => {
    // The pod door waits 30 s, then misses; the platform door gets the 10 s left.
    const fetchImpl = queueFetch([
      () => wakingResponse("15"),
      () => wakingResponse("15"),
      () => new Response(null, { status: 404 }),
      ...Array.from({ length: 10 }, () => () => wakingResponse("15")),
    ]);
    const infos: WakeWaitInfo[] = [];
    const relay = createUiActionRelay({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      endpointUrl: POD,
      guestSecret: SECRET,
      fetchImpl,
      onWakeWait: (i) => infos.push(i),
    });
    const out = relay(REQUEST);
    await vi.advanceTimersByTimeAsync(UI_ACTION_WAKE_BUDGET_MS);
    expect((await out).isError).toBe(true);
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      POD_ACTION_URL,
      POD_ACTION_URL,
      POD_ACTION_URL,
      "https://api.example/v1/threads/t1/ui-action",
      "https://api.example/v1/threads/t1/ui-action",
    ]);
    expect(infos.map((i) => i.budgetMs)).toEqual([UI_ACTION_WAKE_BUDGET_MS, UI_ACTION_WAKE_BUDGET_MS, 10_000]);
  });

  it("an abort during a wake wait answers in-band at once and sends nothing more", async () => {
    const controller = new AbortController();
    const fetchImpl = queueFetch([() => wakingResponse("15"), () => json(OK_BODY)]);
    const relay = createUiActionRelay({
      apiBaseUrl: "https://api.example/v1",
      threadId: "t1",
      endpointUrl: POD,
      guestSecret: SECRET,
      fetchImpl,
      signal: controller.signal,
    });
    const out = relay(REQUEST);
    await vi.advanceTimersByTimeAsync(3_000);
    controller.abort();
    expect((await out).isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("createHitlAnswerRelay — the answer door waits out a wake", () => {
  it("a waking answer is re-sent under the wake budget and the door's body comes back", async () => {
    const fetchImpl = queueFetch([
      () => wakingResponse("6"),
      () => new Response(null, { status: 503 }),
      () => json({ askId: ANSWER.askId, status: "resolved", mode: "once" }),
    ]);
    const onWakeWait = vi.fn();
    const relay = createHitlAnswerRelay({ endpointUrl: POD, guestSecret: SECRET, fetchImpl, onWakeWait });
    const out = relay(ANSWER);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await out).toEqual({ ok: true, body: { askId: ANSWER.askId, status: "resolved", mode: "once" } });
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([POD_HITL_URL, POD_HITL_URL, POD_HITL_URL]);
    expect(onWakeWait).toHaveBeenCalledTimes(2);
  });

  it("a 503 without the marker is unchanged: the refusal, one send", async () => {
    const fetchImpl = queueFetch([plain503, () => json({})]);
    const relay = createHitlAnswerRelay({ endpointUrl: POD, guestSecret: SECRET, fetchImpl });
    expect(await relay(ANSWER)).toEqual({
      ok: false,
      status: 503,
      code: null,
      message: "hitl-answer failed (503)",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a wake that outlasts the budget reports the last refusal", async () => {
    const fetchImpl = queueFetch(Array.from({ length: 30 }, () => () => wakingResponse("15")));
    const relay = createHitlAnswerRelay({ endpointUrl: POD, guestSecret: SECRET, fetchImpl });
    const out = relay(ANSWER);
    await vi.advanceTimersByTimeAsync(WAKE_BUDGET_MS);
    expect(await out).toMatchObject({ ok: false, status: 503, code: null });
    expect(fetchImpl).toHaveBeenCalledTimes(WAKE_BUDGET_MS / 15_000 + 1);
  });

  it("an old server's coded 503 on a fetch that cannot clone reads exactly as before", async () => {
    const fetchImpl = queueFetch([oldServerCoded503, () => json({})]);
    const relay = createHitlAnswerRelay({ endpointUrl: POD, guestSecret: SECRET, fetchImpl });
    expect(await relay(ANSWER)).toEqual({ ok: false, status: 503, code: "DRAINING", message: "draining" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an abort during a wake wait reports the waking refusal at once and sends nothing more", async () => {
    const controller = new AbortController();
    const fetchImpl = queueFetch([() => wakingResponse("15"), () => json({})]);
    const relay = createHitlAnswerRelay({ endpointUrl: POD, guestSecret: SECRET, fetchImpl, signal: controller.signal });
    const out = relay(ANSWER);
    await vi.advanceTimersByTimeAsync(3_000);
    controller.abort();
    expect(await out).toEqual({ ok: false, status: 503, code: null, message: "hitl-answer failed (503)" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
