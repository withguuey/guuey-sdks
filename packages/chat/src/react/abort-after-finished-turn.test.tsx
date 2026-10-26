// @vitest-environment jsdom
/**
 * guuey#2445 — Stop pressed right after a finished turn.
 *
 * Repro (web and React Native, both renderers draw this one plan): send Q1
 * and let its answer finish, send Q2, and call `abort()` while Q2 is still
 * before its first token. The drawn transcript was
 * `A1, Q1, A1, Stopped., Q2, Stopped.`: the previous answer drawn again
 * above its own question, and a second "Stopped." under the finished
 * answer. Expected: `Q1, A1, Q2, Stopped.`.
 *
 * Driven end to end through the REAL `useAgentInvoke` (block-preserving, as
 * `@guuey/chat` mounts it), the REAL `useTranscriptInputs` assembler and the
 * REAL `planTranscript`, with turn-identity frames shaped like the pod's.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { type AgentInvokeAdapters, type InvokeRequest } from "@guuey/agent-client";
import { useAgentInvoke } from "@guuey/agent-client/react";
import { calmPolicy } from "../policy.js";
import { planTranscript } from "../plan.js";
import type { TranscriptPlan } from "../types.js";
import { useTranscriptInputs } from "./use-transcript.js";

afterEach(cleanup);

const THREAD = "thread-2445";
const frame = (ev: object): string => `event: message\ndata: ${JSON.stringify(ev)}\n\n`;
const session = `event: session\ndata: ${JSON.stringify({ threadId: THREAD })}\n\n`;

/** A whole finished turn, in the pod's AgEvent order (each invoke's seq restarts at 0). */
function finishedTurn(turnId: string, text: string): string[] {
  const msg = `msg_${turnId}`;
  return [
    session,
    frame({ type: "turn.start", seq: 0, turnId, threadId: THREAD }),
    frame({ type: "message.start", seq: 1, id: msg, turnId, threadId: THREAD, role: "assistant" }),
    frame({ type: "text.start", seq: 2, id: `${msg}:text:0`, messageId: msg, turnId }),
    frame({ type: "text.delta", seq: 3, id: `${msg}:text:0`, messageId: msg, delta: text, turnId }),
    frame({ type: "text.end", seq: 4, id: `${msg}:text:0`, messageId: msg, turnId }),
    frame({ type: "message.end", seq: 5, id: msg }),
    frame({ type: "turn.done", seq: 6, turnId, outcome: { type: "success", result: text }, finishReason: "stop" }),
    "event: done\ndata: {}\n\n",
  ];
}

/**
 * The stopped turn: the pod admits it (the "Thinking…" face), optionally
 * opens it, and sends nothing more before the user presses Stop.
 */
function stalledTurn(turnId: string, opened: boolean): string[] {
  return opened ? [session, frame({ type: "turn.start", seq: 0, turnId, threadId: THREAD })] : [session];
}

function adapters(turns: string[][]): { adapters: AgentInvokeAdapters; delivered: () => Promise<void> } {
  let call = 0;
  let markDelivered: () => void = () => {};
  let delivered = new Promise<void>((resolve) => {
    markDelivered = resolve;
  });
  let ids = 0;
  const store: Record<string, string> = {};
  return {
    delivered: () => delivered,
    adapters: {
      storage: {
        load: (k) => store[k] ?? null,
        save: (k, v) => {
          store[k] = v;
        },
      },
      generateId: () => `cm-${++ids}`,
      transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
        const chunks = turns[call++] ?? [];
        for (const c of chunks) yield c;
        markDelivered();
        delivered = new Promise<void>((resolve) => {
          markDelivered = resolve;
        });
        // A turn whose frames end without `done` stays open until the abort.
        if (!chunks.some((c) => c.startsWith("event: done"))) {
          await new Promise<void>((resolve) => {
            if (req.signal.aborted) resolve();
            else req.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      },
    },
  };
}

/** The drawn rows, top to bottom: user text, assistant text, then the status line under them. */
function drawn(plan: TranscriptPlan): string[] {
  const out: string[] = [];
  for (const it of plan.items) {
    if (it.kind === "user") out.push(`user:${it.text}`);
    else if (it.kind === "text") out.push(`agent:${it.text}${it.stopped ? " [Stopped.]" : ""}`);
  }
  if (plan.status !== null) out.push(`status:${plan.status.copy}`);
  return out;
}

function mount(turns: string[][]) {
  const a = adapters(turns);
  const hook = renderHook(() => {
    const invoke = useAgentInvoke({
      endpointUrl: "https://pod.example.com",
      appId: "app-2445",
      adapters: a.adapters,
      preserveBlocks: true,
      stallRecovery: false,
    });
    const { inputs } = useTranscriptInputs(invoke);
    return { invoke, inputs };
  });
  return { ...hook, delivered: a.delivered };
}

describe("guuey#2445 — abort right after a finished turn", () => {
  it.each([
    { name: "admitted only (no AgEvent of Q2 yet)", opened: false },
    { name: "admitted and opened (turn.start of Q2 folded)", opened: true },
  ])("draws Q1, A1, Q2, Stopped. — once each — when Q2 is $name", async ({ opened }) => {
    const { result, delivered } = mount([finishedTurn("turn_1", "A1"), stalledTurn("turn_2", opened)]);

    await act(async () => {
      await result.current.invoke.send("Q1");
    });
    expect(result.current.invoke.status).toBe("ready");

    let second: Promise<void> = Promise.resolve();
    await act(async () => {
      second = result.current.invoke.send("Q2");
      await delivered();
    });
    await waitFor(() => expect(result.current.invoke.status).toBe("thinking"));
    await act(async () => {
      result.current.invoke.abort();
      await second;
    });
    expect(result.current.invoke.aborted).toBe(true);

    const plan = planTranscript(result.current.inputs, calmPolicy());
    expect(drawn(plan)).toEqual(["user:Q1", "agent:A1", "user:Q2", "status:Stopped."]);
  });

  it("keeps the stop marker on the stopped turn's own partial when Q2 had already streamed text", async () => {
    const partial = finishedTurn("turn_2", "half").slice(0, 5); // session … text.delta, no end
    const { result, delivered } = mount([finishedTurn("turn_1", "A1"), partial]);

    await act(async () => {
      await result.current.invoke.send("Q1");
    });
    let second: Promise<void> = Promise.resolve();
    await act(async () => {
      second = result.current.invoke.send("Q2");
      await delivered();
    });
    await waitFor(() => expect(result.current.invoke.status).toBe("responding"));
    await act(async () => {
      result.current.invoke.abort();
      await second;
    });

    const plan = planTranscript(result.current.inputs, calmPolicy());
    expect(drawn(plan)).toEqual([
      "user:Q1",
      "agent:A1",
      "user:Q2",
      "agent:half [Stopped.]",
      "status:Stopped.",
    ]);
  });
});
