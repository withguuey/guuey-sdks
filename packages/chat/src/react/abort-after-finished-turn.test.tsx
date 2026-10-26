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
  type StallRecoveryOptions,
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

/** What later history reads return: one read for all, or a sequence. */
type Reloads = AgentMessage[] | { reads: AgentMessage[][] };

/**
 * `history`: a persisted transcript the hook rehydrates before the first
 * send (a reload, then keep chatting), so the plan has a flat prefix in
 * front of the fold. `reloads`: what every later history read returns (the
 * truncation probe), when it differs from `history`; `{ reads }` returns one
 * per read, in order, the last one standing.
 */

function adapters(
  turns: Array<string[] | ClosingTurn>,
  history?: AgentMessage[],
  reloads?: Reloads,
): { adapters: AgentInvokeAdapters; delivered: () => Promise<void> } {
  let call = 0;
  let loads = 0;
  let markDelivered: () => void = () => {};
  let delivered = new Promise<void>((resolve) => {
    markDelivered = resolve;
  });
  let ids = 0;
  const store: Record<string, string> = {};
  const reads: AgentMessage[][] | undefined =
    reloads === undefined ? undefined : Array.isArray(reloads) ? [reloads] : reloads.reads;
  const read = (load: number): AgentMessage[] =>
    (load === 0 || reads === undefined ? undefined : reads[Math.min(load - 1, reads.length - 1)]) ?? history ?? [];
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
        ? { history: { load: async () => ({ messages: read(loads++) }) } }
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

function mount(
  turns: Array<string[] | ClosingTurn>,
  history?: AgentMessage[],
  reloads?: Reloads,
  stallRecovery: false | StallRecoveryOptions = false,
) {
  const a = adapters(turns, history, reloads);
  // `stallRecovery` is a prop, so a test can change it between sends (`rerender`).
  const hook = renderHook(
    (props: { stallRecovery: false | StallRecoveryOptions }) => {
      const invoke = useAgentInvoke({
        endpointUrl: "https://pod.example.com",
        appId: "app-2445",
        adapters: a.adapters,
        preserveBlocks: true,
        stallRecovery: props.stallRecovery,
      });
      const { inputs } = useTranscriptInputs(invoke);
      return { invoke, inputs };
    },
    { initialProps: { stallRecovery } },
  );
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

type HistoryRowSpec = [authorRole: "user" | "agent", text: string, clientMessageId: string];
const PREFIX: AgentMessage[] = [
  { role: "user", text: "H0", seq: 1 },
  { role: "assistant", text: "HA0", seq: 2 },
];
const PREFIX_ROWS: HistoryRowSpec[] = [
  ["user", "H0", "cm-h0"],
  ["agent", "HA0", "cm-h0#agent"],
];
/** A history read mapped from read-plane rows by the real mapper, with or without each row's key. */
function historyRows(keyed: boolean, rows: HistoryRowSpec[]): AgentMessage[] {
  return threadHistoryRowsToMessages(
    rows.map(([authorRole, text, clientMessageId], i) => ({
      seq: i + 1,
      at: "2026-10-27T00:00:00Z",
      kind: "text",
      authorRole,
      text,
      ...(keyed ? { clientMessageId } : {}),
    })),
  );
}

/**
 * A history read that REPLACES the rows (the hook adopting a cut turn's
 * finished reply) after a send that has no answer: Q1 answered, Q2 stopped
 * before its first token, Q3's stream cut after its answer and adopted. The
 * adopted history holds Q2 as a user row with no reply, and the fold holds
 * no source for Q2 (and, admitted only, no turn record either). Each case
 * runs with a read plane that serves each user row's `clientMessageId` and
 * with one that serves none.
 */
describe("guuey#2445 — a turn adopted from history after a send stopped before its first token", () => {
  /**
   * The adopted read, mapped from read-plane rows by the real history mapper.
   * `keyed`: the read plane serves each row's `clientMessageId` (the `guuey
   * dev` server serves none). `persistedA2`: the pod persisted Q2's answer
   * although the user stopped Q2 before its first token reached the client.
   */
  const adoptedHistory = (prefix: boolean, keyed: boolean, persistedA2: boolean): AgentMessage[] =>
    historyRows(keyed, [
      ...(prefix ? PREFIX_ROWS : []),
      ["user", "Q1", "cm-1"],
      ["agent", "A1", "cm-1#agent"],
      ["user", "Q2", "cm-2"],
      ...(persistedA2 ? [["agent", "A2", "cm-2#agent"] as HistoryRowSpec] : []),
      ["user", "Q3", "cm-3"],
      ["agent", "A3", "cm-3#agent"],
    ]);

  async function q1StopQ2CutQ3(
    result: { current: ReturnType<typeof mount>["result"]["current"] },
    delivered: () => Promise<void>,
    prefix: boolean,
  ): Promise<void> {
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
  }

  const cases = [false, true].flatMap((keyed) =>
    [
      { name: "admitted only", opened: false, prefix: true },
      { name: "opened (turn.start of Q2 folded)", opened: true, prefix: true },
      { name: "admitted only, pure live", opened: false, prefix: false },
      { name: "opened, pure live", opened: true, prefix: false },
    ].map((c) => ({ ...c, keyed, rows: keyed ? "keyed rows" : "rows without keys" })),
  );

  it.each(cases)("draws A1 once, right after the adoption and after Q4 — Q2 $name, $rows", async ({ opened, prefix, keyed }) => {
    const cut = finishedTurn("turn_3", "A3").filter((c) => !c.startsWith("event: done"));
    const turns = [
      finishedTurn("turn_1", "A1"),
      stalledTurn("turn_2", opened),
      closing(cut),
      finishedTurn("turn_4", "A4"),
    ];
    const { result, delivered } = mount(turns, prefix ? PREFIX : [], adoptedHistory(prefix, keyed, false));
    await q1StopQ2CutQ3(result, delivered, prefix);

    const head = prefix ? ["user:H0", "agent:HA0"] : [];
    const answered = [...head, "user:Q1", "agent:A1", "user:Q2", "user:Q3", "agent:A3"];
    expect(drawn(planTranscript(result.current.inputs, calmPolicy()))).toEqual(answered);

    await act(async () => {
      await result.current.invoke.send("Q4");
    });
    expect(drawn(planTranscript(result.current.inputs, calmPolicy()))).toEqual([...answered, "user:Q4", "agent:A4"]);
  });

  /**
   * The pod kept running after the stop and stored Q2's answer. The fold
   * never saw any of it, so once history replaces the rows, history's A2 is
   * the only copy of Q2's reply: it is drawn under Q2, as a reload draws it.
   * Before the adoption the client does not know A2, and Q2 shows no reply.
   */
  it.each(cases)("draws history's A2 under Q2 when the pod stored it after the stop — Q2 $name, $rows", async ({ opened, prefix, keyed }) => {
    const cut = finishedTurn("turn_3", "A3").filter((c) => !c.startsWith("event: done"));
    const turns = [
      finishedTurn("turn_1", "A1"),
      stalledTurn("turn_2", opened),
      closing(cut),
      finishedTurn("turn_4", "A4"),
    ];
    const { result, delivered } = mount(turns, prefix ? PREFIX : [], adoptedHistory(prefix, keyed, true));
    await q1StopQ2CutQ3(result, delivered, prefix);

    const head = prefix ? ["user:H0", "agent:HA0"] : [];
    const answered = [...head, "user:Q1", "agent:A1", "user:Q2", "agent:A2", "user:Q3", "agent:A3"];
    expect(drawn(planTranscript(result.current.inputs, calmPolicy()))).toEqual(answered);

    await act(async () => {
      await result.current.invoke.send("Q4");
    });
    expect(drawn(planTranscript(result.current.inputs, calmPolicy()))).toEqual([...answered, "user:Q4", "agent:A4"]);
  });

  it("draws each answer once when the adopted history names no row and every send was answered", async () => {
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

/**
 * A turn adopted from history whose stream carried NO assistant frame: it
 * closed after the `session` frame, or after `turn.start` only (the
 * truncation path), or it got zero bytes and the pre-first-byte stall
 * watchdog adopted it. The fold holds nothing of Q2's reply, so history's A2
 * is its only copy: it is drawn once, under Q2, and stays there.
 */
describe("guuey#2445 — a turn adopted from history whose stream carried no assistant frame", () => {
  const paths = [
    { path: "the stream closes after its session frame", q2: (): string[] | ClosingTurn => closing([session]) },
    {
      path: "the stream closes after turn.start",
      q2: (): string[] | ClosingTurn => closing(stalledTurn("turn_2", true)),
    },
    { path: "the stall watchdog fires on zero bytes", q2: (): string[] | ClosingTurn => [], watchdog: true },
  ];
  const cases = paths.flatMap((p) =>
    [true, false].flatMap((prefix) =>
      [true, false].map((keyed) => ({
        ...p,
        prefix,
        keyed,
        name: `${prefix ? "after a reload" : "pure live"}, ${keyed ? "keyed rows" : "rows without keys"}`,
      })),
    ),
  );

  it.each(cases)("draws A2 once under Q2 when $path — $name", async ({ q2, watchdog, prefix, keyed }) => {
    const adopted = historyRows(keyed, [
      ...(prefix ? PREFIX_ROWS : []),
      ["user", "Q1", "cm-1"],
      ["agent", "A1", "cm-1#agent"],
      ["user", "Q2", "cm-2"],
      ["agent", "A2", "cm-2#agent"],
    ]);
    const turns = [finishedTurn("turn_1", "A1"), q2(), finishedTurn("turn_3", "A3")];
    const stall: false | StallRecoveryOptions = watchdog === true ? { preFirstByteWindowMs: 20 } : false;
    const { result } = mount(turns, prefix ? PREFIX : [], adopted, stall);
    if (prefix) {
      await waitFor(() => expect(result.current.invoke.messages.map((m) => m.text)).toEqual(["H0", "HA0"]));
    }
    await act(async () => {
      await result.current.invoke.send("Q1");
    });
    expect(result.current.invoke.adopted).toBe(false);
    await act(async () => {
      await result.current.invoke.send("Q2");
    });
    expect(result.current.invoke.adopted).toBe(true);
    expect(result.current.invoke.status).toBe("ready");
    expect(result.current.invoke.error).toBeNull();

    const head = prefix ? ["user:H0", "agent:HA0"] : [];
    const afterAdoption = planTranscript(result.current.inputs, calmPolicy());
    expect(drawn(afterAdoption)).toEqual([...head, "user:Q1", "agent:A1", "user:Q2", "agent:A2"]);
    // The adopted send is in history: it reads as sent, never as still sending.
    const states = afterAdoption.items.flatMap((it) => (it.kind === "user" ? [it.state] : []));
    expect(states).toEqual(prefix ? ["sent", "sent", "sent"] : ["sent", "sent"]);

    await act(async () => {
      await result.current.invoke.send("Q3");
    });
    expect(drawn(planTranscript(result.current.inputs, calmPolicy()))).toEqual([
      ...head,
      "user:Q1",
      "agent:A1",
      "user:Q2",
      "agent:A2",
      "user:Q3",
      "agent:A3",
    ]);
  });
});

/** A turn's AgEvent frames alone (no session, no done), its seq starting at `base`: several turns in one invoke. */
function answerFrames(turnId: string, text: string, base: number): string[] {
  const msg = `msg_${turnId}`;
  return [
    frame({ type: "turn.start", seq: base, turnId, threadId: THREAD }),
    frame({ type: "message.start", seq: base + 1, id: msg, turnId, threadId: THREAD, role: "assistant" }),
    frame({ type: "text.start", seq: base + 2, id: `${msg}:text:0`, messageId: msg, turnId }),
    frame({ type: "text.delta", seq: base + 3, id: `${msg}:text:0`, messageId: msg, delta: text, turnId }),
    frame({ type: "text.end", seq: base + 4, id: `${msg}:text:0`, messageId: msg, turnId }),
    frame({ type: "message.end", seq: base + 5, id: msg }),
    frame({ type: "turn.done", seq: base + 6, turnId, outcome: { type: "success", result: text }, finishReason: "stop" }),
  ];
}

/** The drawn rows with each notice in its place: `drawn`, plus `notice:<text>` rows. */
function drawnWithNotices(plan: TranscriptPlan): string[] {
  const out: string[] = [];
  for (const it of plan.items) {
    if (it.kind === "user") out.push(`user:${it.text}`);
    else if (it.kind === "text") out.push(`agent:${it.text}${it.stopped ? " [Stopped.]" : ""}`);
    else if (it.kind === "notice") out.push(`notice:${it.failure !== undefined ? "failure" : it.text}`);
  }
  return out;
}

type HistoryRow = Parameters<typeof threadHistoryRowsToMessages>[0][number];
/** Read-plane rows for a history read: `[role, text, key]`, or a failed turn's reader line. */
function readPlane(keyed: boolean, rows: Array<HistoryRowSpec | "failure">): AgentMessage[] {
  return threadHistoryRowsToMessages(
    rows.map((row, i): HistoryRow => {
      const base = { seq: i + 1, at: "2026-10-27T00:00:00Z", kind: "text" };
      if (row === "failure") {
        return { ...base, authorRole: "agent", text: "Something went wrong.", failure: { code: "INTERNAL" } };
      }
      const [authorRole, text, clientMessageId] = row;
      return { ...base, authorRole, text, ...(keyed ? { clientMessageId } : {}) };
    }),
  );
}

/**
 * Once an adoption has replaced the rows, history holds every row of the
 * conversation, and it is the authority for each one: its own place, a
 * failed turn's notice under that turn, a send this client never made with
 * its own reply. The fold still draws the replies it streamed for the sends
 * it can be tied to. Every case runs with keyed rows and with rows without
 * keys, and checks the transcript right after the adoption and after one
 * more answered send.
 */
describe("guuey#2445 — the adopted history places every row it holds", () => {
  const errorFrame = `event: error\ndata: ${JSON.stringify({ code: "INTERNAL", message: "boom" })}\n\n`;
  const failed = (turnId: string, opened: boolean): string[] => [
    ...stalledTurn(turnId, opened),
    errorFrame,
    "event: done\ndata: {}\n\n",
  ];
  const cutAfterAnswer = (turnId: string, text: string): ClosingTurn =>
    closing(finishedTurn(turnId, text).filter((c) => !c.startsWith("event: done")));

  async function sendAll(
    result: { current: ReturnType<typeof mount>["result"]["current"] },
    delivered: () => Promise<void>,
    sends: Array<{ text: string; stop?: true }>,
  ): Promise<void> {
    for (const { text, stop } of sends) {
      if (stop === true) {
        let pending: Promise<void> = Promise.resolve();
        await act(async () => {
          pending = result.current.invoke.send(text);
          await delivered();
        });
        await waitFor(() => expect(result.current.invoke.status).toBe("thinking"));
        await act(async () => {
          result.current.invoke.abort();
          await pending;
        });
      } else {
        await act(async () => {
          await result.current.invoke.send(text);
        });
      }
    }
  }
  const both = <T extends object>(cases: T[]) =>
    [true, false].flatMap((keyed) => cases.map((c) => ({ ...c, keyed, rows: keyed ? "keyed rows" : "rows without keys" })));

  it.each(both([{ name: "admitted only", opened: false }, { name: "opened", opened: true }]))(
    "draws a failed send's notice under that send — Q2 $name, $rows",
    async ({ opened, keyed }) => {
      const adopted = readPlane(keyed, [
        ["user", "Q1", "cm-1"],
        ["agent", "A1", "cm-1#agent"],
        ["user", "Q2", "cm-2"],
        "failure",
        ["user", "Q3", "cm-3"],
        ["agent", "A3", "cm-3#agent"],
      ]);
      const turns = [finishedTurn("turn_1", "A1"), failed("turn_2", opened), cutAfterAnswer("turn_3", "A3"), finishedTurn("turn_4", "A4")];
      const { result, delivered } = mount(turns, [], adopted);
      await sendAll(result, delivered, [{ text: "Q1" }, { text: "Q2" }, { text: "Q3" }]);
      expect(result.current.invoke.adopted).toBe(true);

      const answered = ["user:Q1", "agent:A1", "user:Q2", "notice:failure", "user:Q3", "agent:A3"];
      expect(drawnWithNotices(planTranscript(result.current.inputs, calmPolicy()))).toEqual(answered);
      await sendAll(result, delivered, [{ text: "Q4" }]);
      expect(drawnWithNotices(planTranscript(result.current.inputs, calmPolicy()))).toEqual([...answered, "user:Q4", "agent:A4"]);
    },
  );

  it.each(both([{ name: "a send answered in two turns" }]))(
    "draws a failed send's notice under that send after $name — $rows",
    async ({ keyed }) => {
      const adopted = readPlane(keyed, [
        ["user", "Q1", "cm-1"],
        ["agent", "A1", "cm-1#agent"],
        ["user", "Q2", "cm-2"],
        ["agent", "A2", "cm-2#agent"],
        ["agent", "A2b", "cm-2#agent-b"],
        ["user", "Q3", "cm-3"],
        "failure",
        ["user", "Q4", "cm-4"],
        ["agent", "A4", "cm-4#agent"],
      ]);
      const twoTurns = [session, ...answerFrames("turn_2", "A2", 0), ...answerFrames("turn_2b", "A2b", 7), "event: done\ndata: {}\n\n"];
      const turns = [
        finishedTurn("turn_1", "A1"),
        twoTurns,
        failed("turn_3", false),
        cutAfterAnswer("turn_4", "A4"),
        finishedTurn("turn_5", "A5"),
      ];
      const { result, delivered } = mount(turns, [], adopted);
      await sendAll(result, delivered, [{ text: "Q1" }, { text: "Q2" }, { text: "Q3" }, { text: "Q4" }]);
      expect(result.current.invoke.adopted).toBe(true);

      const answered = ["user:Q1", "agent:A1", "user:Q2", "agent:A2", "agent:A2b", "user:Q3", "notice:failure", "user:Q4", "agent:A4"];
      expect(drawnWithNotices(planTranscript(result.current.inputs, calmPolicy()))).toEqual(answered);
      await sendAll(result, delivered, [{ text: "Q5" }]);
      expect(drawnWithNotices(planTranscript(result.current.inputs, calmPolicy()))).toEqual([...answered, "user:Q5", "agent:A5"]);
    },
  );

  it.each(both([{ name: "sent from another tab on the same thread" }]))(
    "draws a send this client never made with its own reply — $name, $rows",
    async ({ keyed }) => {
      const adopted = readPlane(keyed, [
        ["user", "Q1", "cm-1"],
        ["agent", "A1", "cm-1#agent"],
        ["user", "QX", "cm-other-tab"],
        ["agent", "AX", "cm-other-tab#agent"],
        ["user", "Q2", "cm-2"],
        ["agent", "A2", "cm-2#agent"],
      ]);
      const turns = [finishedTurn("turn_1", "A1"), cutAfterAnswer("turn_2", "A2"), finishedTurn("turn_3", "A3")];
      const { result, delivered } = mount(turns, [], adopted);
      await sendAll(result, delivered, [{ text: "Q1" }, { text: "Q2" }]);
      expect(result.current.invoke.adopted).toBe(true);

      const answered = ["user:Q1", "agent:A1", "user:QX", "agent:AX", "user:Q2", "agent:A2"];
      expect(drawnWithNotices(planTranscript(result.current.inputs, calmPolicy()))).toEqual(answered);
      await sendAll(result, delivered, [{ text: "Q3" }]);
      expect(drawnWithNotices(planTranscript(result.current.inputs, calmPolicy()))).toEqual([...answered, "user:Q3", "agent:A3"]);
    },
  );

  /**
   * The `guuey dev` server stores a send's row only once its worker run
   * succeeds, and it stored the stopped Q2 with the answer its worker went on
   * to write. Q3's worker failed, so history holds no Q3 at all. History then
   * holds fewer user rows than the local transcript, so Q4's cut stream is not
   * adopted: it fails as cut, and the transcript keeps the rows this client
   * drew live, each answer once.
   */
  it.each(both([{ name: "admitted only", opened: false }, { name: "opened", opened: true }]))(
    "draws each answer once when history holds no row for a failed send — Q2 stopped $name, $rows",
    async ({ opened, keyed }) => {
      const later = readPlane(keyed, [
        ["user", "Q1", "cm-1"],
        ["agent", "A1", "cm-1#agent"],
        ["user", "Q2", "cm-2"],
        ["agent", "A2", "cm-2#agent"],
        ["user", "Q4", "cm-4"],
        ["agent", "A4", "cm-4#agent"],
      ]);
      const turns = [
        finishedTurn("turn_1", "A1"),
        stalledTurn("turn_2", opened),
        failed("turn_3", false),
        cutAfterAnswer("turn_4", "A4"),
        finishedTurn("turn_5", "A5"),
      ];
      const { result, delivered, rerender } = mount(turns, [], later);
      await sendAll(result, delivered, [{ text: "Q1" }, { text: "Q2", stop: true }, { text: "Q3" }]);
      // A short re-read window, so the cut Q4 is decided at once.
      rerender({ stallRecovery: { windowMs: 20 } });
      await sendAll(result, delivered, [{ text: "Q4" }]);
      expect(result.current.invoke.adopted).toBe(false);
      expect(result.current.invoke.errorCode).toBe("STREAM_TRUNCATED");

      const drawnLive = ["user:Q1", "agent:A1", "user:Q2", "user:Q3", "user:Q4", "agent:A4"];
      expect(drawnWithNotices(planTranscript(result.current.inputs, calmPolicy()))).toEqual(drawnLive);
      rerender({ stallRecovery: false });
      await sendAll(result, delivered, [{ text: "Q5" }]);
      expect(drawnWithNotices(planTranscript(result.current.inputs, calmPolicy()))).toEqual([...drawnLive, "user:Q5", "agent:A5"]);
    },
  );
});

/**
 * More than one adoption in a session. Each adoption sets history's rows; the
 * fold stays when every live send is tied to its row, and otherwise it is
 * dropped and the next send starts a new one. Either way the transcript draws
 * each answer once, under its own question, after every adoption.
 */
describe("guuey#2445 — a second adoption", () => {
  const cutAfterAnswer = (turnId: string, text: string): ClosingTurn =>
    closing(finishedTurn(turnId, text).filter((c) => !c.startsWith("event: done")));

  async function send(result: { current: ReturnType<typeof mount>["result"]["current"] }, text: string): Promise<void> {
    await act(async () => {
      await result.current.invoke.send(text);
    });
  }
  async function stop(
    result: { current: ReturnType<typeof mount>["result"]["current"] },
    delivered: () => Promise<void>,
    text: string,
  ): Promise<void> {
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.invoke.send(text);
      await delivered();
    });
    await waitFor(() => expect(result.current.invoke.status).toBe("thinking"));
    await act(async () => {
      result.current.invoke.abort();
      await pending;
    });
  }
  const cases = [true, false].flatMap((keyed) =>
    [true, false].map((prefix) => ({
      keyed,
      prefix,
      name: `${prefix ? "after a reload" : "pure live"}, ${keyed ? "keyed rows" : "rows without keys"}`,
    })),
  );

  it.each(cases)("draws each answer once after two adoptions, each after a stop — $name", async ({ keyed, prefix }) => {
    const head: HistoryRowSpec[] = prefix ? PREFIX_ROWS : [];
    const first: HistoryRowSpec[] = [
      ...head,
      ["user", "Q1", "cm-1"],
      ["agent", "A1", "cm-1#agent"],
      ["user", "Q2", "cm-2"],
      ["user", "Q3", "cm-3"],
      ["agent", "A3", "cm-3#agent"],
    ];
    const second: HistoryRowSpec[] = [
      ...first,
      ["user", "Q4", "cm-4"],
      ["user", "Q5", "cm-5"],
      ["agent", "A5", "cm-5#agent"],
    ];
    const turns = [
      finishedTurn("turn_1", "A1"),
      stalledTurn("turn_2", true),
      cutAfterAnswer("turn_3", "A3"),
      stalledTurn("turn_4", false),
      cutAfterAnswer("turn_5", "A5"),
      finishedTurn("turn_6", "A6"),
    ];
    const reads = { reads: [historyRows(keyed, first), historyRows(keyed, second)] };
    const { result, delivered } = mount(turns, prefix ? PREFIX : [], reads);
    if (prefix) {
      await waitFor(() => expect(result.current.invoke.messages.map((m) => m.text)).toEqual(["H0", "HA0"]));
    }
    await send(result, "Q1");
    await stop(result, delivered, "Q2");
    await send(result, "Q3");
    expect(result.current.invoke.adopted).toBe(true);
    const lead = prefix ? ["user:H0", "agent:HA0"] : [];
    const afterFirst = [...lead, "user:Q1", "agent:A1", "user:Q2", "user:Q3", "agent:A3"];
    expect(drawnWithNotices(planTranscript(result.current.inputs, calmPolicy()))).toEqual(afterFirst);

    await stop(result, delivered, "Q4");
    await send(result, "Q5");
    expect(result.current.invoke.adopted).toBe(true);
    const afterSecond = [...afterFirst, "user:Q4", "user:Q5", "agent:A5"];
    expect(drawnWithNotices(planTranscript(result.current.inputs, calmPolicy()))).toEqual(afterSecond);

    await send(result, "Q6");
    expect(drawnWithNotices(planTranscript(result.current.inputs, calmPolicy()))).toEqual([...afterSecond, "user:Q6", "agent:A6"]);
  });

  /**
   * The first adoption holds a send from another tab. Without keys it cannot
   * be tied to the local rows, so the fold is dropped and history draws the
   * conversation. The next sends start a new fold, and a second adoption,
   * after a stop, ties them to their rows again.
   */
  it.each(cases.filter((c) => !c.prefix))("draws each answer once when an adoption drops the fold and a later one keeps it — $name", async ({ keyed }) => {
    const first: HistoryRowSpec[] = [
      ["user", "Q1", "cm-1"],
      ["agent", "A1", "cm-1#agent"],
      ["user", "QX", "cm-other-tab"],
      ["agent", "AX", "cm-other-tab#agent"],
      ["user", "Q2", "cm-2"],
      ["agent", "A2", "cm-2#agent"],
    ];
    const second: HistoryRowSpec[] = [
      ...first,
      ["user", "Q3", "cm-3"],
      ["user", "Q4", "cm-4"],
      ["agent", "A4", "cm-4#agent"],
    ];
    const turns = [
      finishedTurn("turn_1", "A1"),
      cutAfterAnswer("turn_2", "A2"),
      stalledTurn("turn_3", true),
      cutAfterAnswer("turn_4", "A4"),
      finishedTurn("turn_5", "A5"),
    ];
    const { result, delivered } = mount(turns, [], { reads: [historyRows(keyed, first), historyRows(keyed, second)] });
    await send(result, "Q1");
    await send(result, "Q2");
    expect(result.current.invoke.adopted).toBe(true);
    // Keyed rows tie every live send, so the fold stays; without keys the
    // other tab's row breaks the tie, and history draws every row.
    expect(result.current.invoke.reduceResult === null).toBe(!keyed);
    const afterFirst = ["user:Q1", "agent:A1", "user:QX", "agent:AX", "user:Q2", "agent:A2"];
    expect(drawnWithNotices(planTranscript(result.current.inputs, calmPolicy()))).toEqual(afterFirst);

    await stop(result, delivered, "Q3");
    await send(result, "Q4");
    expect(result.current.invoke.reduceResult).not.toBeNull();
    const afterSecond = [...afterFirst, "user:Q3", "user:Q4", "agent:A4"];
    expect(drawnWithNotices(planTranscript(result.current.inputs, calmPolicy()))).toEqual(afterSecond);

    await send(result, "Q5");
    expect(drawnWithNotices(planTranscript(result.current.inputs, calmPolicy()))).toEqual([...afterSecond, "user:Q5", "agent:A5"]);
  });
});

/**
 * Like `mount`, but the transport for each send index in `throwOn` throws
 * before admission (a 503 before the pod stores the send).
 */
function mountThrowing(
  turns: Array<string[] | ClosingTurn>,
  throwOn: Set<number>,
  history: AgentMessage[],
  reloads: Reloads,
  stallRecovery: false | StallRecoveryOptions = false,
) {
  const a = adapters(turns, history, reloads);
  const inner = a.adapters.transport;
  let n = 0;
  const wrapped: AgentInvokeAdapters = {
    ...a.adapters,
    transport: (req: InvokeRequest) => {
      if (throwOn.has(n++)) {
        // eslint-disable-next-line require-yield -- a refusal happens before the first chunk
        return (async function* (): AsyncGenerator<string> {
          throw new Error("503 before admission");
        })();
      }
      return inner(req);
    },
  };
  const hook = renderHook(() => {
    const invoke = useAgentInvoke({
      endpointUrl: "https://pod.example.com",
      appId: "app-2445",
      adapters: wrapped,
      preserveBlocks: true,
      stallRecovery,
    });
    const { inputs } = useTranscriptInputs(invoke);
    return { invoke, inputs };
  });
  return { ...hook, delivered: a.delivered };
}

describe("guuey#2445 — an adoption that drops the fold, then the next send", () => {
  const show = (r: { current: { inputs: TranscriptInputs } }) => drawnWithNotices(planTranscript(r.current.inputs, calmPolicy()));
  const cutAfter = (turnId: string, text: string): ClosingTurn =>
    closing(finishedTurn(turnId, text).filter((c) => !c.startsWith("event: done")));

  it.each([true, false])(
    "prefix=%s: keyed history without an unstored send (and with another tab's turn) draws each answer once in its own place, now and after the next sends",
    async (prefix) => {
      const adopted = historyRows(true, [
        ...(prefix ? PREFIX_ROWS : []),
        ["user", "Q1", "cm-1"],
        ["agent", "A1", "cm-1#agent"],
        ["user", "QX", "cm-other"],
        ["agent", "AX", "cm-other#agent"],
        ["user", "Q3", "cm-3"],
        ["agent", "A3", "cm-3#agent"],
      ]);
      const turns = [finishedTurn("turn_1", "A1"), cutAfter("turn_3", "A3"), finishedTurn("turn_4", "A4"), finishedTurn("turn_5", "A5")];
      const { result } = mountThrowing(turns, new Set([1]), prefix ? PREFIX : [], adopted);
      if (prefix) await waitFor(() => expect(result.current.invoke.messages.map((m) => m.text)).toEqual(["H0", "HA0"]));
      await act(async () => {
        await result.current.invoke.send("Q1");
      });
      await act(async () => {
        await result.current.invoke.send("Q2");
      });
      await act(async () => {
        await result.current.invoke.send("Q3");
      });
      expect(result.current.invoke.adopted).toBe(true);
      const lead = prefix ? ["user:H0", "agent:HA0"] : [];
      const conversation = [...lead, "user:Q1", "agent:A1", "user:QX", "agent:AX", "user:Q3", "agent:A3"];
      expect(show(result)).toEqual(conversation);
      await act(async () => {
        await result.current.invoke.send("Q4");
      });
      expect(show(result)).toEqual([...conversation, "user:Q4", "agent:A4"]);
      await act(async () => {
        await result.current.invoke.send("Q5");
      });
      expect(show(result)).toEqual([...conversation, "user:Q4", "agent:A4", "user:Q5", "agent:A5"]);
    },
  );

  it("a kept-fold adoption, then a keyed adoption that drops it, then the next send", async () => {
    const first: HistoryRowSpec[] = [
      ["user", "Q1", "cm-1"],
      ["agent", "A1", "cm-1#agent"],
      ["user", "Q2", "cm-2"],
      ["agent", "A2", "cm-2#agent"],
    ];
    const second: HistoryRowSpec[] = [
      ...first,
      ["user", "QX", "cm-other"],
      ["agent", "AX", "cm-other#agent"],
      ["user", "Q4", "cm-4"],
      ["agent", "A4", "cm-4#agent"],
    ];
    const turns = [finishedTurn("turn_1", "A1"), cutAfter("turn_2", "A2"), cutAfter("turn_4", "A4"), finishedTurn("turn_5", "A5")];
    const { result } = mountThrowing(turns, new Set([2]), [], { reads: [historyRows(true, first), historyRows(true, second)] });
    for (const q of ["Q1", "Q2", "Q3", "Q4"]) {
      await act(async () => {
        await result.current.invoke.send(q);
      });
    }
    const conversation = ["user:Q1", "agent:A1", "user:Q2", "agent:A2", "user:QX", "agent:AX", "user:Q4", "agent:A4"];
    expect(show(result)).toEqual(conversation);
    await act(async () => {
      await result.current.invoke.send("Q5");
    });
    expect(show(result)).toEqual([...conversation, "user:Q5", "agent:A5"]);
  });
});

/** Every drawn row, top to bottom: a failed send and its Retry, notices, the error box, then the status line. */
function drawnAll(plan: TranscriptPlan): string[] {
  const out: string[] = [];
  for (const it of plan.items) {
    if (it.kind === "user") {
      out.push(`user:${it.text}${it.state === "failed" ? " (failed)" : ""}${it.retry ? " [Retry]" : ""}`);
    } else if (it.kind === "text") out.push(`agent:${it.text}${it.stopped ? " [Stopped.]" : ""}`);
    else if (it.kind === "notice") out.push(`notice:${it.failure !== undefined ? "failure" : it.text}`);
    else if (it.kind === "error") out.push(`error:${it.code ?? "none"}`);
  }
  if (plan.status !== null) out.push(`status:${plan.status.copy}`);
  return out;
}

type Mounted = { current: ReturnType<typeof mountThrowing>["result"]["current"] };
const showAll = (r: Mounted): string[] => drawnAll(planTranscript(r.current.inputs, calmPolicy()));
/** The drawn rows without the status line (a live send's "Thinking…" face). */
const rowsOnly = (r: Mounted): string[] => {
  const plan = planTranscript(r.current.inputs, calmPolicy());
  return drawnAll({ ...plan, status: null });
};
async function sendOne(r: Mounted, text: string): Promise<void> {
  await act(async () => {
    await r.current.invoke.send(text);
  });
}
/** Send `text`, read the plan while the send is admitted only (`thinking`), then press Stop. */
async function stopOne(r: Mounted, delivered: () => Promise<void>, text: string, whileThinking: string[]): Promise<void> {
  let pending: Promise<void> = Promise.resolve();
  await act(async () => {
    pending = r.current.invoke.send(text);
    await delivered();
  });
  await waitFor(() => expect(r.current.invoke.status).toBe("thinking"));
  expect(rowsOnly(r)).toEqual(whileThinking);
  await act(async () => {
    r.current.invoke.abort();
    await pending;
  });
  expect(r.current.invoke.aborted).toBe(true);
}
const errorBeforeTurnStart = [
  session,
  `event: error\ndata: ${JSON.stringify({ code: "INTERNAL", message: "boom" })}\n\n`,
  "event: done\ndata: {}\n\n",
];
const cutAfterItsAnswer = (turnId: string, text: string): ClosingTurn =>
  closing(finishedTurn(turnId, text).filter((c) => !c.startsWith("event: done")));

/** What the session holds before its first live send: a reloaded turn, or a reloaded greeting alone. */
const LEADS: Array<{ lead: string; rows: HistoryRowSpec[]; drawn: string[] }> = [
  { lead: "a reloaded turn", rows: PREFIX_ROWS, drawn: ["user:H0", "agent:HA0"] },
  { lead: "a reloaded greeting", rows: [["agent", "HG", "cm-hg#agent"]], drawn: ["agent:HG"] },
];

/**
 * A turn adopted from history while no fold exists yet: the send's stream
 * carried no AgEvent (it closed after its session frame, or got zero bytes
 * and the stall watchdog adopted it). The adopted rows keep the send's turn
 * stamp, which counts the turns of a fold that does not exist, so it says
 * nothing about where the row sits: history's own order places every row.
 */
describe("guuey#2445 — a turn adopted from history before any fold exists", () => {
  const paths: Array<{ path: string; turn: () => string[] | ClosingTurn; stall: false | StallRecoveryOptions }> = [
    { path: "the stream closes after its session frame", turn: () => closing([session]), stall: false },
    { path: "the stall watchdog fires on zero bytes", turn: () => [], stall: { preFirstByteWindowMs: 20 } },
  ];
  const keys = [true, false];

  it.each(paths.flatMap((p) => LEADS.flatMap((l) => keys.map((keyed) => ({ ...p, ...l, keyed, rowsName: keyed ? "keyed rows" : "rows without keys" })))))(
    "after $lead, draws the reloaded rows above Q1 and A1 under Q1 when $path — $rowsName",
    async ({ turn, stall, rows, drawn: lead, keyed }) => {
      const adopted = historyRows(keyed, [...rows, ["user", "Q1", "cm-1"], ["agent", "A1", "cm-1#agent"]]);
      const { result } = mount([turn(), finishedTurn("turn_2", "A2")], historyRows(keyed, rows), adopted, stall);
      await waitFor(() => expect(result.current.invoke.messages.length).toBe(rows.length));
      expect(showAll(result)).toEqual(lead);

      await sendOne(result, "Q1");
      expect(result.current.invoke.adopted).toBe(true);
      expect(result.current.invoke.status).toBe("ready");
      expect(result.current.invoke.error).toBeNull();
      const adoptedRows = [...lead, "user:Q1", "agent:A1"];
      expect(showAll(result)).toEqual(adoptedRows);

      await sendOne(result, "Q2");
      expect(showAll(result)).toEqual([...adoptedRows, "user:Q2", "agent:A2"]);
    },
  );

  it.each(paths.flatMap((p) => keys.map((keyed) => ({ ...p, keyed, rowsName: keyed ? "keyed rows" : "rows without keys" }))))(
    "pure live, two such adoptions in a row draw each answer under its own question when $path — $rowsName",
    async ({ turn, stall, keyed }) => {
      const first: HistoryRowSpec[] = [
        ["user", "Q1", "cm-1"],
        ["agent", "A1", "cm-1#agent"],
      ];
      const second: HistoryRowSpec[] = [...first, ["user", "Q2", "cm-2"], ["agent", "A2", "cm-2#agent"]];
      const reads = { reads: [historyRows(keyed, first), historyRows(keyed, second)] };
      const { result } = mount([turn(), turn(), finishedTurn("turn_3", "A3")], [], reads, stall);

      await sendOne(result, "Q1");
      expect(result.current.invoke.adopted).toBe(true);
      expect(showAll(result)).toEqual(["user:Q1", "agent:A1"]);

      await sendOne(result, "Q2");
      expect(result.current.invoke.adopted).toBe(true);
      expect(showAll(result)).toEqual(["user:Q1", "agent:A1", "user:Q2", "agent:A2"]);

      await sendOne(result, "Q3");
      expect(showAll(result)).toEqual(["user:Q1", "agent:A1", "user:Q2", "agent:A2", "user:Q3", "agent:A3"]);
    },
  );
});

/**
 * The first send after a reload ends before its first AgEvent: no fold
 * exists, so the reloaded rows keep their own order, and the send is drawn
 * after them, never between a reloaded question and its answer.
 */
describe("guuey#2445 — the first send after a reload ends before its first AgEvent", () => {
  const ends = [
    { end: "is stopped before its first token", how: "stop" as const },
    { end: "is refused before admission", how: "throw" as const },
    { end: "gets an error frame before turn.start", how: "error" as const },
  ];

  it.each(LEADS.flatMap((l) => ends.flatMap((e) => [true, false].map((keyed) => ({ ...l, ...e, keyed, rowsName: keyed ? "keyed rows" : "rows without keys" })))))(
    "after $lead, Q1 $end — $rowsName",
    async ({ rows, drawn: lead, how, keyed }) => {
      const reloaded = historyRows(keyed, rows);
      const turns =
        how === "stop"
          ? [stalledTurn("turn_1", false), finishedTurn("turn_2", "A2")]
          : how === "error"
            ? [errorBeforeTurnStart, finishedTurn("turn_2", "A2")]
            : [finishedTurn("turn_2", "A2")];
      const { result, delivered } = mountThrowing(turns, new Set(how === "throw" ? [0] : []), reloaded, reloaded);
      await waitFor(() => expect(result.current.invoke.messages.length).toBe(rows.length));

      if (how === "stop") await stopOne(result, delivered, "Q1", [...lead, "user:Q1"]);
      else await sendOne(result, "Q1");
      const q1 = how === "throw" ? "user:Q1 (failed) [Retry]" : "user:Q1";
      const marker = how === "stop" ? ["status:Stopped."] : how === "error" ? ["error:INTERNAL"] : [];
      expect(showAll(result)).toEqual([...lead, q1, ...marker]);

      await sendOne(result, "Q2");
      expect(showAll(result)).toEqual([...lead, q1, "user:Q2", "agent:A2"]);
    },
  );
});

/**
 * An adoption that drops the fold (history holds a turn from another tab the
 * local rows cannot be tied to), then a send that ends before its first
 * AgEvent. With the fold dropped the next send's stamp counts the turns of a
 * fold that does not exist yet, so history's order places the rows: the
 * adopted answer stays under its own question, never under the new one.
 */
describe("guuey#2445 — an adoption that drops the fold, then a send with no AgEvent", () => {
  const drops = [
    {
      rowsName: "rows without keys",
      keyed: false,
      // Q1 answered, Q2 cut after its answer and adopted: the other tab's QX1 breaks the keyless tie.
      prelude: { sends: ["Q1", "Q2"], turns: [finishedTurn("turn_1", "A1"), cutAfterItsAnswer("turn_2", "A2")], throws: [] as number[] },
      history: [
        ["user", "Q1", "cm-1"],
        ["agent", "A1", "cm-1#agent"],
        ["user", "QX1", "cm-other"],
        ["agent", "AX1", "cm-other#agent"],
        ["user", "Q2", "cm-2"],
        ["agent", "A2", "cm-2#agent"],
      ] satisfies HistoryRowSpec[],
      conversation: ["user:Q1", "agent:A1", "user:QX1", "agent:AX1", "user:Q2", "agent:A2"],
      next: 3,
    },
    {
      rowsName: "keyed rows",
      keyed: true,
      // Q1 answered, Q2 refused before admission (never stored), Q3 cut after its answer and adopted.
      prelude: { sends: ["Q1", "Q2", "Q3"], turns: [finishedTurn("turn_1", "A1"), cutAfterItsAnswer("turn_3", "A3")], throws: [1] },
      history: [
        ["user", "Q1", "cm-1"],
        ["agent", "A1", "cm-1#agent"],
        ["user", "QX1", "cm-other"],
        ["agent", "AX1", "cm-other#agent"],
        ["user", "Q3", "cm-3"],
        ["agent", "A3", "cm-3#agent"],
      ] satisfies HistoryRowSpec[],
      conversation: ["user:Q1", "agent:A1", "user:QX1", "agent:AX1", "user:Q3", "agent:A3"],
      next: 4,
    },
  ];
  type End = "stop" | "throw" | "error";
  const sequences: Array<{ seq: string; ends: End[] }> = [
    { seq: "stopped before its first token", ends: ["stop"] },
    { seq: "refused before admission", ends: ["throw"] },
    { seq: "given an error frame before turn.start", ends: ["error"] },
    { seq: "stopped before its first token, twice in a row", ends: ["stop", "stop"] },
  ];

  it.each(drops.flatMap((d) => sequences.map((s) => ({ ...d, ...s }))))(
    "the next send $seq draws the adopted answer under its own question — $rowsName",
    async ({ keyed, prelude, history, conversation, next, ends }) => {
      const turns: Array<string[] | ClosingTurn> = [...prelude.turns];
      const throws = new Set(prelude.throws);
      ends.forEach((end, i) => {
        if (end === "stop") turns.push(stalledTurn(`turn_${next + i}`, false));
        else if (end === "error") turns.push(errorBeforeTurnStart);
        else throws.add(prelude.sends.length + i);
      });
      const answeredN = next + ends.length;
      turns.push(finishedTurn(`turn_${answeredN}`, `A${answeredN}`));
      const { result, delivered } = mountThrowing(turns, throws, [], historyRows(keyed, history));

      for (const q of prelude.sends) await sendOne(result, q);
      expect(result.current.invoke.adopted).toBe(true);
      expect(result.current.invoke.reduceResult).toBeNull();
      expect(showAll(result)).toEqual(conversation);

      const settled: string[] = [];
      for (const [i, end] of ends.entries()) {
        const q = `Q${next + i}`;
        if (end === "stop") await stopOne(result, delivered, q, [...conversation, ...settled, `user:${q}`]);
        else await sendOne(result, q);
        const row = end === "throw" ? `user:${q} (failed) [Retry]` : `user:${q}`;
        const marker = end === "stop" ? ["status:Stopped."] : end === "error" ? ["error:INTERNAL"] : [];
        expect(showAll(result)).toEqual([...conversation, ...settled, row, ...marker]);
        settled.push(row);
      }

      await sendOne(result, `Q${answeredN}`);
      expect(showAll(result)).toEqual([...conversation, ...settled, `user:Q${answeredN}`, `agent:A${answeredN}`]);
    },
  );
});

/**
 * A send the client marked failed (its transport threw before admission),
 * which keyed history later shows was stored and answered. History is the
 * authority that a send was stored: once an adoption sets history's rows, the
 * send reads as sent and offers no Retry, which would send it twice.
 */
describe("guuey#2445 — a send marked failed that history shows was stored", () => {
  it.each([true, false])("draws Q2 as sent with no Retry once history holds it — keyed=%s", async (keyed) => {
    const adopted = historyRows(keyed, [
      ["user", "Q1", "cm-1"],
      ["agent", "A1", "cm-1#agent"],
      ["user", "Q2", "cm-2"],
      ["agent", "A2", "cm-2#agent"],
      ["user", "Q3", "cm-3"],
      ["agent", "A3", "cm-3#agent"],
    ]);
    const turns = [finishedTurn("turn_1", "A1"), cutAfterItsAnswer("turn_3", "A3"), finishedTurn("turn_4", "A4")];
    const { result } = mountThrowing(turns, new Set([1]), [], adopted);

    await sendOne(result, "Q1");
    await sendOne(result, "Q2");
    expect(showAll(result)).toEqual(["user:Q1", "agent:A1", "user:Q2 (failed) [Retry]"]);

    await sendOne(result, "Q3");
    expect(result.current.invoke.adopted).toBe(true);
    const conversation = ["user:Q1", "agent:A1", "user:Q2", "agent:A2", "user:Q3", "agent:A3"];
    expect(showAll(result)).toEqual(conversation);

    await sendOne(result, "Q4");
    expect(showAll(result)).toEqual([...conversation, "user:Q4", "agent:A4"]);
  });
});
