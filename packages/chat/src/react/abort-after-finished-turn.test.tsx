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
import {
  threadHistoryRowsToMessages,
  type AgentInvokeAdapters,
  type AgentMessage,
  type InvokeRequest,
} from "@guuey/agent-client";
import { useAgentInvoke } from "@guuey/agent-client/react";
import { calmPolicy } from "../policy.js";
import { planTranscript } from "../plan.js";
import type { TranscriptInputs, TranscriptPlan } from "../types.js";
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

/**
 * A turn whose stream CLOSES without `done` (a cut connection): the hook's
 * truncation path decides it, adopting history or failing the turn.
 */
interface ClosingTurn {
  frames: string[];
  closes: true;
}
const closing = (frames: string[]): ClosingTurn => ({ frames, closes: true });

/**
 * `history`: a persisted transcript the hook rehydrates before the first
 * send (a reload, then keep chatting), so the plan has a flat prefix in
 * front of the fold. `reloads`: what every later history read returns (the
 * truncation probe), when it differs from `history`.
 */
function adapters(
  turns: Array<string[] | ClosingTurn>,
  history?: AgentMessage[],
  reloads?: AgentMessage[],
): { adapters: AgentInvokeAdapters; delivered: () => Promise<void> } {
  let call = 0;
  let loads = 0;
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
        load: (k) => store[k] ?? (history !== undefined ? THREAD : null),
        save: (k, v) => {
          store[k] = v;
        },
      },
      generateId: () => `cm-${++ids}`,
      ...(history !== undefined
        ? { history: { load: async () => ({ messages: loads++ === 0 || reloads === undefined ? history : reloads }) } }
        : {}),
      transport: async function* (req: InvokeRequest): AsyncGenerator<string> {
        const turn = turns[call++] ?? [];
        const chunks = Array.isArray(turn) ? turn : turn.frames;
        for (const c of chunks) yield c;
        markDelivered();
        delivered = new Promise<void>((resolve) => {
          markDelivered = resolve;
        });
        // A turn whose frames end without `done` stays open until the abort,
        // unless it is one that closes.
        if (Array.isArray(turn) && !chunks.some((c) => c.startsWith("event: done"))) {
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

function mount(turns: Array<string[] | ClosingTurn>, history?: AgentMessage[], reloads?: AgentMessage[]) {
  const a = adapters(turns, history, reloads);
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

/**
 * The seam must count the stopped turn as covered ONLY when that send got no
 * turn with a source. A stop that lands after the turn's last frame (its
 * `turn.done` folded, the stream's `done` not yet sent, so Stop is still on
 * screen) already has its source. Counting it again cut one group too many
 * from the rehydrated prefix and deleted the last reloaded answer.
 */
describe("guuey#2445 — abort with a rehydrated history prefix in front of the fold", () => {
  const HISTORY: AgentMessage[] = [
    { role: "user", text: "H0", seq: 1 },
    { role: "assistant", text: "HA0", seq: 2 },
  ];

  async function sendQ1ThenQ2(
    result: { current: ReturnType<typeof mount>["result"]["current"] },
    delivered: () => Promise<void>,
  ): Promise<{ second: Promise<void> }> {
    await waitFor(() => expect(result.current.invoke.messages.map((m) => m.text)).toEqual(["H0", "HA0"]));
    await act(async () => {
      await result.current.invoke.send("Q1");
    });
    expect(result.current.invoke.status).toBe("ready");
    let second: Promise<void> = Promise.resolve();
    await act(async () => {
      second = result.current.invoke.send("Q2");
      await delivered();
    });
    // Wrapped: an async function returning the bare promise would adopt it
    // and wait for Q2's stream, which ends only on the abort below.
    return { second };
  }

  it.each([
    { name: "admitted only (no AgEvent of Q2 yet)", opened: false },
    { name: "admitted and opened (turn.start of Q2 folded)", opened: true },
  ])("keeps HA0 when Q2 is stopped before its first token — $name", async ({ opened }) => {
    const { result, delivered } = mount([finishedTurn("turn_1", "A1"), stalledTurn("turn_2", opened)], HISTORY);
    const { second } = await sendQ1ThenQ2(result, delivered);
    await waitFor(() => expect(result.current.invoke.status).toBe("thinking"));
    await act(async () => {
      result.current.invoke.abort();
      await second;
    });
    expect(result.current.invoke.aborted).toBe(true);

    const plan = planTranscript(result.current.inputs, calmPolicy());
    expect(drawn(plan)).toEqual([
      "user:H0",
      "agent:HA0",
      "user:Q1",
      "agent:A1",
      "user:Q2",
      "status:Stopped.",
    ]);
  });

  it("keeps HA0 when Q2 is stopped after its turn.done but before the stream's done", async () => {
    const answered = finishedTurn("turn_2", "A2").filter((c) => !c.startsWith("event: done"));
    const { result, delivered } = mount([finishedTurn("turn_1", "A1"), answered], HISTORY);
    const { second } = await sendQ1ThenQ2(result, delivered);
    await waitFor(() => expect(result.current.invoke.status).toBe("responding"));
    await act(async () => {
      result.current.invoke.abort();
      await second;
    });
    expect(result.current.invoke.aborted).toBe(true);

    const plan = planTranscript(result.current.inputs, calmPolicy());
    expect(drawn(plan)).toEqual([
      "user:H0",
      "agent:HA0",
      "user:Q1",
      "agent:A1",
      "user:Q2",
      "agent:A2",
      "status:Stopped.",
    ]);
  });

  it("keeps HA0 while Q2 is answered (its turn.done folded) and the stream's done has not come", async () => {
    const answered = finishedTurn("turn_2", "A2").filter((c) => !c.startsWith("event: done"));
    const { result, delivered } = mount([finishedTurn("turn_1", "A1"), answered], HISTORY);
    const { second } = await sendQ1ThenQ2(result, delivered);
    await waitFor(() => expect(result.current.invoke.status).toBe("responding"));

    const plan = planTranscript(result.current.inputs, calmPolicy());
    expect(drawn(plan)).toEqual(["user:H0", "agent:HA0", "user:Q1", "agent:A1", "user:Q2", "agent:A2"]);
    await act(async () => {
      result.current.invoke.abort();
      await second;
    });
  });

  it("draws the answered Q2 once in a pure-live session stopped after its turn.done", async () => {
    const answered = finishedTurn("turn_2", "A2").filter((c) => !c.startsWith("event: done"));
    const { result, delivered } = mount([finishedTurn("turn_1", "A1"), answered]);
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
    expect(drawn(plan)).toEqual(["user:Q1", "agent:A1", "user:Q2", "agent:A2", "status:Stopped."]);
  });
});

/**
 * The same seam when the send produced a SECOND turn after its answer: a
 * paused hitl turn appended behind it, which has no source of its own. The
 * send's answer is its source, so nothing is pending and HA0 stays. Hand-built
 * from the inputs the real assembler produced in the cases above.
 */
describe("guuey#2445 — a paused hitl turn appended after the send's own answer", () => {
  const text = (t: string) => [{ type: "text" as const, text: t }];
  const inputs = (aborted: boolean): TranscriptInputs => ({
    messages: [
      { role: "user", text: "H0", seq: 1 },
      { role: "assistant", text: "HA0", seq: 2 },
      { role: "user", text: "Q1", clientMessageId: "cm-1", precedingTurnCount: 0 },
      { role: "assistant", text: "A1" },
      { role: "user", text: "Q2", clientMessageId: "cm-2", precedingTurnCount: 1 },
    ],
    result: {
      messages: [
        { id: "m1", role: "assistant", turnId: "turn_1", content: text("A1") },
        { id: "m2", role: "assistant", turnId: "turn_2", content: text("A2") },
      ],
      artifacts: [],
      memory: [],
      turns: [
        { turnId: "turn_1", threadId: THREAD, outcome: { type: "success" } },
        { turnId: "turn_2", threadId: THREAD, outcome: { type: "success" } },
        { turnId: "turn_3", threadId: THREAD, outcome: { type: "paused", asks: [] } },
      ],
    },
    assistantText: "",
    status: aborted ? "ready" : "responding",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    aborted,
  });

  it.each([
    { name: "still responding", aborted: false },
    { name: "stopped", aborted: true },
  ])("keeps HA0 — $name", ({ aborted }) => {
    const rows = drawn(planTranscript(inputs(aborted), calmPolicy())).filter((r) => !r.startsWith("status:"));
    expect(rows).toEqual(["user:H0", "agent:HA0", "user:Q1", "agent:A1", "user:Q2", "agent:A2"]);
  });
});

/**
 * The seam after the stopped send is no longer the latest one: Q1 finishes,
 * Q2 is stopped before its first token, Q3 finishes. Q2 produced no answer,
 * so the fold holds one source fewer than there are live questions; the
 * transcript must still draw each answer once, under its own question.
 */
describe("guuey#2445 — a finished send after a send stopped before its first token", () => {
  const HISTORY: AgentMessage[] = [
    { role: "user", text: "H0", seq: 1 },
    { role: "assistant", text: "HA0", seq: 2 },
  ];

  async function q1StopQ2ThenQ3(
    result: { current: ReturnType<typeof mount>["result"]["current"] },
    delivered: () => Promise<void>,
  ): Promise<void> {
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
    await act(async () => {
      await result.current.invoke.send("Q3");
    });
    expect(result.current.invoke.status).toBe("ready");
  }

  it.each([
    { name: "admitted only", opened: false, prefix: false },
    { name: "opened (turn.start of Q2 folded)", opened: true, prefix: false },
    { name: "admitted only, after a reload", opened: false, prefix: true },
    { name: "opened, after a reload", opened: true, prefix: true },
  ])("draws Q1, A1, Q2, Q3, A3 with A1 once — Q2 $name", async ({ opened, prefix }) => {
    const turns = [finishedTurn("turn_1", "A1"), stalledTurn("turn_2", opened), finishedTurn("turn_3", "A3")];
    const { result, delivered } = mount(turns, prefix ? HISTORY : undefined);
    if (prefix) {
      await waitFor(() => expect(result.current.invoke.messages.map((m) => m.text)).toEqual(["H0", "HA0"]));
    }
    await q1StopQ2ThenQ3(result, delivered);

    const rows = drawn(planTranscript(result.current.inputs, calmPolicy()));
    expect(rows).toEqual([
      ...(prefix ? ["user:H0", "agent:HA0"] : []),
      "user:Q1",
      "agent:A1",
      "user:Q2",
      "user:Q3",
      "agent:A3",
    ]);
  });

  it("keeps the order while a later send is still answering", async () => {
    const answering = finishedTurn("turn_4", "A4").slice(0, 5); // session … text.delta of A4
    const turns = [
      finishedTurn("turn_1", "A1"),
      stalledTurn("turn_2", true),
      finishedTurn("turn_3", "A3"),
      answering,
    ];
    const { result, delivered } = mount(turns, HISTORY);
    await waitFor(() => expect(result.current.invoke.messages.map((m) => m.text)).toEqual(["H0", "HA0"]));
    await q1StopQ2ThenQ3(result, delivered);
    let fourth: Promise<void> = Promise.resolve();
    await act(async () => {
      fourth = result.current.invoke.send("Q4");
      await delivered();
    });
    await waitFor(() => expect(result.current.invoke.status).toBe("responding"));

    const rows = drawn(planTranscript(result.current.inputs, calmPolicy())).filter((r) => !r.startsWith("status:"));
    expect(rows).toEqual([
      "user:H0",
      "agent:HA0",
      "user:Q1",
      "agent:A1",
      "user:Q2",
      "user:Q3",
      "agent:A3",
      "user:Q4",
      "agent:A4",
    ]);
    await act(async () => {
      result.current.invoke.abort();
      await fourth;
    });
  });
});

/**
 * A send that ends with no answer and no user Stop: an in-band error frame
 * before its first assistant frame, or a stream cut before any frame (the
 * hook fails it as truncated). Neither leaves the send a source in the fold,
 * so it is the same seam as a stop.
 */
describe("guuey#2445 — a send that fails before its first assistant frame", () => {
  const HISTORY: AgentMessage[] = [
    { role: "user", text: "H0", seq: 1 },
    { role: "assistant", text: "HA0", seq: 2 },
  ];
  const errorFrame = `event: error\ndata: ${JSON.stringify({ code: "INTERNAL", message: "boom" })}\n\n`;
  const failedTurn = (opened: boolean): string[] => [
    ...stalledTurn("turn_2", opened),
    errorFrame,
    "event: done\ndata: {}\n\n",
  ];

  it.each([
    { name: "admitted only", opened: false, prefix: false },
    { name: "opened", opened: true, prefix: false },
    { name: "admitted only, after a reload", opened: false, prefix: true },
    { name: "opened, after a reload", opened: true, prefix: true },
  ])("draws A1 once after an error frame — $name", async ({ opened, prefix }) => {
    const turns = [finishedTurn("turn_1", "A1"), failedTurn(opened), finishedTurn("turn_3", "A3")];
    const { result } = mount(turns, prefix ? HISTORY : undefined);
    if (prefix) {
      await waitFor(() => expect(result.current.invoke.messages.map((m) => m.text)).toEqual(["H0", "HA0"]));
    }
    await act(async () => {
      await result.current.invoke.send("Q1");
    });
    await act(async () => {
      await result.current.invoke.send("Q2");
    });
    expect(result.current.invoke.status).toBe("ready");
    expect(result.current.invoke.error).toBe("boom");
    expect(result.current.invoke.aborted).toBe(false);

    const head = prefix ? ["user:H0", "agent:HA0"] : [];
    const afterError = drawn(planTranscript(result.current.inputs, calmPolicy()));
    expect(afterError).toEqual([...head, "user:Q1", "agent:A1", "user:Q2"]);

    await act(async () => {
      await result.current.invoke.send("Q3");
    });
    const afterQ3 = drawn(planTranscript(result.current.inputs, calmPolicy()));
    expect(afterQ3).toEqual([...head, "user:Q1", "agent:A1", "user:Q2", "user:Q3", "agent:A3"]);
  });

  it("draws A1 once after a stream cut before any frame (truncated, not stopped)", async () => {
    const turns = [finishedTurn("turn_1", "A1"), closing([session]), finishedTurn("turn_3", "A3")];
    const { result } = mount(turns);
    await act(async () => {
      await result.current.invoke.send("Q1");
    });
    await act(async () => {
      await result.current.invoke.send("Q2");
    });
    expect(result.current.invoke.status).toBe("ready");
    expect(result.current.invoke.errorCode).toBe("STREAM_TRUNCATED");
    expect(result.current.invoke.aborted).toBe(false);

    expect(drawn(planTranscript(result.current.inputs, calmPolicy()))).toEqual(["user:Q1", "agent:A1", "user:Q2"]);
    await act(async () => {
      await result.current.invoke.send("Q3");
    });
    expect(drawn(planTranscript(result.current.inputs, calmPolicy()))).toEqual([
      "user:Q1",
      "agent:A1",
      "user:Q2",
      "user:Q3",
      "agent:A3",
    ]);
  });
});

/**
 * A turn the hook ADOPTED from history (its stream was cut after its answer,
 * and history already held it) is in both lists: the fold kept its frames,
 * and the flat rows were replaced by history's, which carry no stamp. The
 * next send's stamp counts that turn, so the flat prefix in front of the
 * fold ends where the adopted turn begins, and it is drawn once.
 */
describe("guuey#2445 — sending after a turn adopted from history", () => {
  it("draws the adopted answer once, under its own question", async () => {
    const HISTORY: AgentMessage[] = [
      { role: "user", text: "H0", seq: 1 },
      { role: "assistant", text: "HA0", seq: 2 },
    ];
    const ADOPTED: AgentMessage[] = [
      ...HISTORY,
      { role: "user", text: "Q1", seq: 3 },
      { role: "assistant", text: "A1", seq: 4 },
    ];
    const cut = finishedTurn("turn_1", "A1").filter((c) => !c.startsWith("event: done"));
    const { result } = mount([closing(cut), finishedTurn("turn_2", "A2")], HISTORY, ADOPTED);
    await waitFor(() => expect(result.current.invoke.messages.map((m) => m.text)).toEqual(["H0", "HA0"]));
    await act(async () => {
      await result.current.invoke.send("Q1");
    });
    expect(result.current.invoke.adopted).toBe(true);
    await act(async () => {
      await result.current.invoke.send("Q2");
    });

    expect(drawn(planTranscript(result.current.inputs, calmPolicy()))).toEqual([
      "user:H0",
      "agent:HA0",
      "user:Q1",
      "agent:A1",
      "user:Q2",
      "agent:A2",
    ]);
  });
});

/**
 * A history read that REPLACES the rows (the hook adopting a cut turn's
 * finished reply) after a send that has no answer: Q1 answered, Q2 stopped
 * before its first token, Q3's stream cut after its answer and adopted. The
 * adopted history holds Q2 as a user row with no reply, and the fold holds
 * no source for Q2 (and, admitted only, no turn record either). The read
 * plane serves each user row's `clientMessageId`, as here.
 */
describe("guuey#2445 — a turn adopted from history after a send stopped before its first token", () => {
  const PREFIX: AgentMessage[] = [
    { role: "user", text: "H0", seq: 1 },
    { role: "assistant", text: "HA0", seq: 2 },
  ];
  /** The adopted read, mapped from read-plane rows by the real history mapper. */
  const adoptedHistory = (prefix: boolean): AgentMessage[] => {
    const head: Array<[string, string, string]> = [
      ["user", "H0", "cm-h0"],
      ["agent", "HA0", "cm-h0#agent"],
    ];
    const rows: Array<[string, string, string]> = [
      ...(prefix ? head : []),
      ["user", "Q1", "cm-1"],
      ["agent", "A1", "cm-1#agent"],
      ["user", "Q2", "cm-2"],
      ["user", "Q3", "cm-3"],
      ["agent", "A3", "cm-3#agent"],
    ];
    return threadHistoryRowsToMessages(
      rows.map(([authorRole, text, clientMessageId], i) => ({
        seq: i + 1,
        at: "2026-10-27T00:00:00Z",
        kind: "text",
        authorRole,
        text,
        clientMessageId,
      })),
    );
  };

  it.each([
    { name: "admitted only", opened: false, prefix: true },
    { name: "opened (turn.start of Q2 folded)", opened: true, prefix: true },
    { name: "admitted only, pure live", opened: false, prefix: false },
    { name: "opened, pure live", opened: true, prefix: false },
  ])("draws A1 once, right after the adoption and after Q4 — Q2 $name", async ({ opened, prefix }) => {
    const cut = finishedTurn("turn_3", "A3").filter((c) => !c.startsWith("event: done"));
    const turns = [
      finishedTurn("turn_1", "A1"),
      stalledTurn("turn_2", opened),
      closing(cut),
      finishedTurn("turn_4", "A4"),
    ];
    const { result, delivered } = mount(turns, prefix ? PREFIX : [], adoptedHistory(prefix));
    if (prefix) {
      await waitFor(() => expect(result.current.invoke.messages.map((m) => m.text)).toEqual(["H0", "HA0"]));
    }
    await act(async () => {
      await result.current.invoke.send("Q1");
    });
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
    await act(async () => {
      await result.current.invoke.send("Q3");
    });
    expect(result.current.invoke.adopted).toBe(true);
    expect(result.current.invoke.status).toBe("ready");

    const head = prefix ? ["user:H0", "agent:HA0"] : [];
    const answered = [...head, "user:Q1", "agent:A1", "user:Q2", "user:Q3", "agent:A3"];
    expect(drawn(planTranscript(result.current.inputs, calmPolicy()))).toEqual(answered);

    await act(async () => {
      await result.current.invoke.send("Q4");
    });
    expect(drawn(planTranscript(result.current.inputs, calmPolicy()))).toEqual([...answered, "user:Q4", "agent:A4"]);
  });

  it("keeps the earlier rule when the adopted history names no row (a read plane without ids)", async () => {
    const cut = finishedTurn("turn_3", "A3").filter((c) => !c.startsWith("event: done"));
    const turns = [finishedTurn("turn_1", "A1"), finishedTurn("turn_2", "A2"), closing(cut), finishedTurn("turn_4", "A4")];
    const unnamed = [
      ...PREFIX,
      { role: "user" as const, text: "Q1", seq: 3 },
      { role: "assistant" as const, text: "A1", seq: 4 },
      { role: "user" as const, text: "Q2", seq: 5 },
      { role: "assistant" as const, text: "A2", seq: 6 },
      { role: "user" as const, text: "Q3", seq: 7 },
      { role: "assistant" as const, text: "A3", seq: 8 },
    ];
    const { result } = mount(turns, PREFIX, unnamed);
    await waitFor(() => expect(result.current.invoke.messages.map((m) => m.text)).toEqual(["H0", "HA0"]));
    for (const q of ["Q1", "Q2", "Q3"]) {
      await act(async () => {
        await result.current.invoke.send(q);
      });
    }
    expect(result.current.invoke.adopted).toBe(true);
    const answered = ["user:H0", "agent:HA0", "user:Q1", "agent:A1", "user:Q2", "agent:A2", "user:Q3", "agent:A3"];
    expect(drawn(planTranscript(result.current.inputs, calmPolicy()))).toEqual(answered);
    await act(async () => {
      await result.current.invoke.send("Q4");
    });
    expect(drawn(planTranscript(result.current.inputs, calmPolicy()))).toEqual([...answered, "user:Q4", "agent:A4"]);
  });
});
