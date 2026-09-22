/**
 * `<Transcript>` — the plan walker + the §3.2 renderer obligations:
 *
 *  - **Scroll contract:** stick-to-bottom while content grows UNLESS the
 *    user scrolled up, in which case a "jump to latest" affordance appears
 *    instead; anchoring holds through content resize (a ResizeObserver on
 *    the item column re-pins — R6 cards growing on `connected` are the
 *    canonical breaker). Following never carries the current turn's FIRST
 *    CARD above the viewport (guuey#1328, `scroll-anchor.ts`): once the
 *    turn outgrows the panel the card settles at its top, the rest waits
 *    below behind "jump to latest", and reaching the tail yourself (or the
 *    jump) releases the hold for that turn. `prefers-reduced-motion`
 *    downgrades smooth scrolling to instant.
 *  - **Windowing:** long transcripts render the trailing `window.tail`
 *    items with a "show earlier" expander — the DOM is capped even though
 *    the plan (already O(groups)) carries everything; the plan's stable
 *    keys keep expansion state and DOM identity across the window edge.
 *  - Theme: the resolved `GuueyChatTheme` is projected as `--guuey-chat-*`
 *    custom properties on the root (import `@guuey/chat/styles.css` once
 *    for the default look, or restyle the class names entirely).
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { DEFAULT_CHAT_THEME, type GuueyChatTheme } from "../theme.js";
import { defaultChatStrings, type ChatStrings } from "../strings.js";
import type { TranscriptPlan } from "../types.js";
import {
  defaultTranscriptComponents,
  renderItem,
  type TranscriptComponents,
  type TranscriptItemContext,
} from "./components.js";
import { themeCssVars, type ThemeMode } from "./theme-css.js";
import { facesCss, useHostFaces } from "./faces.js";
import { PARTS } from "./parts.js";
import { followTarget, planTurnAnchor } from "./scroll-anchor.js";

/** How close to the bottom (px) still counts as pinned. */
const PIN_THRESHOLD_PX = 48;

export interface TranscriptWindowing {
  /** Trailing items rendered; earlier ones sit behind the expander. */
  tail: number;
}

export interface TranscriptProps
  extends Pick<
    TranscriptItemContext,
    | "onToggle"
    | "onRetry"
    | "onPromptAction"
    | "onErrorAction"
    | "resolvedMounts"
    | "onViewPhase"
    | "onViewDiagnosis"
    | "onViewRef"
    | "viewProps"
  > {
  plan: TranscriptPlan;
  /** Per-slot component overrides (spec §3's override column). */
  components?: Partial<TranscriptComponents>;
  /** The i18n seam — pass the same strings the policy carries. */
  strings?: ChatStrings;
  theme?: GuueyChatTheme;
  mode?: ThemeMode;
  /**
   * Message-surface presentation (guuey#521). `"card"` (default) renders
   * assistant text on its own surface-tinted, hairline-bordered card;
   * `"bare"` sits the transcript directly on the host's background — the
   * embed disappears into the page it lives on. The user pill stays a
   * bubble in both.
   */
  surface?: "card" | "bare";
  /** DOM windowing (§3.2). `false` renders everything. Default tail 80. */
  window?: TranscriptWindowing | false;
  className?: string;
  style?: CSSProperties;
}

export function Transcript(props: TranscriptProps): ReactNode {
  const {
    plan,
    components,
    strings = defaultChatStrings,
    theme = DEFAULT_CHAT_THEME,
    mode = "light",
    surface = "card",
    window: windowing = { tail: 80 },
    className,
    style,
    onToggle,
    onRetry,
    onPromptAction,
    onErrorAction,
    resolvedMounts,
    onViewPhase,
    onViewDiagnosis,
    onViewRef,
    viewProps,
  } = props;

  const resolvedComponents: TranscriptComponents = useMemo(
    () => ({ ...defaultTranscriptComponents, ...components }),
    [components],
  );
  const ctx: TranscriptItemContext = useMemo(
    () => ({
      strings,
      onToggle,
      onRetry,
      onPromptAction,
      onErrorAction,
      resolvedMounts,
      onViewPhase,
      onViewDiagnosis,
      onViewRef,
      viewProps,
    }),
    [strings, onToggle, onRetry, onPromptAction, onErrorAction, resolvedMounts, onViewPhase, onViewDiagnosis, onViewRef, viewProps],
  );

  // ── Windowing ────────────────────────────────────────────────────────
  const [extraShown, setExtraShown] = useState(0);
  const tail = windowing === false ? Number.POSITIVE_INFINITY : windowing.tail;
  const visibleFrom = Math.max(0, plan.items.length - tail - extraShown);
  const hidden = visibleFrom;
  const visible = plan.items.slice(visibleFrom);

  // ── Scroll contract ──────────────────────────────────────────────────
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // guuey#1328 — the current turn's card anchor, read off the rendered
  // items; mirrored into a ref for the ResizeObserver, which runs between
  // renders.
  const turnAnchor = useMemo(() => planTurnAnchor(plan.items.slice(visibleFrom)), [plan.items, visibleFrom]);
  const anchorPlan = useRef(turnAnchor);
  /** True while the anchor, not the bottom, decides where following rests. */
  const holding = useRef(false);
  /** The turn whose hold the viewer released (reached the tail, or jumped). */
  const releasedTurn = useRef<string | null>(null);
  /** The scrollTop of our own last follow, so `onScroll` can tell it from the viewer's. */
  const autoTop = useRef<number | null>(null);

  const reducedMotion = (): boolean =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const scrollToBottom = (smooth: boolean): void => {
    const el = scroller.current;
    if (el === null) return;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
    } else {
      // Environments without Element.scrollTo (jsdom; ancient WebViews).
      el.scrollTop = el.scrollHeight;
    }
  };

  /**
   * The anchor card's top in scroll-content coordinates, or null (no card
   * this turn, the hold released, or the DOM disagrees with the plan). The
   * kit's own `view` component renders one `.guuey-chat-view` per view item
   * as a direct child of the column; a custom `view` component, or any
   * other mismatch, keeps plain stick-to-bottom rather than guessing.
   */
  const anchorTop = (): number | null => {
    const anchor = anchorPlan.current;
    if (anchor.anchorOrdinal === null || releasedTurn.current === anchor.turnKey) return null;
    const el = scroller.current;
    const col = column.current;
    if (el === null || col === null) return null;
    const views = Array.from(col.children).filter((c) => c.classList.contains("guuey-chat-view"));
    if (views.length !== anchor.viewCount) return null;
    const card = views[anchor.anchorOrdinal];
    if (card === undefined) return null;
    return card.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop + el.scrollTop;
  };

  /** Follow: to the bottom, or to the turn's card when the bottom would carry it out of view. */
  const follow = (): void => {
    const el = scroller.current;
    if (el === null) return;
    const target = followTarget(
      { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
      anchorTop(),
    );
    holding.current = target.held;
    // A held follow leaves content below: say so (the scroll event may not
    // fire when the card is already where it rests).
    setShowJump(target.held);
    if (Math.abs(target.top - el.scrollTop) < 1) return;
    autoTop.current = target.top;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: target.top, behavior: "auto" });
    } else {
      el.scrollTop = target.top;
    }
  };

  const onScroll = (): void => {
    const el = scroller.current;
    if (el === null) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
    const ours = autoTop.current !== null && Math.abs(el.scrollTop - autoTop.current) <= 1;
    autoTop.current = null;
    if (ours) {
      // Our own follow (to the bottom or to the card): following continues.
      setShowJump(!nearBottom);
      return;
    }
    // The viewer reached the tail while the card held: they chose the tail,
    // so this turn follows the bottom from here.
    if (nearBottom && holding.current) releasedTurn.current = anchorPlan.current.turnKey;
    pinned.current = nearBottom;
    setShowJump(!nearBottom);
  };

  // Declared before the follow below: layout effects run in order, so the
  // follow always reads this render's anchor.
  useLayoutEffect(() => {
    anchorPlan.current = turnAnchor;
  }, [turnAnchor]);

  // New content while pinned keeps following (before paint, so per-frame
  // streaming updates never visibly jump).
  useLayoutEffect(() => {
    if (pinned.current) follow();
  }, [plan]);

  // Content RESIZE (an R6 card connecting and growing, an image loading)
  // re-runs the follow too — scrollHeight changes with no plan change. A
  // card growing past the panel no longer drives the viewport past itself:
  // the follow clamps at its top.
  useEffect(() => {
    const el = column.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) follow();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // guuey#1195: a standalone <Transcript> consumer gets the theme's faces too.
  useHostFaces(facesCss(theme.typography.faces));

  const rootStyle: CSSProperties = { ...themeCssVars(theme, mode), ...style };

  const StatusComponent = resolvedComponents.status;

  return (
    <div
      className={`guuey-chat${surface === "bare" ? " guuey-chat--bare" : ""}${className !== undefined ? ` ${className}` : ""}`}
      style={rootStyle}
      data-guuey-chat-mode={mode}
      part={PARTS.transcript}
    >
      <div ref={scroller} className="guuey-chat-scroller" onScroll={onScroll}>
        <div ref={column} className="guuey-chat-column">
          {hidden > 0 ? (
            <button
              type="button"
              className="guuey-chat-show-earlier"
              onClick={() => setExtraShown((n) => n + tail)}
            >
              {strings.showEarlier(hidden)}
            </button>
          ) : null}
          {visible.map((item) => renderItem(item, resolvedComponents, ctx))}
          {plan.status !== null ? (
            <StatusComponent item={plan.status} ctx={ctx} />
          ) : null}
        </div>
      </div>
      {showJump ? (
        <button
          type="button"
          className="guuey-chat-jump"
          onClick={() => {
            pinned.current = true;
            releasedTurn.current = anchorPlan.current.turnKey;
            holding.current = false;
            setShowJump(false);
            scrollToBottom(true);
          }}
        >
          {strings.jumpToLatest}
        </button>
      ) : null}
    </div>
  );
}
