/**
 * The corpus's turn driver: recorded `InvokeTurnEvent[]` sequences →
 * `TranscriptInputs`, applying the SAME accumulation rules the live hook
 * documents (status transitions, cumulative text, agEvents → the REAL
 * `@silverprotocol/core` Reducer). Test-only plumbing — excluded from the
 * build; the 3b live/history assemblers are the production twins.
 */
import { Reducer, type AgEvent, type AgPausedAsk } from "@silverprotocol/core";
import type { InvokeTurnEvent } from "@guuey/agent-client";
import { hitlPromptsFromFold, type HitlAnswerRecord } from "../hitl.js";
import type { ProfilePromptInput, TranscriptInputs, TranscriptMessage } from "../types.js";

export interface DriveOptions {
  userText?: string;
  clientMessageId?: string;
  /** Override the derived status (mid-stream plan points). */
  finalStatus?: TranscriptInputs["status"];
  statusElapsedMs?: number;
  aborted?: boolean;
  adopted?: boolean;
  sendStates?: TranscriptInputs["sendStates"];
  viewPhases?: TranscriptInputs["viewPhases"];
  historyCards?: TranscriptInputs["historyCards"];
  historyState?: TranscriptInputs["historyState"];
  /** Resolve accumulated link prompts to this state. */
  promptState?: ProfilePromptInput["state"];
  /** The host-side answer ledger for AgJSON hitl asks (fixture 4's answered leg). */
  hitlAnswers?: Readonly<Record<string, HitlAnswerRecord>>;
}

export function driveTurn(events: InvokeTurnEvent[], opts: DriveOptions = {}): TranscriptInputs {
  const reducer = new Reducer();
  let sawAgEvents = false;
  let status: TranscriptInputs["status"] = "connecting";
  let assistantText = "";
  let activeTool: string | null = null;
  let error: TranscriptInputs["error"] = null;
  const prompts: ProfilePromptInput[] = [];
  let done = false;

  for (const ev of events) {
    switch (ev.kind) {
      case "session":
        if (status === "connecting") status = "thinking";
        break;
      case "message":
        if (ev.status !== undefined) status = ev.status;
        if (ev.activeTool !== undefined) activeTool = ev.activeTool;
        assistantText = ev.assistantText;
        for (const ag of ev.agEvents) {
          sawAgEvents = true;
          reducer.push(ag);
        }
        break;
      case "error":
        error = { message: ev.message, code: ev.code };
        status = "ready";
        break;
      case "profile-link":
        prompts.push({
          id: `link-${prompts.length}`,
          kind: "link",
          appId: ev.request.appId,
          requested: ev.request.requested,
          state: opts.promptState ?? "pending",
        });
        break;
      case "done":
        done = true;
        status = "ready";
        activeTool = null;
        break;
    }
  }
  if (opts.aborted === true) status = "ready";

  const messages: TranscriptMessage[] = [];
  if (opts.userText !== undefined) {
    messages.push({
      role: "user",
      text: opts.userText,
      ...(opts.clientMessageId !== undefined ? { clientMessageId: opts.clientMessageId } : {}),
    });
  }
  // A settled BYPASS turn's text moves into the flat transcript (the hook's
  // behaviour); silver turns stay owned by the fold.
  if (done && !sawAgEvents && assistantText !== "" && opts.aborted !== true) {
    messages.push({ role: "assistant", text: assistantText });
  }

  return {
    result: sawAgEvents ? reducer.result() : null,
    assistantText,
    status: opts.finalStatus ?? status,
    statusElapsedMs: opts.statusElapsedMs ?? 0,
    activeTool,
    error,
    // The link ledger + the AgJSON hitl asks lifted from the fold — the
    // live assembler's exact composition (use-transcript.ts).
    prompts: [...prompts, ...hitlPromptsFromFold(sawAgEvents ? reducer.result() : null, opts.hitlAnswers ?? {})],
    messages,
    ...(opts.sendStates !== undefined ? { sendStates: opts.sendStates } : {}),
    ...(opts.viewPhases !== undefined ? { viewPhases: opts.viewPhases } : {}),
    ...(opts.historyCards !== undefined ? { historyCards: opts.historyCards } : {}),
    ...(opts.historyState !== undefined ? { historyState: opts.historyState } : {}),
    ...(opts.aborted === true ? { aborted: true } : {}),
    ...(opts.adopted === true ? { adopted: true } : {}),
  };
}

// ─── Event builders (shared fixture vocabulary) ───────────────────────────

export const THREAD = "thread-corpus";
export const TURN = "turn-corpus";
export const MSG = "msg-corpus";

/** A per-fixture monotonically increasing seq source. */
export function seqSource(): () => number {
  let n = 0;
  return () => n++;
}

/** The silver turn's lifecycle boot: turn.start + an open assistant message. */
export function boot(next: () => number): AgEvent[] {
  return [
    { type: "turn.start", threadId: THREAD, turnId: TURN, seq: next() },
    { type: "message.start", id: MSG, role: "assistant", turnId: TURN, threadId: THREAD, seq: next() },
  ];
}

/** A complete streamed text part. */
export function textPart(next: () => number, id: string, text: string): AgEvent[] {
  return [
    { type: "text.start", id, seq: next() },
    { type: "text.delta", id, delta: text, seq: next() },
    { type: "text.end", id, seq: next() },
  ];
}

/** A complete tool call: start + assembled args + done. */
export function toolPart(
  next: () => number,
  toolCallId: string,
  name: string,
  result: Partial<Extract<AgEvent, { type: "tool.done" }>> = {},
): AgEvent[] {
  return [
    { type: "tool.start", toolCallId, name, seq: next() },
    { type: "tool.args.assembled", toolCallId, input: { q: name }, seq: next() },
    {
      type: "tool.done",
      toolCallId,
      content: [{ type: "text", text: "ok" }],
      outcome: "ok",
      ...result,
      seq: next(),
    },
  ];
}

/** Wrap agEvents into the `message` frame the pod emits. */
export function frame(
  agEvents: AgEvent[],
  extra: {
    status?: "thinking" | "using-tool" | "responding";
    activeTool?: string | null;
    text?: string;
  } = {},
): InvokeTurnEvent {
  return {
    kind: "message",
    ...(extra.status !== undefined ? { status: extra.status } : {}),
    ...(extra.activeTool !== undefined ? { activeTool: extra.activeTool } : {}),
    assistantText: extra.text ?? "",
    agEvents,
  };
}

/**
 * The runtime's cross-app profile consent ask (guuey#207) — the paused turn
 * the pod appends AFTER the agent's own turn: `turn.start` → `hitl.ask` →
 * `turn.done outcome:"paused"` carrying the same `AgPausedAsk`. Mirrors
 * `nocode-runtime/src/profile-consent.ts` byte-for-byte in shape.
 */
export const CONSENT_ASK: AgPausedAsk = {
  askId: "profile-consent:app-1:thread-corpus",
  kind: "approval",
  message: "Trip Planner wants to read your guuey profile — the notes agents keep about you across apps.",
  grantModes: [
    { id: "always", label: "Always allow", description: "Every conversation with this agent" },
    { id: "once", label: "Allow this chat", description: "Only this conversation" },
  ],
  metadata: { appId: "app-1", requested: "read" },
};
export function consentTurn(next: () => number, ask: AgPausedAsk = CONSENT_ASK): AgEvent[] {
  const turnId = `${ask.askId}#turn`;
  return [
    { type: "turn.start", threadId: THREAD, turnId, seq: next() },
    {
      type: "hitl.ask",
      turnId,
      askId: ask.askId,
      kind: ask.kind,
      ...(ask.message !== undefined ? { message: ask.message } : {}),
      ...(ask.grantModes !== undefined ? { grantModes: ask.grantModes } : {}),
      ...(ask.metadata !== undefined ? { metadata: ask.metadata } : {}),
      continuation: "turn",
      seq: next(),
    },
    { type: "turn.done", turnId, finishReason: "paused", outcome: { type: "paused", asks: [ask] }, seq: next() },
  ];
}

export const session: InvokeTurnEvent = { kind: "session", threadId: THREAD };
export const doneEvent: InvokeTurnEvent = { kind: "done", stopReason: "end_turn" };
