/**
 * `@guuey/agent-layout/react` — the Provider + primitives (guuey#403 §4).
 * React DOM only, by design: cross-platform semantics live in
 * `@guuey/chat`'s selection contract (portal's consult on the proposal).
 *
 * Engineering shape (ggui#633's scar, adopted): the active-panel state
 * lives in its OWN provider, separate from any chat/transcript state —
 * shells must never re-render per streaming token. The context value
 * changes ONLY on machine transitions; every callback identity is stable.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  agentModeReduce,
  INITIAL_AGENT_MODE_STATE,
  type ActivePanel,
  type AgentModeInput,
  type AgentModeState,
} from "./machine.js";
import { assertToneFloor, DEFAULT_TONES, type TonePair } from "./tones.js";
import { DEFAULT_TONE_TRANSITION_MS, LAYOUT_TOKENS } from "./index.js";

interface AgentModeContextValue {
  state: AgentModeState;
  dispatch: (input: AgentModeInput) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  identity: ReactNode;
}

const AgentModeContext = createContext<AgentModeContextValue | null>(null);

export interface AgentModeProviderProps {
  children: ReactNode;
  /**
   * The presentation mode — the SAME host-resolved value the surface
   * passes to `<GuueyChat mode>`; this lib rides the existing mode
   * machinery and adds none of its own (the ggui#633 binding rule: never
   * fixed-dark, never a second mode system). Default `"light"`, matching
   * the kit's own default.
   */
  mode?: "light" | "dark";
  /**
   * Tone override pair for the CURRENT mode (host-palette / app-theme
   * tiers — §2's tier chain). Validated against the perceptibility floor
   * at wiring time (reject-under-floor, explanatory throw). Base defaults
   * (the ggui#633 shipped pair + its dark mirror) apply when absent.
   */
  tones?: TonePair;
  /** The follow fade in ms — default the founder-certified eased 150. */
  transitionMs?: number;
  /**
   * The surface's identity mark (logo / brand node) for the working state
   * (founder (d)): shown with the built-in spinner while the agent has the
   * room but nothing is presented yet.
   */
  identity?: ReactNode;
  /**
   * The route-derived follow signal (ggui#633's scar: hand-wiring
   * per-link missed 20+ surfaces — sub-nav tabs, in-content links,
   * `router.push`). Pass your router's location key (`usePathname()`,
   * `useLocation().key`, …): ANY change dispatches `menuInteraction`.
   * The initial value dispatches nothing.
   */
  navigationKey?: unknown;
}

export function AgentModeProvider({
  children,
  mode = "light",
  tones,
  transitionMs = DEFAULT_TONE_TRANSITION_MS,
  identity = null,
  navigationKey,
}: AgentModeProviderProps): ReactNode {
  const [state, dispatch] = useReducer(agentModeReduce, INITIAL_AGENT_MODE_STATE);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Route-derived follow: any CHANGE of the key = the user navigated.
  const navRef = useRef({ initial: true, key: navigationKey });
  useEffect(() => {
    if (navRef.current.initial) {
      navRef.current = { initial: false, key: navigationKey };
      return;
    }
    if (Object.is(navRef.current.key, navigationKey)) return;
    navRef.current.key = navigationKey;
    dispatch({ type: "menuInteraction" });
    setDrawerOpen(false);
  }, [navigationKey]);

  const resolvedTones = useMemo(() => {
    const pair = tones ?? DEFAULT_TONES[mode];
    // Reject-under-floor at wiring time — an override that measures alike
    // defeats the category (§2); the base defaults pass by construction.
    if (tones !== undefined) assertToneFloor(tones);
    return pair;
  }, [tones, mode]);

  const value = useMemo<AgentModeContextValue>(
    () => ({ state, dispatch, drawerOpen, setDrawerOpen, identity }),
    [state, drawerOpen, identity],
  );

  // Token application (§2): tones + transition as inline custom properties
  // on the shell scope; `pane-tone` is LIB-WRITTEN from the machine state.
  const vars = {
    [LAYOUT_TOKENS.toneUpper]: resolvedTones.upper,
    [LAYOUT_TOKENS.toneUpperOn]: resolvedTones.upperOn,
    [LAYOUT_TOKENS.toneLower]: resolvedTones.lower,
    [LAYOUT_TOKENS.toneLowerOn]: resolvedTones.lowerOn,
    [LAYOUT_TOKENS.paneTone]:
      state.activePanel === "agent" ? resolvedTones.lower : resolvedTones.upper,
    [LAYOUT_TOKENS.toneTransition]: `${transitionMs}ms`,
  } as CSSProperties;

  return (
    <AgentModeContext.Provider value={value}>
      <div className="guuey-agent-layout" data-mode={mode} data-active-panel={state.activePanel} style={vars}>
        {children}
      </div>
    </AgentModeContext.Provider>
  );
}

export interface UseAgentModeResult {
  activePanel: ActivePanel;
  /** A turn is in flight (submit → settled). */
  streaming: boolean;
  /** The founder-(d) working-state window is open. */
  pending: boolean;
  /** The raw machine door — `bindGuueyChat(dispatch)` wires a kit surface. */
  dispatch: (input: AgentModeInput) => void;
  /**
   * The NEUTRAL panel setter (guuey#427): flips which panel has the room
   * and nothing else — `"agent"` never claims a submit happened (no
   * working state, no streaming). Submit intent goes through
   * `dispatch({ type: "agentSubmit" })` / `bindGuueyChat`. Escape hatch,
   * documented as rarely needed.
   */
  setActivePanel: (panel: ActivePanel) => void;
  /** The <1024px overlay drawer (lib-owned state; Shell renders the toggle). */
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
}

export function useAgentMode(): UseAgentModeResult {
  const ctx = useContext(AgentModeContext);
  if (ctx === null) {
    throw new Error("useAgentMode: no <AgentModeProvider> above this component.");
  }
  const { state, dispatch, drawerOpen, setDrawerOpen } = ctx;
  const setActivePanel = useCallback(
    (panel: ActivePanel) =>
      // guuey#427: the name promises a neutral setter, so it IS one — the
      // agent arm activates the panel WITHOUT arming the working state
      // (the first consumer nearly shipped a permanent spinner on the
      // agentSubmit sugar this used to be).
      dispatch(panel === "app" ? { type: "menuInteraction" } : { type: "agentPanelActivated" }),
    [dispatch],
  );
  return {
    activePanel: state.activePanel,
    streaming: state.streaming,
    pending: state.pending,
    dispatch,
    setActivePanel,
    drawerOpen,
    setDrawerOpen,
  };
}

/**
 * The grid: sidebar column + pane. Below 1024px (the console family's own
 * sidebar boundary — one muscle memory across surfaces) the sidebar leaves
 * the grid and becomes an overlay drawer, and the follow is SUSPENDED —
 * the pane holds the lower (agent) tone (stylesheet-enforced; §4's ruled
 * degraded mode). The drawer toggle renders only at drawer widths.
 *
 * Children: an {@link AgentModeSidebar} (wrapping the two panels) and an
 * {@link ActivePane}. The wrapper is structural — the drawer must slide as
 * ONE element, so the two panels share a positioned parent (the §4 sketch
 * elides it; the contract is unchanged).
 */
export function AgentModeShell({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>): ReactNode {
  const { drawerOpen, setDrawerOpen } = useAgentMode();
  return (
    <div
      {...rest}
      className={joinClass("guuey-layout-shell", className)}
      data-drawer-open={drawerOpen ? "true" : undefined}
    >
      <button
        type="button"
        className="guuey-layout-drawer-toggle"
        aria-expanded={drawerOpen}
        aria-controls="guuey-layout-sidebar"
        onClick={() => setDrawerOpen(!drawerOpen)}
      >
        <span aria-hidden="true">☰</span>
        <span className="guuey-layout-sr-only">Menu</span>
      </button>
      {children}
    </div>
  );
}

/** The sidebar column: the two panels' shared, drawer-slidable parent. */
export function AgentModeSidebar({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLElement>): ReactNode {
  return (
    <aside
      {...rest}
      id="guuey-layout-sidebar"
      className={joinClass("guuey-layout-sidebar", className)}
    >
      {children}
    </aside>
  );
}

export interface SidebarPanelProps extends HTMLAttributes<HTMLDivElement> {
  section: "app" | "agent";
}

/**
 * One sidebar section. `section="app"` wires `menuInteraction` on
 * pointer/focus interactions inside it (capture-phase — apps write ZERO
 * per-link wiring; this covers same-page clicks the route signal cannot
 * see). `section="agent"` hosts the agent surface and wires nothing — the
 * agent bridge speaks through the machine.
 */
export function SidebarPanel({ section, children, className, ...rest }: SidebarPanelProps): ReactNode {
  const { dispatch } = useAgentMode();
  const onMenuInteraction =
    section === "app" ? () => dispatch({ type: "menuInteraction" }) : undefined;
  return (
    <div
      {...rest}
      className={joinClass(`guuey-layout-panel guuey-layout-panel-${section}`, className)}
      onPointerDownCapture={onMenuInteraction}
      onFocusCapture={onMenuInteraction}
    >
      {children}
    </div>
  );
}

export interface ActivePaneProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Replaces the built-in working-state treatment (identity + pulse) shown
   * while the agent has the room and nothing is presented yet (founder
   * (d): NEVER hold prior page content on the agent ground).
   */
  workingState?: ReactNode;
}

/**
 * The right pane: paints `--guuey-layout-pane-tone`, animates per the
 * transition token, honors `prefers-reduced-motion` (stylesheet: instant
 * snap). While the founder-(d) window is open the pane presents the
 * working state INSTEAD of its children — prior page content never sits
 * on the agent ground.
 */
export function ActivePane({ children, workingState, className, ...rest }: ActivePaneProps): ReactNode {
  const ctx = useContext(AgentModeContext);
  if (ctx === null) throw new Error("ActivePane: no <AgentModeProvider> above this component.");
  const { state, identity } = ctx;
  const working = state.activePanel === "agent" && state.pending;
  return (
    <main {...rest} className={joinClass("guuey-layout-pane", className)}>
      {working ? (
        (workingState ?? (
          <div className="guuey-layout-working" role="status">
            {identity !== null ? <div className="guuey-layout-working-identity">{identity}</div> : null}
            <span className="guuey-layout-working-pulse" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="guuey-layout-sr-only">Working…</span>
          </div>
        ))
      ) : (
        children
      )}
    </main>
  );
}

function joinClass(base: string, extra: string | undefined): string {
  return extra === undefined || extra === "" ? base : `${base} ${extra}`;
}

export { bindGuueyChat } from "./bind.js";
export type { AgentModeInput, AgentModeState, ActivePanel } from "./machine.js";
export type { TonePair } from "./tones.js";
