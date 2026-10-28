/**
 * The per-category component kit (spec §3's override slots): one component
 * per `DisplayItem` variant, each a THIN walk of its item — every rendering
 * decision (states, labels, collapse defaults, copy) was already made by
 * `planTranscript`; components translate the decided item into markup and
 * never consult policy or invent copy.
 *
 * Override contract: `TranscriptComponents` is the component map
 * (`{ tool: MyToolChip }` replaces one row's renderer without forfeiting
 * the rest); every default is exported for composition.
 *
 * Accessibility (spec §3.2, acceptance criteria):
 *  - every `expanded` toggle is a real `<button aria-expanded aria-controls>`
 *    (keyboard-operable for free);
 *  - the status line is `role="status"` (a polite live region);
 *  - a streaming text bubble announces via `aria-live="polite"`;
 *  - R10 prompts take focus on appearance and return it on resolution;
 *  - shimmer/pulse is CSS-only and disabled under `prefers-reduced-motion`
 *    (see styles.css).
 */
import { HighlightedCode } from "./highlighted-code.js";
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { GuueyView, type GuueyViewProps } from "@guuey/mcp-apps-host/react";
import type { PreGenerationRefusal, ResolvedViewMount, ViewCspDiagnosis, ViewHostPhase } from "@guuey/mcp-apps-host";
import type { ChatStrings } from "../strings.js";
import type { MediaChipReason, MediaDisplay } from "../media.js";
import type {
  CitationsItem,
  CodeItem,
  CompactionItem,
  DataResultItem,
  DisplayItem,
  ErrorItem,
  HistoryBoundaryItem,
  ItemKey,
  MediaItem,
  NoticeItem,
  PromptItem,
  ReasoningItem,
  StatusLineItem,
  TapItem,
  ToolGroupItem,
  ToolItem,
  UnknownItem,
  UserMessageItem,
  TextItem,
  ThreadClosedNotice,
  ViewMountItem,
  ViewRefItem,
} from "../types.js";
import { Markdown } from "./markdown.js";
import { PARTS, messagePart } from "./parts.js";

/** Everything a rendered item may need beyond itself. */
export interface TranscriptItemContext {
  strings: ChatStrings;
  /** Flip an item's collapse state (the renderer owns override state). */
  onToggle: (key: ItemKey) => void;
  /** R0 failed-send retry. */
  onRetry?: (item: UserMessageItem) => void;
  /**
   * R10 prompt actions — the host owns what accept/decline DO. A hitl card
   * with declared grant modes reports the pick as `{ grantModeId }` (spec
   * draft.2); plain accepts stay the `"accept"` string.
   */
  onPromptAction?: (
    item: PromptItem,
    action: "accept" | "decline" | "dismiss" | { grantModeId: string },
  ) => void;
  /** R11 action slots (sign-in / upgrade / retry affordances). */
  onErrorAction?: (item: ErrorItem) => void;
  /** R6: locator mounts resolved by `useTranscript` ("expired" = failed). */
  resolvedMounts: ReadonlyMap<ItemKey, ResolvedViewMount | "expired">;
  /** R6: live phase reports wired back into the next plan. */
  onViewPhase: (key: ItemKey, phase: ViewHostPhase) => void;
  /**
   * R6: the host's CSP tripwire diagnosed the embedding page blocking a
   * view (guuey#235) — wired back so the label names the cause. Optional:
   * a hand-wired host that omits it simply keeps the channel heuristic.
   */
  onViewDiagnosis?: (key: ItemKey, diagnosis: ViewCspDiagnosis) => void;
  /**
   * guuey#204: a promoted-view reference chip was activated — the host
   * focuses/reveals its stage (canvas). Absent ⇒ the chip renders as a
   * non-interactive label.
   */
  onViewRef?: (item: ViewRefItem) => void;
  /**
   * R6 pass-through (sandbox overrides, the two-origin mount, relay hooks
   * — policy-gated by the host). Static, or a FUNCTION of the mount being
   * rendered: view configuration legitimately varies per mount — the
   * relay-page URL picks a per-channel egress grant (`?channel=`), and a
   * `tools/call` hook scopes to the item's persisted locator (guuey#158) —
   * so the function form receives the item and its resolved mount and is
   * called only when something actually mounts. Static keeps working
   * unchanged.
   */
  viewProps?: ViewSlotProps | ((item: ViewMountItem, mount: ResolvedViewMount) => ViewSlotProps);
}

/** The per-view slice of `GuueyViewProps` a transcript may configure. */
export type ViewSlotProps = Pick<
  GuueyViewProps,
  | "hostCapabilities"
  | "hostInfo"
  | "hostContext"
  | "onCallTool"
  | "onUpdateModelContext"
  | "onUserMessage"
  | "onOpenLink"
  | "onReadResource"
  | "onSizeChanged"
  | "negotiationTimeoutMs"
  | "dangerouslyAddSandboxFlags"
  | "allow"
  | "sandboxPageUrl"
  | "autoResize"
  | "maxHeight"
  | "cspOrigins"
>;

interface ItemProps<T> {
  item: T;
  ctx: TranscriptItemContext;
}

/** A collapse toggle + body pair with correct ARIA plumbing. */
function Collapsible({
  itemKey,
  expanded,
  header,
  ctx,
  className,
  children,
}: {
  itemKey: ItemKey;
  expanded: boolean;
  header: ReactNode;
  ctx: TranscriptItemContext;
  className?: string;
  children: ReactNode;
}): ReactNode {
  const bodyId = `guuey-chat-body-${itemKey}`;
  return (
    <div className={className}>
      <button
        type="button"
        className="guuey-chat-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => ctx.onToggle(itemKey)}
      >
        {header}
        <span aria-hidden="true" className="guuey-chat-toggle-glyph">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded ? (
        <div id={bodyId} className="guuey-chat-body">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A copy-to-clipboard affordance with a transient confirmation state. */
function CopyButton({ text, ctx }: { text: string; ctx: TranscriptItemContext }): ReactNode {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="guuey-chat-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? ctx.strings.copied : ctx.strings.copy}
    </button>
  );
}

// ─── R0 ────────────────────────────────────────────────────────────────────

/** The couldn't-send line + Retry under a failed R0/R0b turn. */
function SendFailed({ item, ctx }: ItemProps<UserMessageItem>): ReactNode {
  if (item.state !== "failed") return null;
  return (
    <p
      className={item.failureTone === "retry" ? "guuey-chat-send-failed guuey-chat-send-failed-retry" : "guuey-chat-send-failed"}
      role="status"
    >
      {item.failureLine ?? ctx.strings.userCouldntSend}
      {item.retry ? (
        <button type="button" className="guuey-chat-retry" onClick={() => ctx.onRetry?.(item)}>
          {ctx.strings.userRetry}
        </button>
      ) : null}
    </p>
  );
}

/** The tap mark (the brand's glyph, 16×16 viewBox) — decoration, hidden from assistive tech. */
function TapMark(): ReactNode {
  return (
    <svg className="guuey-chat-action-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M6.4 6.4 13.6 9.1 10.3 10.3 9.1 13.6Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M6.4 1.5v2.3M1.5 6.4h2.3M2.9 2.9l1.6 1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The words of an action turn, one entry per tap (guuey#2031): a label is the
 * quiet twin of the typed bubble (the ink tint, the tap mark, a hidden "you
 * tapped" prefix); a `null` entry is the continuation line in its position.
 * QUOTED, never rendered — whitespace preserved. Never a control.
 */
function ActionTurnWords({ labels, strings }: { labels: readonly (string | null)[]; strings: ChatStrings }): ReactNode {
  return labels.map((label, i) =>
    label === null ? (
      <p key={i} className="guuey-chat-directive-label">
        {strings.directiveContinuation}
      </p>
    ) : (
      <div key={i} className="guuey-chat-action">
        <span className="guuey-chat-action-bubble">
          <TapMark />
          <span className="guuey-chat-action-text">
            {/* The prefix's space rides INSIDE the hidden span: the bubble is
                pre-wrap and the prefix is out of flow, so a space between the
                two spans would be the first drawn character of the label. */}
            <span className="guuey-chat-visually-hidden">{`${strings.tappedLabelPrefix} `}</span>
            <span className="guuey-chat-action-label">{label}</span>
          </span>
        </span>
      </div>
    ),
  );
}

export function DefaultUserMessage({ item, ctx }: ItemProps<UserMessageItem>): ReactNode {
  // guuey#422 / guuey#2031: a forwarded view directive is an ACTION turn,
  // never typed speech — the tapped words when the row carries them, else the
  // continuation line. On a visitor surface nothing discloses the directive
  // (machine text never reaches a visitor); the debug preset offers it in a
  // quiet toggle BELOW the turn, and the turn itself never becomes a button.
  if (item.directive) {
    return (
      <div
        className={`guuey-chat-action-turn guuey-chat-user-directive guuey-chat-user-${item.state}${
          item.state === "sending" ? " guuey-chat-action-sending" : ""
        }`}
        part={messagePart("user")}
      >
        <ActionTurnWords labels={item.tapLabels ?? [null]} strings={ctx.strings} />
        {item.rawDirective === true ? (
          <Collapsible
            itemKey={item.key}
            expanded={item.expanded}
            header={<span>{ctx.strings.directiveRawToggle}</span>}
            ctx={ctx}
            className="guuey-chat-directive-raw"
          >
            {/* Verbatim quote — the same never-rendered rule as the bubble. */}
            <div className="guuey-chat-directive-raw-text">{item.text}</div>
          </Collapsible>
        ) : null}
        <SendFailed item={item} ctx={ctx} />
      </div>
    );
  }
  // guuey#2549: a turn sent without words is an action turn too: its own quiet
  // line, never an empty bubble.
  if (item.inputKind !== undefined) {
    return (
      <div
        className={`guuey-chat-action-turn guuey-chat-user-context-only guuey-chat-user-${item.state}${
          item.state === "sending" ? " guuey-chat-action-sending" : ""
        }`}
        part={messagePart("user")}
      >
        <p className="guuey-chat-directive-label guuey-chat-context-only-label">{ctx.strings.contextOnlyTurn}</p>
        <SendFailed item={item} ctx={ctx} />
      </div>
    );
  }
  return (
    <div className={`guuey-chat-user guuey-chat-user-${item.state}`} part={messagePart("user")}>
      {/* User text is QUOTED, never rendered — whitespace preserved. */}
      <div className="guuey-chat-user-bubble">{item.text}</div>
      <SendFailed item={item} ctx={ctx} />
    </div>
  );
}

// ─── R0b ───────────────────────────────────────────────────────────────────

/**
 * A card tap drawn before its turn is sent (guuey#2031): the same action turn
 * in the sending look, with no disclosure — no directive text exists yet.
 */
export function DefaultTap({ item, ctx }: ItemProps<TapItem>): ReactNode {
  return (
    <div className="guuey-chat-action-turn guuey-chat-action-sending" part={messagePart("user")}>
      <ActionTurnWords labels={item.labels} strings={ctx.strings} />
    </div>
  );
}

// ─── R1 ────────────────────────────────────────────────────────────────────

export function DefaultText({ item, ctx }: ItemProps<TextItem>): ReactNode {
  if (item.tone === "interim") {
    // Interim narration: the status line's voice, outside the answer's bubble.
    return (
      <div
        className="guuey-chat-narration"
        part={PARTS.narration}
        {...(item.streaming ? { "aria-live": "polite" as const } : {})}
      >
        {item.markdown ? <Markdown text={item.text} /> : <p className="guuey-chat-verbatim">{item.text}</p>}
        {item.streaming ? (
          <span aria-hidden="true" className="guuey-chat-cursor">
            {" ▍"}
          </span>
        ) : null}
        {item.stopped ? <p className="guuey-chat-stopped">{ctx.strings.stopped}</p> : null}
      </div>
    );
  }
  return (
    <div
      className="guuey-chat-text"
      part={messagePart("agent")}
      {...(item.streaming ? { "aria-live": "polite" as const } : {})}
    >
      {item.markdown ? (
        <Markdown text={item.text} />
      ) : (
        <p className="guuey-chat-verbatim">{item.text}</p>
      )}
      {item.streaming ? (
        <span aria-hidden="true" className="guuey-chat-cursor">
          {" ▍"}
        </span>
      ) : null}
      {item.stopped ? <p className="guuey-chat-stopped">{ctx.strings.stopped}</p> : null}
    </div>
  );
}

// ─── R2 ────────────────────────────────────────────────────────────────────

export function DefaultReasoning({ item, ctx }: ItemProps<ReasoningItem>): ReactNode {
  return (
    <Collapsible
      itemKey={item.key}
      expanded={item.expanded}
      ctx={ctx}
      className={`guuey-chat-reasoning${item.streaming ? " guuey-chat-pulse" : ""}`}
      header={<span>{item.label}</span>}
    >
      <p className="guuey-chat-reasoning-text">{item.text}</p>
    </Collapsible>
  );
}

// ─── R5 (also embedded inside R3's expansion) ──────────────────────────────

export function DefaultDataResult({ item, ctx }: ItemProps<DataResultItem>): ReactNode {
  const bytes = ctx.strings.bytes(item.byteCount);
  // guuey#2367: a cut, non-giant result opens to its whole text in place.
  const [showAll, setShowAll] = useState(false);
  const shown = showAll && item.full !== undefined ? item.full : item.preview;
  return (
    <div className={`guuey-chat-data guuey-chat-data-${item.state}`}>
      {item.state === "empty" ? (
        <p className="guuey-chat-data-empty">{ctx.strings.noOutput}</p>
      ) : shown === null ? (
        <p className="guuey-chat-data-binary">{bytes}</p>
      ) : (
        <>
          <pre className="guuey-chat-data-preview">
            <HighlightedCode code={shown} lang={item.lang} />
          </pre>
          <div className="guuey-chat-data-meta">
            {item.showBytes ? <span>{bytes}</span> : null}
            {item.full !== undefined ? (
              <button
                type="button"
                className="guuey-chat-data-more"
                aria-expanded={showAll}
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll ? ctx.strings.showLess : ctx.strings.showAll}
              </button>
            ) : null}
            <CopyButton text={item.full ?? shown} ctx={ctx} />
          </div>
        </>
      )}
    </div>
  );
}

// ─── R3 ────────────────────────────────────────────────────────────────────

const TOOL_GLYPH: Record<ToolItem["state"], string> = {
  running: "◌",
  done: "✓",
  failed: "✕",
  orphaned: "–",
};

export function DefaultTool({ item, ctx }: ItemProps<ToolItem>): ReactNode {
  // R4's display-bearing rule: in calm this call's line lives in its view
  // row's chrome ("via {tool}") — rendering it here too would double it.
  if (item.attribution) return null;
  const expandable = item.argsPreview !== null || item.result !== null || item.refusal !== null;
  const header = (
    <span className={`guuey-chat-tool-line guuey-chat-tool-${item.state}`}>
      <span aria-hidden="true" className="guuey-chat-tool-glyph">
        {TOOL_GLYPH[item.state]}
      </span>
      <span className="guuey-chat-tool-title">{item.title}</span>
      {item.state === "orphaned" && item.reloadedWithoutResult !== true ? (
        <span className="guuey-chat-tool-note">{ctx.strings.toolDidntFinish}</span>
      ) : null}
    </span>
  );
  if (!expandable) return <div className="guuey-chat-tool">{header}</div>;
  return (
    <Collapsible
      itemKey={item.key}
      expanded={item.expanded}
      ctx={ctx}
      className="guuey-chat-tool"
      header={header}
    >
      {item.argsPreview !== null ? (
        <pre className="guuey-chat-tool-args">{item.argsPreview}</pre>
      ) : null}
      {item.result !== null ? <DefaultDataResult item={item.result} ctx={ctx} /> : null}
      {item.refusal !== null ? <DefaultRenderRefusal refusal={item.refusal} ctx={ctx} /> : null}
    </Collapsible>
  );
}

/**
 * guuey#836 — a ggui_render PRE-GENERATION refusal, faced in the
 * envelope's own words. The deployment declined before doing any work, so
 * there is no card and no data result: the message says what was checked,
 * the fix says the one step (addressed to whoever can take it — often the
 * app's owner, not the person chatting), the code is the registry name for
 * the builder's logs, the retry class is the hint.
 */
export function DefaultRenderRefusal({
  refusal,
  ctx,
}: {
  refusal: PreGenerationRefusal;
  ctx: TranscriptItemContext;
}): ReactNode {
  return (
    <div className="guuey-chat-tool-refusal" role="status" data-refusal-code={refusal.code}>
      <span className="guuey-chat-tool-refusal-label">{ctx.strings.renderRefused}</span>
      <code className="guuey-chat-tool-refusal-code">{refusal.code}</code>
      <p className="guuey-chat-tool-refusal-message">{refusal.message}</p>
      <p className="guuey-chat-tool-refusal-fix">{refusal.fix}</p>
      <span className="guuey-chat-tool-refusal-retry">{ctx.strings.renderRefusedRetry(refusal.retry)}</span>
    </div>
  );
}

// ─── R4 ────────────────────────────────────────────────────────────────────

export function DefaultToolGroup({ item, ctx }: ItemProps<ToolGroupItem>): ReactNode {
  return (
    <Collapsible
      itemKey={item.key}
      expanded={item.expanded}
      ctx={ctx}
      className="guuey-chat-tool-group"
      header={
        <span>
          {item.label}
          {item.failureBadge !== null ? (
            <span className="guuey-chat-failure-badge">{item.failureBadge}</span>
          ) : null}
        </span>
      }
    >
      {item.tools.map((tool) => (
        <DefaultTool key={tool.key} item={tool} ctx={ctx} />
      ))}
    </Collapsible>
  );
}

// ─── R6 ────────────────────────────────────────────────────────────────────

export function DefaultView({ item, ctx }: ItemProps<ViewMountItem>): ReactNode {
  // Resolve what to actually mount: direct material, or the locator's
  // resolution from `useTranscript` (renderer state — "expired" = miss).
  const resolution = ctx.resolvedMounts.get(item.key);
  const mount: ResolvedViewMount | null =
    item.mount !== null && item.mount.channel !== "locator"
      ? item.mount
      : resolution !== undefined && resolution !== "expired"
        ? resolution
        : null;
  const expired = item.phase === "expired" || resolution === "expired";

  if (expired) {
    return (
      <div className="guuey-chat-view guuey-chat-view-expired">
        <p role="status">{ctx.strings.viewExpired}</p>
      </div>
    );
  }
  if (mount === null) {
    // A locator still resolving (or a plan-level expired mount) — labeled,
    // never blank.
    return (
      <div className="guuey-chat-view guuey-chat-view-negotiating guuey-chat-shimmer">
        <p role="status">{item.label ?? ctx.strings.viewNegotiating}</p>
      </div>
    );
  }
  // The function form resolves against the ACTUAL mount (per-channel relay
  // URLs, per-locator action scoping); it runs only when something mounts.
  const viewProps =
    typeof ctx.viewProps === "function" ? ctx.viewProps(item, mount) : (ctx.viewProps ?? {});
  return (
    <div className="guuey-chat-view">
      <GuueyView
        mount={mount}
        {...(item.toolData !== undefined ? { toolData: item.toolData } : {})}
        {...viewProps}
        onPhaseChange={(phase) => ctx.onViewPhase(item.key, phase)}
        onCspDiagnosis={(diagnosis) => ctx.onViewDiagnosis?.(item.key, diagnosis)}
      />
      {item.attribution !== null ? (
        <p className="guuey-chat-attribution">{item.attribution}</p>
      ) : null}
    </div>
  );
}

/**
 * guuey#204: the "promote and reference" chip — stands in for the one
 * mount the host's stage shows. A real button when the host wires
 * `onViewRef` (keyboard-accessible for free); a plain label otherwise.
 */
export function DefaultViewRef({ item, ctx }: ItemProps<ViewRefItem>): ReactNode {
  const stateClasses = `${item.selected ? " guuey-chat-view-ref-selected" : ""}${
    item.phase === "expired" ? " guuey-chat-view-ref-expired" : ""
  }`;
  if (ctx.onViewRef === undefined) {
    return (
      <p className={`guuey-chat-view-ref${stateClasses}`} role="note">
        {item.label}
      </p>
    );
  }
  const onViewRef = ctx.onViewRef;
  return (
    <button
      type="button"
      className={`guuey-chat-view-ref guuey-chat-view-ref-button${stateClasses}`}
      aria-pressed={item.selected}
      onClick={() => onViewRef(item)}
    >
      {item.label}
    </button>
  );
}

// ─── R7 ────────────────────────────────────────────────────────────────────

/** The note a chip carries for media the kit will not show inline (null for a plain attachment). */
function chipNote(reason: MediaChipReason, strings: ChatStrings): string | null {
  switch (reason) {
    case "attachment":
      return null;
    case "oversized":
      return strings.mediaOversized;
    case "refused-type":
    case "unsupported":
      return strings.mediaRefused;
  }
}

/**
 * guuey#2369 — inline audio bytes as a `blob:` object URL, created after
 * mount and revoked on unmount (or when the bytes change). Null until then,
 * and for anything that is not inline audio.
 */
function useAudioObjectUrl(display: MediaDisplay): string | null {
  const bytes = display.kind === "audio-bytes" ? display : null;
  const mediaType = bytes?.mediaType ?? null;
  const data = bytes?.data ?? null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (mediaType === null || data === null) return;
    const binary = atob(data);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
    const objectUrl = URL.createObjectURL(new Blob([buffer], { type: mediaType }));
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [mediaType, data]);
  return url;
}

/**
 * R7. What loads was decided by the plan (`item.display`, guuey#2369): only
 * `data:`, `blob:` and media-origin sources reach an element; any other
 * https URL is a chip whose action opens it in a new tab — never fetched on
 * render.
 */
export function DefaultMedia({ item, ctx }: ItemProps<MediaItem>): ReactNode {
  const [failed, setFailed] = useState(false);
  const display = item.display;
  const audioUrl = useAudioObjectUrl(display);
  if (display.kind === "image" && !failed) {
    const img = <img src={display.src} alt={item.name ?? ""} onError={() => setFailed(true)} />;
    // A data: URL cannot be opened as a top-level page; the image stands alone.
    if (/^data:/i.test(display.src)) return <div className="guuey-chat-media-image">{img}</div>;
    return (
      <a className="guuey-chat-media-image" href={display.src} target="_blank" rel="noopener noreferrer">
        {img}
      </a>
    );
  }
  if (display.kind === "audio") {
    return <audio className="guuey-chat-media-audio" controls src={display.src} />;
  }
  if (display.kind === "audio-bytes") {
    return <audio className="guuey-chat-media-audio" controls src={audioUrl ?? undefined} />;
  }
  const label = item.name ?? item.media;
  if (display.kind === "link") {
    return (
      <span className={`guuey-chat-media-chip guuey-chat-media-${item.media} guuey-chat-media-link`}>
        <span className="guuey-chat-media-label">{label}</span>{" "}
        <a
          className="guuey-chat-media-open"
          href={display.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          referrerPolicy="no-referrer"
        >
          {ctx.strings.mediaOpenLink}
        </a>
      </span>
    );
  }
  // A plain chip: files, documents, a failed load, or media refused inline.
  const note = display.kind === "chip" ? chipNote(display.reason, ctx.strings) : null;
  return (
    <span className={`guuey-chat-media-chip guuey-chat-media-${item.media}`}>
      {label}
      {note !== null ? <span className="guuey-chat-media-note"> · {note}</span> : null}
    </span>
  );
}

// ─── R8 ────────────────────────────────────────────────────────────────────

export function DefaultCode({ item, ctx }: ItemProps<CodeItem>): ReactNode {
  return (
    <div className="guuey-chat-code">
      <div className="guuey-chat-code-meta">
        <span className="guuey-chat-code-lang">{item.language}</span>
        <CopyButton text={item.code} ctx={ctx} />
      </div>
      <pre className={item.wrap ? "guuey-chat-code-wrap" : undefined}>{item.code}</pre>
    </div>
  );
}

// ─── R9 ────────────────────────────────────────────────────────────────────

/** Citation links navigate only to http(s) targets. */
function safeCitationUrl(url: string | null): string | null {
  return url !== null && /^https?:\/\//i.test(url) ? url : null;
}

export function DefaultCitations({ item, ctx }: ItemProps<CitationsItem>): ReactNode {
  return (
    <Collapsible
      itemKey={item.key}
      expanded={item.expanded}
      ctx={ctx}
      className="guuey-chat-citations"
      header={<span>{item.label}</span>}
    >
      <ul className={`guuey-chat-citations-${item.style}`}>
        {item.sources.map((source, i) => {
          const url = safeCitationUrl(source.url);
          const label = source.title ?? source.url ?? "";
          return (
            <li key={i}>
              {url !== null ? (
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {label}
                </a>
              ) : (
                <span>{label}</span>
              )}
            </li>
          );
        })}
      </ul>
    </Collapsible>
  );
}

// ─── R10 ───────────────────────────────────────────────────────────────────

export function DefaultPrompt({ item, ctx }: ItemProps<PromptItem>): ReactNode {
  const firstAction = useRef<HTMLButtonElement>(null);
  const restoreTo = useRef<Element | null>(null);
  const wasPending = useRef(false);

  // Focus management (§3.2): take focus when the ask appears, hand it back
  // when the ask resolves.
  useEffect(() => {
    if (item.state === "pending" && !wasPending.current) {
      restoreTo.current = document.activeElement;
      firstAction.current?.focus();
    }
    if (item.state !== "pending" && wasPending.current) {
      const target = restoreTo.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    }
    wasPending.current = item.state === "pending";
  }, [item.state]);

  if (item.promptKind === "hitl") {
    const s = ctx.strings;
    // guuey#1860: an ask nothing in this chat can answer is information, not a
    // control: the ask and one line, no buttons, no dismissal. guuey#2302: it
    // has its own quiet frame (not the answerable card's accent), lists the
    // choices the agent offered as plain text, drops the waiting line once
    // the ask is no longer pending, and is announced politely.
    if (item.answer === "none") {
      const choices = item.ask.choices ?? [];
      return (
        <div className="guuey-chat-prompt-info" role="note" aria-live="polite" data-state={item.state}>
          {item.message !== null && <p className="guuey-chat-prompt-ask">{item.message}</p>}
          {choices.length > 0 && (
            <ul className="guuey-chat-prompt-info-choices">
              {choices.map((choice) => (
                <li key={choice.id}>{choice.label}</li>
              ))}
            </ul>
          )}
          {item.state === "pending" && <p className="guuey-chat-prompt-info-hint">{s.promptNoAnswerChannel}</p>}
        </div>
      );
    }
    // Settled records: resolved shows the CHOSEN MODE'S LABEL (ids are
    // echo-only identity — asker-scoped semantics, spec §7); declined is
    // the durable deny. `cancelled` is guuey's re-askable dismissal: it
    // collapses to a record but stays answerable when expanded.
    if (item.state === "resolved" || item.state === "declined") {
      // The OAuth arm's resolved record: the pick SENT the user to the
      // provider (no answer door) — the grant lands on the next turn.
      return (
        <p className={`guuey-chat-prompt-record guuey-chat-prompt-${item.state}`}>
          {item.state === "resolved"
            ? item.chosenModeLabel !== null
              ? item.oauth !== null
                ? s.promptOAuthSent(item.chosenModeLabel)
                : s.promptAnsweredWith(item.chosenModeLabel)
              : s.promptAccept
            : s.promptDeclinedRecord}
        </p>
      );
    }
    const answerable = item.state === "pending" || (item.state === "cancelled" && item.expanded);
    // guuey#605 — a REQUIRED connection is a step, not an aside: the runtime
    // refused this turn on it and answers nothing until it is connected. The
    // card says so above the ask, and carries a class a theme can lift.
    const requiredConnection = item.oauth?.upfront === true;
    return (
      <div
        className={`guuey-chat-prompt${requiredConnection ? " guuey-chat-prompt-required" : ""}`}
        role="group"
      >
        {item.state === "cancelled" && (
          <button
            type="button"
            className="guuey-chat-prompt-record guuey-chat-prompt-cancelled"
            aria-expanded={item.expanded}
            onClick={() => ctx.onToggle(item.key)}
          >
            {s.promptDismissed}
          </button>
        )}
        {answerable && (
          <>
            {requiredConnection && (
              <p className="guuey-chat-prompt-required-hint">{s.authRequiredHint}</p>
            )}
            {item.message !== null && <p className="guuey-chat-prompt-ask">{item.message}</p>}
            <div className="guuey-chat-prompt-actions">
              {item.grantModes.length === 0 ? (
                <button
                  ref={firstAction}
                  type="button"
                  className="guuey-chat-prompt-accept"
                  onClick={() => ctx.onPromptAction?.(item, "accept")}
                >
                  {s.promptAccept}
                </button>
              ) : (
                item.grantModes.map((mode, i) => (
                  <button
                    key={mode.id}
                    ref={i === 0 ? firstAction : undefined}
                    type="button"
                    className="guuey-chat-prompt-accept"
                    title={mode.description}
                    onClick={() => ctx.onPromptAction?.(item, { grantModeId: mode.id })}
                  >
                    {mode.label ?? mode.id}
                  </button>
                ))
              )}
              {/* The OAuth arm has no durable deny — "Not now" dismisses
                  (nothing written; the ask re-emits next turn). */}
              {item.oauth !== null ? (
                <button type="button" onClick={() => ctx.onPromptAction?.(item, "dismiss")}>
                  {s.promptNotNow}
                </button>
              ) : (
                <button type="button" onClick={() => ctx.onPromptAction?.(item, "decline")}>
                  {s.promptDecline}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  }
  if (item.state !== "pending") {
    return (
      <p className={`guuey-chat-prompt-record guuey-chat-prompt-${item.state}`}>
        {item.promptKind}: {item.state}
      </p>
    );
  }
  return (
    <div className="guuey-chat-prompt" role="group">
      <p className="guuey-chat-prompt-ask">{`Link your account to ${item.appId}`}</p>
      <div className="guuey-chat-prompt-actions">
        <button
          ref={firstAction}
          type="button"
          className="guuey-chat-prompt-accept"
          onClick={() => ctx.onPromptAction?.(item, "accept")}
        >
          Allow
        </button>
        <button type="button" onClick={() => ctx.onPromptAction?.(item, "decline")}>
          Decline
        </button>
      </div>
      {item.raw !== null ? (
        <pre className="guuey-chat-prompt-raw">{JSON.stringify(item.raw, null, 2)}</pre>
      ) : null}
    </div>
  );
}

// ─── R16 ──────────────────────────────────────────────────────────────────

/**
 * A `role:"notice"` session annotation (spec draft.2) — a labeled,
 * non-conversational row that must never read as agent-authored. Calm
 * shows the quiet label; debug appends the provenance facet verbatim.
 */
export function DefaultNotice({ item, ctx }: ItemProps<NoticeItem>): ReactNode {
  return (
    <div className={item.failure !== undefined ? "guuey-chat-notice guuey-chat-notice-failure" : "guuey-chat-notice"} role="note">
      <span className="guuey-chat-notice-label">
        {ctx.strings.noticeLabel}
        {item.sourceLabel !== null ? ` · ${item.sourceLabel}` : ""}
      </span>
      {item.text !== "" && <span className="guuey-chat-notice-text">{item.text}</span>}
    </div>
  );
}

// ─── R11 ───────────────────────────────────────────────────────────────────

export function DefaultError({ item, ctx }: ItemProps<ErrorItem>): ReactNode {
  return (
    <div className={`guuey-chat-error guuey-chat-error-${item.family} guuey-chat-error-${item.tone === "retry" ? "retry" : "fault"}`} role="alert">
      <p>{item.copy}</p>
      {ctx.onErrorAction !== undefined && (item.family === "transient" || item.family === "auth") ? (
        <button type="button" className="guuey-chat-error-action" onClick={() => ctx.onErrorAction?.(item)}>
          {item.family === "auth" ? ctx.strings.errorAuth : ctx.strings.userRetry}
        </button>
      ) : null}
      {item.verbatim !== null ? <pre className="guuey-chat-error-verbatim">{item.verbatim}</pre> : null}
    </div>
  );
}

// ─── guuey#2355 ────────────────────────────────────────────────────────────

export interface ThreadClosedBannerProps {
  closed: ThreadClosedNotice;
  strings: ChatStrings;
  /** Opens a new conversation; the control is drawn only when given. */
  onStartNewConversation?: () => void;
}

/**
 * The agent ended this conversation: a status banner with the agent's own
 * message as plain text (never markdown, never HTML) and, when the host
 * wires it, the control that opens a new conversation.
 */
export function ThreadClosedBanner({ closed, strings, onStartNewConversation }: ThreadClosedBannerProps): ReactNode {
  return (
    <div className="guuey-chat-thread-closed" role="status" part={PARTS.threadClosed}>
      <strong className="guuey-chat-thread-closed-title">{strings.threadClosedTitle}</strong>
      <p className="guuey-chat-thread-closed-message">{closed.message}</p>
      {onStartNewConversation !== undefined ? (
        <button type="button" className="guuey-chat-thread-closed-start" onClick={onStartNewConversation}>
          {strings.threadClosedStartNew}
        </button>
      ) : null}
    </div>
  );
}

// ─── R13 / R14 / R15 ───────────────────────────────────────────────────────

export function DefaultHistoryBoundary({ item }: ItemProps<HistoryBoundaryItem>): ReactNode {
  return (
    <div
      className={`guuey-chat-history guuey-chat-history-${item.state}${item.state === "loading" ? " guuey-chat-shimmer" : ""}`}
      role="status"
    >
      {item.label}
    </div>
  );
}

export function DefaultCompaction({ item }: ItemProps<CompactionItem>): ReactNode {
  return (
    <div className="guuey-chat-compaction" role="separator">
      {item.label}
    </div>
  );
}

export function DefaultUnknown({ item, ctx }: ItemProps<UnknownItem>): ReactNode {
  return (
    <Collapsible
      itemKey={item.key}
      expanded={item.expanded}
      ctx={ctx}
      className="guuey-chat-unknown"
      header={
        <span>
          {item.label} <span className="guuey-chat-unknown-type">({item.typeName})</span>
        </span>
      }
    >
      {item.raw !== null ? (
        <pre className="guuey-chat-unknown-raw">{JSON.stringify(item.raw, null, 2)}</pre>
      ) : (
        <p className="guuey-chat-unknown-size">{ctx.strings.bytes(item.byteSize)}</p>
      )}
    </Collapsible>
  );
}

// ─── R12 / §4 ──────────────────────────────────────────────────────────────

export function DefaultStatus({ item }: ItemProps<StatusLineItem>): ReactNode {
  return (
    <p className={`guuey-chat-status guuey-chat-status-${item.state} guuey-chat-pulse`} role="status">
      {item.announce !== undefined ? (
        // guuey#2608: the ticking words are seen, not announced; the live
        // region reads the stable line, so it speaks once per attempt.
        <>
          <span aria-hidden="true">{item.copy}</span>
          <span className="guuey-chat-visually-hidden">{item.announce}</span>
        </>
      ) : (
        item.copy
      )}
      {item.detail !== null ? <span className="guuey-chat-status-detail"> · {item.detail}</span> : null}
    </p>
  );
}

// ─── The component map ─────────────────────────────────────────────────────

/** One component per §3 override slot. */
export interface TranscriptComponents {
  userMessage: ComponentType<ItemProps<UserMessageItem>>;
  /** R0b (guuey#2031): a card tap drawn before its turn is sent. */
  tap: ComponentType<ItemProps<TapItem>>;
  text: ComponentType<ItemProps<TextItem>>;
  reasoning: ComponentType<ItemProps<ReasoningItem>>;
  tool: ComponentType<ItemProps<ToolItem>>;
  toolGroup: ComponentType<ItemProps<ToolGroupItem>>;
  dataResult: ComponentType<ItemProps<DataResultItem>>;
  view: ComponentType<ItemProps<ViewMountItem>>;
  viewRef: ComponentType<ItemProps<ViewRefItem>>;
  media: ComponentType<ItemProps<MediaItem>>;
  code: ComponentType<ItemProps<CodeItem>>;
  citations: ComponentType<ItemProps<CitationsItem>>;
  prompt: ComponentType<ItemProps<PromptItem>>;
  notice: ComponentType<ItemProps<NoticeItem>>;
  error: ComponentType<ItemProps<ErrorItem>>;
  history: ComponentType<ItemProps<HistoryBoundaryItem>>;
  compaction: ComponentType<ItemProps<CompactionItem>>;
  unknown: ComponentType<ItemProps<UnknownItem>>;
  status: ComponentType<ItemProps<StatusLineItem>>;
}

export const defaultTranscriptComponents: TranscriptComponents = {
  userMessage: DefaultUserMessage,
  tap: DefaultTap,
  text: DefaultText,
  reasoning: DefaultReasoning,
  tool: DefaultTool,
  toolGroup: DefaultToolGroup,
  dataResult: DefaultDataResult,
  view: DefaultView,
  viewRef: DefaultViewRef,
  media: DefaultMedia,
  code: DefaultCode,
  citations: DefaultCitations,
  prompt: DefaultPrompt,
  notice: DefaultNotice,
  error: DefaultError,
  history: DefaultHistoryBoundary,
  compaction: DefaultCompaction,
  unknown: DefaultUnknown,
  status: DefaultStatus,
};

/** Dispatch one display item through the (possibly overridden) map. */
export function renderItem(
  item: DisplayItem,
  components: TranscriptComponents,
  ctx: TranscriptItemContext,
): ReactNode {
  switch (item.kind) {
    case "user": {
      const C = components.userMessage;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "tap": {
      const C = components.tap;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "text": {
      const C = components.text;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "reasoning": {
      const C = components.reasoning;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "tool": {
      const C = components.tool;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "tool-group": {
      const C = components.toolGroup;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "data-result": {
      const C = components.dataResult;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "view": {
      const C = components.view;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "viewRef": {
      const C = components.viewRef;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "media": {
      const C = components.media;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "code": {
      const C = components.code;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "citations": {
      const C = components.citations;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "prompt": {
      const C = components.prompt;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "notice": {
      const C = components.notice;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "error": {
      const C = components.error;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "history-boundary": {
      const C = components.history;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "compaction": {
      const C = components.compaction;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
    case "unknown": {
      const C = components.unknown;
      return <C key={item.key} item={item} ctx={ctx} />;
    }
  }
}
