/**
 * The `@guuey/chat` bridge (guuey#403 §4) — pairs with the kit WITHOUT
 * importing it. This package deliberately has NO dependency on
 * `@guuey/chat` (the layout stays consumable by a surface that brings its
 * own agent — ggui console's path calls `agentSubmit()` from
 * `useAgentMode()` directly), so the kit's shapes are mirrored here
 * STRUCTURALLY, the fs-contract discipline:
 *
 *  - {@link GuueyChatActivityEventShape} mirrors `GuueyChatActivityEvent`
 *    (oss/packages/chat/src/react/guuey-chat.tsx — sync comment on the
 *    definition points back here);
 *  - {@link PlanViewSummaryShape} mirrors the two fields of
 *    `PlanViewSummary` this bridge reads (`key`, `origin`).
 *
 * The template's typecheck is the seam prover: it passes GuueyChat's real
 * callbacks into these structural slots — a drift on either side breaks
 * the template build, never silently.
 */
import type { AgentModeInput } from "./machine.js";

/**
 * Structural mirror of `GuueyChatActivityEvent` (@guuey/chat). `submit`
 * fires on every successful send — composer, `handle.send`, and the
 * `ui/message` doorbell paths alike; `settled` fires when the invoke
 * returns to `ready` (success, error, and abort all settle).
 */
export interface GuueyChatActivityEventShape {
  type: "submit" | "settled";
}

/** The two roster fields the bridge reads (structural `PlanViewSummary`). */
export interface PlanViewSummaryShape {
  key: string;
  origin: "live" | "history";
}

/** What the bridge needs from the layout side — `useAgentMode().dispatch`. */
export type AgentModeBinding = (input: AgentModeInput) => void;

/** The GuueyChat-shaped props {@link bindGuueyChat} returns. */
export interface GuueyChatBindingProps {
  onActivity: (event: GuueyChatActivityEventShape) => void;
  onViewsChange: (views: readonly PlanViewSummaryShape[]) => void;
}

/**
 * Wire a GuueyChat surface into the active-panel machine: spread the
 * returned props onto `<GuueyChat>` (or compose them inside your own
 * handlers — each is a plain function).
 *
 *  - `submit` → `agentSubmit` (tone flips ON SUBMIT — the §3 law);
 *  - `settled` → `agentSettled` (no tone transition; ends the working
 *    state and the streaming flag);
 *  - a roster change whose LIVE view count GREW → `agentViewMounted`
 *    (the founder's (d): content replaced the working state). Counting
 *    growth — not presence — keeps earlier turns' lingering live views
 *    and rehydrated history views from clearing a fresh submit's pending
 *    window spuriously.
 */
export function bindGuueyChat(dispatch: AgentModeBinding): GuueyChatBindingProps {
  let liveCount = 0;
  return {
    onActivity: (event) => {
      if (event.type === "submit") dispatch({ type: "agentSubmit" });
      else dispatch({ type: "agentSettled" });
    },
    onViewsChange: (views) => {
      const next = views.filter((v) => v.origin === "live").length;
      if (next > liveCount) dispatch({ type: "agentViewMounted" });
      liveCount = next;
    },
  };
}
