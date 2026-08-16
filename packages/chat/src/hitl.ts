/**
 * R10's AgJSON HITL half (spec draft.2, silverprotocol/typescript-sdk#16):
 * lifting persisted asks out of the fold, and constructing validated
 * answers.
 *
 * Two contract points are load-bearing here:
 *
 *  - **Asks render from the PERSISTED declaration** — `AgPausedAsk` in
 *    `turn.done.outcome:"paused".asks[]`. The live `hitl.ask` event is
 *    live-only by spec (§1.3); a client that joins a thread late renders
 *    the paused record, so this module reads ONLY that record and both
 *    paths converge.
 *  - **Every answer is validated BEFORE dispatch** — `validateHitlAnswer`
 *    from core enforces required-iff-declared, echo-must-be-declared, and
 *    the `requestState` byte-echo MUST. `buildHitlAnswer` constructs
 *    answers that pass by construction and THROWS if they don't: a failed
 *    validation here is a kit bug, never a user-visible state.
 *
 * Answer states encode guuey's ratified dismissal ruling (#16): dismissal
 * maps to `cancelled` (still-pending, re-askable — the card stays
 * answerable), `declined` is the durable explicit deny.
 *
 * The first producer is the guuey runtime's cross-app profile consent
 * (guuey#207): the pod appends a paused turn whose ask declares
 * `grantModes: [always, once?]`; the host delivers the built answer through
 * `@guuey/agent-client`'s `createHitlAnswerRelay` (`POST <pod>/agent/hitl-answer`).
 */
import {
  validateHitlAnswer,
  type AgGrantMode,
  type AgHitlAnswer,
  type AgPausedAsk,
  type AgReduceResult,
} from "@silverprotocol/core";
import type { HitlPromptInput } from "./types.js";

/** A host-side record of how an ask was answered (the assembler's ledger value). */
export interface HitlAnswerRecord {
  status: "resolved" | "declined" | "cancelled";
  /** Present iff `status === "resolved"` and the ask declared modes. */
  grantModeId?: string;
}

/** A user action on a HITL card: pick a declared mode, decline, or dismiss. */
export type HitlPromptAction = { grantModeId: string } | "accept" | "decline" | "dismiss";

/**
 * Display text for a grant mode: the asker's `label`, else the id as
 * LITERAL text. Mode semantics are asker-scoped (normative, spec §7):
 * falling back to the id displays identity, never interpreted meaning —
 * a renderer must not special-case id strings.
 */
export function grantModeDisplay(mode: AgGrantMode): string {
  return mode.label ?? mode.id;
}

/**
 * Lift every persisted ask in the fold into an R10 prompt input, merged
 * with the host's answer ledger (keyed by askId). Pure; input order is the
 * fold's turn order.
 */
export function hitlPromptsFromFold(
  result: AgReduceResult | null,
  answers: Readonly<Record<string, HitlAnswerRecord>> = {},
): HitlPromptInput[] {
  if (result === null) return [];
  const prompts: HitlPromptInput[] = [];
  for (const turn of result.turns) {
    if (turn.outcome?.type !== "paused") continue;
    for (const ask of turn.outcome.asks) {
      const answer = answers[ask.askId];
      prompts.push({
        id: ask.askId,
        kind: "hitl",
        ask,
        state: answer?.status ?? "pending",
        ...(answer?.grantModeId !== undefined ? { grantModeId: answer.grantModeId } : {}),
      });
    }
  }
  return prompts;
}

/**
 * Construct the wire answer for a card action and validate it against the
 * ask's own persisted record before anything dispatches it.
 *
 * `"accept"` is the plain-ask affirmative (valid only when the ask
 * declared no modes — with a declaration, accepting IS picking a mode).
 * A validation failure throws: the inputs came from the declaration
 * itself, so a mismatch is a construction bug, not a user error.
 */
export function buildHitlAnswer(ask: AgPausedAsk, action: HitlPromptAction): AgHitlAnswer {
  const answer: AgHitlAnswer = {
    askId: ask.askId,
    status:
      action === "decline" ? "declined" : action === "dismiss" ? "cancelled" : "resolved",
    ...(typeof action === "object" ? { grantModeId: action.grantModeId } : {}),
    // The pre-existing byte-echo MUST (spec §7): the answer carries the
    // ask's requestState verbatim when one exists.
    ...(ask.requestState !== undefined ? { requestState: ask.requestState } : {}),
  };
  const verdict = validateHitlAnswer(ask, answer);
  if (!verdict.ok) {
    throw new Error(`buildHitlAnswer constructed an invalid answer (${verdict.code}): ${verdict.message}`);
  }
  return answer;
}
