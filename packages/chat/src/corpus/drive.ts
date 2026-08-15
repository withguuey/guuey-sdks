/**
 * The corpus's turn driver: recorded `InvokeTurnEvent[]` sequences →
 * `TranscriptInputs`, applying the SAME accumulation rules the live hook
 * documents (status transitions, cumulative text, agEvents → the REAL
 * `@silverprotocol/core` Reducer). Test-only plumbing — excluded from the
 * build; the 3b live/history assemblers are the production twins.
 */
import { Reducer, type AgEvent } from "@silverprotocol/core";
import type { InvokeTurnEvent } from "@guuey/agent-client";
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
  /** Resolve accumulated prompts to this state (fixture 4's answered leg). */
  promptState?: ProfilePromptInput["state"];
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
      case "profile-consent":
        prompts.push({
          id: `consent-${prompts.length}`,
          kind: "consent",
          appId: ev.request.appId,
          requested: ev.request.requested,
          state: opts.promptState ?? "pending",
        });
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
    prompts,
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

export const session: InvokeTurnEvent = { kind: "session", threadId: THREAD };
export const doneEvent: InvokeTurnEvent = { kind: "done", stopReason: "end_turn" };
