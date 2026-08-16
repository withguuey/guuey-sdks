/**
 * invokeTurn — one agent turn as a pure async generator (guuey#186 G5).
 *
 * The per-turn loop `useAgentInvoke` runs — SSE accumulate → event switch →
 * cumulative text fold → AgJSON block ingest — used to exist only fused to
 * React state inside the hook, so a host with its own turn state machine
 * (a game loop, a native view model, a server-side driver) had to re-walk
 * the wire switch by hand. This module IS that loop, wire-in / semantics-out
 * and React-free: feed it the request and a transport, iterate
 * {@link InvokeTurnEvent}s. The hook is a thin wrapper that maps each event
 * onto its state setters — behaviour-identical, one walk of the switch,
 * owned here.
 *
 * Turn-scoped by design: the generator owns the CUMULATIVE assistant text
 * for this turn (every `message` event carries the full folded text so far,
 * not a delta). Cross-turn state stays with the caller — notably the AgJSON
 * `Reducer`, which folds an entire conversation: this generator yields each
 * frame's validated `agEvents` and never touches a reducer.
 *
 * Transport failures (e.g. `AgentResponseError` on a pre-stream refusal)
 * propagate out of iteration — catch around the `for await`, exactly as the
 * hook does. Unknown SSE events yield nothing, matching the hook's silent
 * fall-through, so new wire events are additive for every consumer.
 */
import type { AgEvent } from "@silverprotocol/core";
import { parseLinkRequest, parseSseEvents, reduceAssistantText, stringField } from "./sse.js";
import { ingestMessageFrame } from "./blocks.js";
import type { AgentInvokeStatus, InvokeRequest, InvokeTransport, ProfileLinkRequest } from "./types.js";

/**
 * One semantic step of a turn. Field conventions:
 *
 * - `message.status` / `message.activeTool` are ABSENT (not null) when the
 *   frame implies no change — apply them only when present, so an unknown
 *   frame type leaves your state machine untouched (the hook's exact rule:
 *   only `tool.start`/`tool.done` ever move `activeTool`, and a text frame
 *   moving status to `responding` does NOT clear a lingering tool name).
 * - `message.assistantText` is the full folded text of the turn so far —
 *   render it as-is on every event; there is no delta bookkeeping to do.
 * - `message.agEvents` are the frame's validated AgJSON events (empty for
 *   bypass frames) — push them into your own cross-turn `Reducer` if you
 *   keep a block-preserving transcript, ignore them otherwise.
 */
export type InvokeTurnEvent =
  | { kind: "session"; threadId: string | null }
  | {
      kind: "message";
      status?: Extract<AgentInvokeStatus, "thinking" | "using-tool" | "responding">;
      activeTool?: string | null;
      assistantText: string;
      agEvents: AgEvent[];
    }
  | { kind: "error"; message: string; code: string | null }
  | { kind: "profile-link"; request: ProfileLinkRequest }
  | { kind: "done"; stopReason: string | null };

/**
 * Normalize an agent endpoint to its invoke URL (guuey#186 G3). Accepts BOTH
 * shapes a consumer legitimately holds — a pod base (`https://host`) and the
 * full invoke URL the deploy-controller records (`https://host/agent/invoke`)
 * — and returns exactly one `/agent/invoke`, trailing slashes dropped. This
 * is the single normalization `useAgentInvoke` applies to its `endpointUrl`;
 * a host driving {@link invokeTurn} (or any raw transport) directly builds
 * its request URL with the same call instead of re-implementing the rule.
 */
export function toInvokeUrl(endpointUrl: string): string {
  const base = endpointUrl.replace(/\/+$/, "");
  return base.endsWith("/agent/invoke") ? base : `${base}/agent/invoke`;
}

/**
 * Drive one `/agent/invoke` turn over `transport`, yielding semantic events.
 * Pure per-turn: no React, no storage, no retry policy (the transport owns
 * saturation retry), no reducer — see the module docblock for what belongs
 * to the caller.
 *
 * The event stream is also the OBSERVATION channel (guuey#186 Gap 4): there
 * is deliberately no `onToolResult` callback API, because filtering the
 * generator expresses it directly — every tool result arrives as a typed
 * `tool.done` AgEvent on a `message` event, carrying `toolCallId`,
 * `content`, `outcome` and `structuredContent`.
 *
 * @example Telemetry off the fold — observe tool results without touching
 * the transcript path:
 * ```ts
 * for await (const ev of invokeTurn(req, transport)) {
 *   if (ev.kind !== "message") continue;
 *   for (const agEvent of ev.agEvents) {
 *     if (agEvent.type === "tool.done") {
 *       telemetry.record(agEvent.toolCallId, agEvent.outcome ?? "ok");
 *     }
 *   }
 *   render(ev.assistantText); // the fold is untouched by the observation
 * }
 * ```
 */
export async function* invokeTurn(
  req: InvokeRequest,
  transport: InvokeTransport,
): AsyncGenerator<InvokeTurnEvent> {
  let assistantText = "";
  let buffer = "";
  for await (const chunk of transport(req)) {
    buffer += chunk;
    const { events, rest } = parseSseEvents(buffer);
    buffer = rest;
    for (const ev of events) {
      if (ev.event === "session") {
        // The pod is awake and the turn is admitted (this frame arrives
        // within ~1s of a warm pod; a cold scale-to-zero start is exactly
        // the long wait before it).
        yield { kind: "session", threadId: stringField(ev.data, "threadId") ?? null };
      } else if (ev.event === "message") {
        // Status derivation (guuey#91) — read the frame's `type` before the
        // text fold. Silver frames announce tools + text explicitly; bypass
        // frames ('text' / 'assistant' SDKMessages) only ever carry
        // assistant text, so they map to 'responding'. Unknown types
        // deliberately imply no status change.
        const frameType = stringField(ev.data, "type");
        assistantText = reduceAssistantText(assistantText, ev.data);
        // Only VALID AgEvents surface (bypass frames ingest to []) — the
        // caller's reducer, if any, advances on these alone.
        const agEvents = ingestMessageFrame(ev.data);
        if (frameType === "tool.start") {
          yield {
            kind: "message",
            status: "using-tool",
            activeTool: stringField(ev.data, "name") ?? null,
            assistantText,
            agEvents,
          };
        } else if (frameType === "tool.done") {
          yield { kind: "message", status: "thinking", activeTool: null, assistantText, agEvents };
        } else if (
          frameType === "text.start" ||
          frameType === "text.delta" ||
          frameType === "text" ||
          frameType === "assistant"
        ) {
          yield { kind: "message", status: "responding", assistantText, agEvents };
        } else {
          yield { kind: "message", assistantText, agEvents };
        }
      } else if (ev.event === "error") {
        // In-band failure frame — one of the two channels that carry the
        // pod's wire code (the other is the pre-stream refusal thrown by the
        // transport). A frame without a `code` yields null rather than
        // leaving a previous turn's code standing beside a new message.
        yield {
          kind: "error",
          message: stringField(ev.data, "message") ?? "agent error",
          code: stringField(ev.data, "code") ?? null,
        };
      } else if (ev.event === "profile-link-needed") {
        // Cross-app profile LINK invite (linkcoh T3) for an unlinked byo
        // caller. Only a well-formed payload yields; a malformed one is
        // dropped, leaving any prior valid request untouched (never clobbered
        // to null). (Consent is NOT a bespoke event: it rides the AgJSON fold
        // as `hitl.ask` + `turn.done outcome:"paused"` — guuey#207.)
        const parsed = parseLinkRequest(ev.data);
        if (parsed) yield { kind: "profile-link", request: parsed };
      } else if (ev.event === "done") {
        // The stream closes after this frame; yielded so a host can read the
        // pod's stop reason without private wire knowledge.
        yield { kind: "done", stopReason: stringField(ev.data, "stopReason") ?? null };
      }
      // Any other (unknown) event falls through silently — additive wire
      // events never disturb a consumer.
    }
  }
}
