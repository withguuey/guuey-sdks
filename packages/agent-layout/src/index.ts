/**
 * `@guuey/agent-layout` — the agent-mode layout category (guuey#403).
 *
 * Root entry: the pure machine, the tone math, the token names, and the
 * `@guuey/chat` bridge — everything React-free. Components live under
 * `@guuey/agent-layout/react`; the stylesheet under
 * `@guuey/agent-layout/styles.css`.
 */

export {
  agentModeReduce,
  INITIAL_AGENT_MODE_STATE,
  type ActivePanel,
  type AgentModeInput,
  type AgentModeState,
} from "./machine.js";
export {
  assertToneFloor,
  DEFAULT_TONES,
  deriveTones,
  hexToLab,
  meetsToneFloor,
  mixHex,
  toneDelta,
  type TonePair,
} from "./tones.js";
export {
  bindGuueyChat,
  type AgentModeBinding,
  type GuueyChatActivityEventShape,
  type GuueyChatBindingProps,
  type PlanViewSummaryShape,
} from "./bind.js";

/**
 * The token vocabulary (§2) — one prefix, kebab-case, `-on` suffix keeps
 * each tone's pair adjacent in sorted listings (platform-ruled naming).
 * `--guuey-layout-pane-tone` is LIB-WRITTEN state: apps read it, never set
 * it — overriding it silently breaks the category's defining behavior.
 */
export const LAYOUT_TOKENS = {
  toneUpper: "--guuey-layout-tone-upper",
  toneUpperOn: "--guuey-layout-tone-upper-on",
  toneLower: "--guuey-layout-tone-lower",
  toneLowerOn: "--guuey-layout-tone-lower-on",
  paneTone: "--guuey-layout-pane-tone",
  toneTransition: "--guuey-layout-tone-transition",
} as const;

/**
 * The follow fade — founder-certified on the ggui#633 calibration: the
 * eased ~150ms color fade ("arrives fast, lands soft" at panel scale).
 */
export const DEFAULT_TONE_TRANSITION_MS = 150;
