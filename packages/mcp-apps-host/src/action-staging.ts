/**
 * The post-turn action-STAGING policy (guuey#356 — lifted VERBATIM from the
 * widget's #198/#215/#218 civilization so every mount shares ONE copy).
 *
 * The beat it solves: after a turn completes there is no live turn to feed
 * a card action into — relaying would only surface the "agent not
 * listening" degradation at exactly the moment the agent's own copy
 * invited the tap. Instead, an ALLOWLISTED semantic action with an honest
 * text form stages a human-readable projection into the composer: one
 * Enter sends it as the next turn. Everything else — internal transport
 * rungs, foreign plumbing, shapes with no honest projection — rides the
 * exact pre-#198 relay/stub path, so fallback chains keep receiving the
 * in-band answers their rungs expect and raw plumbing never reaches the
 * composer (guuey#218's prod defect class).
 *
 * A staged answer is deliberately NOT `isError` (guuey#215): queueing is
 * an acceptance, and the error flag fed apps' legacy failure overlays.
 *
 * guuey#404 (the canvas wire ruling): the honest-projection refusal on a
 * REFERENCE-shaped dispatch (`{actionId, intent}` — a correlation hash,
 * params server-side in the consume pipe) is CORRECT behavior, not a gap.
 */
import { UI_SEMANTIC_ACTION_TOOLS, type McpToolCallResult, type McpToolStructuredContent } from "./action.js";
import type { UiActionRequest } from "./action.js";

/** The staged-acceptance notice a view receives instead of a relay answer. */
export const ACTION_STAGED_MSG = "Queued — press Send to continue.";

/**
 * guuey#198: the post-turn action policy's two host callbacks — when no
 * turn is live, a card action stages into the composer instead of dying in
 * the relay's degradation.
 */
export interface ActionStaging {
  /** A turn is currently in flight — the live relay path applies. */
  isTurnLive: () => boolean;
  /** Prefill the composer with the projection (append, never clobber) and focus it. */
  stage: (text: string) => void;
}

/**
 * guuey#218: ONLY an allowlisted semantic action may stage — keyed on the
 * SEMANTIC set ({@link UI_SEMANTIC_ACTION_TOOLS}), never the wider relay
 * allowlist, so a relayable transport rung is never stage-eligible.
 */
export function isStageableAction(name: string): boolean {
  return UI_SEMANTIC_ACTION_TOOLS.has(name);
}

/** "selectSlot" → "Select slot"; "book_slot" → "Book slot". */
function humanizeActionName(name: string): string {
  const words = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return words.length === 0 ? name : words[0].toUpperCase() + words.slice(1);
}

/** The protocol-open wire shape — same guard idiom as action.ts's. */
function isStructuredArgs(value: unknown): value is McpToolStructuredContent {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectAction(name: string, args: unknown): string | null {
  const title = humanizeActionName(name);
  if (args === undefined || args === null) return title;
  if (typeof args !== "object" || Array.isArray(args)) return null;
  const entries = Object.entries(args);
  if (entries.length === 0) return title;
  const pairs: string[] = [];
  for (const [key, value] of entries) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return null;
    }
    pairs.push(`${key} ${String(value)}`);
  }
  return `${title}: ${pairs.join(", ")}`;
}

/**
 * The human-readable projection of a card action — what lands in the
 * composer as the user's next message (guuey#198, option (b)). `null`
 * when the action shape has no honest text form (nested/non-primitive
 * arguments): projecting only part of the arguments could stage a
 * MISLEADING selection, so those degrade to the relay/stub path instead.
 *
 * guuey#215: a semantic-envelope call carries the USER'S action inside its
 * arguments (`actionId` + the action's own params), so the projection
 * unwraps the envelope — humanizing the carrier name would stage plumbing,
 * not the user's words. No string `actionId` ⇒ no honest projection ⇒
 * relay path.
 */
export function stagedActionText(name: string, args: unknown): string | null {
  if (UI_SEMANTIC_ACTION_TOOLS.has(name)) {
    if (!isStructuredArgs(args)) return null;
    const actionId = args["actionId"];
    if (typeof actionId !== "string" || actionId.length === 0) return null;
    const rest: McpToolStructuredContent = {};
    for (const [key, value] of Object.entries(args)) {
      if (key !== "actionId") rest[key] = value;
    }
    return projectAction(actionId, rest);
  }
  return projectAction(name, args);
}

/**
 * Wrap ANY `onCallTool`-shaped hook with the staging policy (guuey#356):
 * post-turn + allowlisted + honest projection → stage and answer the
 * STAGED notice; every other call — mid-turn, non-semantic, or
 * projection-less — delegates to `inner` byte-identically. A mount passes
 * two callbacks ({@link ActionStaging}) and gets the widget's exact
 * ratified behavior; `staging` absent returns `inner` unchanged, so the
 * wrap composes freely at construction sites.
 */
export function withActionStaging(
  inner: (request: UiActionRequest) => Promise<McpToolCallResult>,
  staging: ActionStaging | undefined,
): (request: UiActionRequest) => Promise<McpToolCallResult> {
  if (staging === undefined) return inner;
  return async (request) => {
    if (!staging.isTurnLive() && isStageableAction(request.name)) {
      const text = stagedActionText(request.name, request.arguments);
      if (text !== null) {
        staging.stage(text);
        return { content: [{ type: "text", text: ACTION_STAGED_MSG }] };
      }
    }
    return inner(request);
  };
}
