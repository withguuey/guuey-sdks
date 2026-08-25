/**
 * The active-panel machine (guuey#403 §3) — pure data-in/data-out, no React.
 *
 * ONE law (platform's words): **layout follows attention; transport owns
 * the stream.** The tone tracks the user's locus of action — submit flips
 * it ON SUBMIT (not first token, not completion), navigation flips it back,
 * and stream end changes nothing.
 *
 * State beyond the panel itself (the ggui#633 calibration additions):
 *
 *  - `streaming` — a turn is in flight. Read by ONE rule only: closing an
 *    agent view returns to the menu UNLESS still streaming (the console's
 *    shipped behavior).
 *  - `pending` — the founder's (d) requirement: on flip to the agent tone
 *    with no view mounted yet, the pane must NEVER hold prior page content
 *    on the agent ground — it presents the working state immediately.
 *    `pending` arms on submit and clears on view-mount, on settle (the
 *    answer is in the log even when no view came), and on return-to-menu.
 *
 * The machine is consumed through `useAgentMode()` / the Provider; this
 * module is exported for tests and for non-React hosts that want the exact
 * transition table.
 */

export type ActivePanel = "app" | "agent";

export interface AgentModeState {
  activePanel: ActivePanel;
  /** A turn is in flight (submit → settled). */
  streaming: boolean;
  /** Working-state window: submitted, nothing presented yet (founder (d)). */
  pending: boolean;
}

export const INITIAL_AGENT_MODE_STATE: AgentModeState = {
  // A surface opens as the app; the agent earns the room by being addressed.
  activePanel: "app",
  streaming: false,
  pending: false,
};

export type AgentModeInput =
  /** App-side chrome interaction (NavLink click, panel focus) OR a route change. */
  | { type: "menuInteraction" }
  /** The user sent a message — the agent bridge fired. */
  | { type: "agentSubmit" }
  /**
   * Give the agent panel the room WITHOUT claiming a submit happened
   * (guuey#427, the first consumer's near-miss): a host reopening the
   * agent surface (restoring a view, a deep link) wants the tone flip
   * and NOTHING else — arming the working state here would leave a
   * permanent spinner, since no turn will ever mount a view or settle.
   */
  | { type: "agentPanelActivated" }
  /** The turn reached `ready`. NO panel transition (platform-ruled: no bounce-back). */
  | { type: "agentSettled" }
  /** A live view mounted — the working state has been replaced by content. */
  | { type: "agentViewMounted" }
  /** The user closed an agent view (canvas "back" affordance). */
  | { type: "agentViewClosed" };

/**
 * The transition table (§3, verbatim rules). Pure; last input wins — the
 * transition duration is the only debounce (no timers, no queue).
 */
export function agentModeReduce(state: AgentModeState, input: AgentModeInput): AgentModeState {
  switch (input.type) {
    case "menuInteraction":
      // Re-follows the user WITHOUT touching the stream (mid-stream click
      // included — interruption semantics live in transport, never here).
      return { ...state, activePanel: "app", pending: false };
    case "agentSubmit":
      return { activePanel: "agent", streaming: true, pending: true };
    case "agentPanelActivated":
      // The neutral flip: panel only — streaming/pending untouched.
      return { ...state, activePanel: "agent" };
    case "agentSettled":
      // Stream end changes nothing about the panel — the tone tracks the
      // user's locus of action, not the agent's state.
      return { ...state, streaming: false, pending: false };
    case "agentViewMounted":
      return { ...state, pending: false };
    case "agentViewClosed":
      // Closing a view returns to the menu UNLESS still streaming.
      return state.streaming ? state : { ...state, activePanel: "app" };
  }
}
