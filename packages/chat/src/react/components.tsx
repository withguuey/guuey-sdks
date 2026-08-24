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
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { GuueyView, type GuueyViewProps } from "@guuey/mcp-apps-host/react";
import type { ResolvedViewMount, ViewCspDiagnosis, ViewHostPhase } from "@guuey/mcp-apps-host";
import type { ChatStrings } from "../strings.js";
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
  ToolGroupItem,
  ToolItem,
  UnknownItem,
  UserMessageItem,
  TextItem,
  ViewMountItem,
  ViewRefItem,
} from "../types.js";
import { Markdown } from "./markdown.js";

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
  | "onReadResource"
  | "onSizeChanged"
  | "negotiationTimeoutMs"
  | "dangerouslyAddSandboxFlags"
  | "allow"
  | "sandboxPageUrl"
  | "autoResize"
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

export function DefaultUserMessage({ item, ctx }: ItemProps<UserMessageItem>): ReactNode {
  // guuey#422: a forwarded view directive renders as a calm continuation
  // row — the wire-verbatim text sits behind the expand, never rewritten.
  if (item.directive) {
    return (
      <div className={`guuey-chat-user guuey-chat-user-directive guuey-chat-user-${item.state}`}>
        <Collapsible
          itemKey={item.key}
          expanded={item.expanded}
          header={<span className="guuey-chat-directive-label">{ctx.strings.directiveContinuation}</span>}
          ctx={ctx}
        >
          {/* Verbatim quote — same never-rendered rule as the bubble. */}
          <div className="guuey-chat-user-bubble">{item.text}</div>
        </Collapsible>
        {item.state === "failed" ? (
          <p className="guuey-chat-send-failed" role="status">
            {ctx.strings.userCouldntSend}
            {item.retry ? (
              <button type="button" className="guuey-chat-retry" onClick={() => ctx.onRetry?.(item)}>
                {ctx.strings.userRetry}
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className={`guuey-chat-user guuey-chat-user-${item.state}`}>
      {/* User text is QUOTED, never rendered — whitespace preserved. */}
      <div className="guuey-chat-user-bubble">{item.text}</div>
      {item.state === "failed" ? (
        <p className="guuey-chat-send-failed" role="status">
          {ctx.strings.userCouldntSend}
          {item.retry ? (
            <button type="button" className="guuey-chat-retry" onClick={() => ctx.onRetry?.(item)}>
              {ctx.strings.userRetry}
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

// ─── R1 ────────────────────────────────────────────────────────────────────

export function DefaultText({ item, ctx }: ItemProps<TextItem>): ReactNode {
  return (
    <div
      className="guuey-chat-text"
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
  return (
    <div className={`guuey-chat-data guuey-chat-data-${item.state}`}>
      {item.state === "empty" ? (
        <p className="guuey-chat-data-empty">{ctx.strings.noOutput}</p>
      ) : item.preview === null ? (
        <p className="guuey-chat-data-binary">{bytes}</p>
      ) : (
        <>
          <pre className="guuey-chat-data-preview">{item.preview}</pre>
          <div className="guuey-chat-data-meta">
            {item.showBytes ? <span>{bytes}</span> : null}
            <CopyButton text={item.preview} ctx={ctx} />
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
  const expandable = item.argsPreview !== null || item.result !== null;
  const header = (
    <span className={`guuey-chat-tool-line guuey-chat-tool-${item.state}`}>
      <span aria-hidden="true" className="guuey-chat-tool-glyph">
        {TOOL_GLYPH[item.state]}
      </span>
      <span className="guuey-chat-tool-title">{item.title}</span>
      {item.state === "orphaned" ? (
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
    </Collapsible>
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

/** Inline images allow https URLs and image/* base64 data — nothing else. */
function imageSrc(item: MediaItem): string | null {
  const source = item.source;
  if (source.type === "url" && /^https:\/\//i.test(source.url)) return source.url;
  if (source.type === "base64" && /^image\//.test(source.mediaType)) {
    return `data:${source.mediaType};base64,${source.data}`;
  }
  return null;
}

export function DefaultMedia({ item }: ItemProps<MediaItem>): ReactNode {
  const [failed, setFailed] = useState(false);
  if (item.presentation === "inline" && item.media === "image" && !failed) {
    const src = imageSrc(item);
    if (src !== null) {
      return (
        <a className="guuey-chat-media-image" href={src} target="_blank" rel="noopener noreferrer">
          <img src={src} alt={item.name ?? ""} onError={() => setFailed(true)} />
        </a>
      );
    }
  }
  if (item.media === "audio" && item.source.type === "url" && /^https:\/\//i.test(item.source.url)) {
    return <audio className="guuey-chat-media-audio" controls src={item.source.url} />;
  }
  // Attachment chip: files, documents, unloadable/oversized media.
  return (
    <span className={`guuey-chat-media-chip guuey-chat-media-${item.media}`}>
      {item.name ?? item.media}
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
    return (
      <div className="guuey-chat-prompt" role="group">
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
    <div className="guuey-chat-notice" role="note">
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
    <div className={`guuey-chat-error guuey-chat-error-${item.family}`} role="alert">
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
      {item.copy}
      {item.detail !== null ? <span className="guuey-chat-status-detail"> · {item.detail}</span> : null}
    </p>
  );
}

// ─── The component map ─────────────────────────────────────────────────────

/** One component per §3 override slot. */
export interface TranscriptComponents {
  userMessage: ComponentType<ItemProps<UserMessageItem>>;
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
