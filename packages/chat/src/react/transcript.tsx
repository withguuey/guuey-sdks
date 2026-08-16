/**
 * `<Transcript>` — the plan walker + the §3.2 renderer obligations:
 *
 *  - **Scroll contract:** stick-to-bottom while content grows UNLESS the
 *    user scrolled up, in which case a "jump to latest" affordance appears
 *    instead; anchoring holds through content resize (a ResizeObserver on
 *    the item column re-pins — R6 cards growing on `connected` are the
 *    canonical breaker). `prefers-reduced-motion` downgrades smooth
 *    scrolling to instant.
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

  const onScroll = (): void => {
    const el = scroller.current;
    if (el === null) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
    pinned.current = nearBottom;
    setShowJump(!nearBottom);
  };

  // New content while pinned keeps the bottom in view (before paint, so
  // per-frame streaming updates never visibly jump).
  useLayoutEffect(() => {
    if (pinned.current) scrollToBottom(false);
  }, [plan]);

  // Content RESIZE (an R6 card connecting and growing, an image loading)
  // re-pins too — scrollHeight changes with no plan change.
  useEffect(() => {
    const el = column.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) scrollToBottom(false);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rootStyle: CSSProperties = { ...themeCssVars(theme, mode), ...style };

  const StatusComponent = resolvedComponents.status;

  return (
    <div
      className={`guuey-chat${className !== undefined ? ` ${className}` : ""}`}
      style={rootStyle}
      data-guuey-chat-mode={mode}
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
