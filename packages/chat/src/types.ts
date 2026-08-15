/**
 * The headless view-model's public types (wave-3a design §7, guuey#135).
 *
 * Everything here is DATA — no clocks, no DOM, no React. `planTranscript`
 * (see `plan.ts`) is a pure function of these inputs; the renderers (React in
 * 3b, RN in 3c) are thin walks of its output.
 *
 * Category vocabulary is ADOPTED from AgJSON (`@silverprotocol/core` owns
 * it — the spec's "adopt, never invent" invariant): the matrix rows R0–R15
 * map onto the fold's real block types plus `invokeTurn`'s turn-level
 * events. A category this UI needs but AgJSON cannot express is an upstream
 * silverprotocol change, never a guuey-side extension.
 */
import type { AgReduceResult, AgSource, JsonValue } from "@silverprotocol/core";
import type { AgentInvokeStatus, HistoryCard } from "@guuey/agent-client";
import type { ViewHostPhase, ViewMount, ViewMountChannel } from "@guuey/mcp-apps-host";

/**
 * One settled entry of the flat conversation transcript — structurally
 * compatible with the hook's `AgentMessage`, plus the optional
 * `clientMessageId` the R0 send-lifecycle join needs (the 3b live assembler
 * threads it through; history entries and older callers simply omit it).
 */
export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  /** Present on live-sent user turns — the `sendStates` join key (R0). */
  clientMessageId?: string;
}

/**
 * A pending/resolved consent or link ask (R10) — the turn-level
 * `profile-consent` / `profile-link` events lifted into renderable state.
 * The assembler (3b) accumulates these from `invokeTurn` events; `id` is
 * assembler-chosen and stable for the ask's lifetime.
 */
export interface PromptItemInput {
  id: string;
  kind: "consent" | "link";
  appId: string;
  requested: "read" | "read-write";
  state: "pending" | "answered" | "declined" | "dismissed";
}

/** Everything the plan derives from. All fields are data — no clocks, no DOM. */
export interface TranscriptInputs {
  /** The Reducer's fold (silver mode); null on bypass-frame streams. */
  result: AgReduceResult | null;
  /**
   * The in-flight turn's cumulative text fold (ALWAYS present; the sole
   * assistant text source in bypass mode). Ignored once `status` is back to
   * `ready` — the settled transcript owns finished turns — EXCEPT when
   * `aborted` is set, where it carries the kept partial (R1
   * aborted-partial).
   */
  assistantText: string;
  status: AgentInvokeStatus;
  /** Renderer-supplied elapsed ms in the current status; drives R12 escalation. */
  statusElapsedMs: number;
  activeTool: string | null;
  error: { message: string; code: string | null } | null;
  /** Pending/answered consent + link asks (R10). */
  prompts: PromptItemInput[];
  /**
   * The settled conversation, both roles, in order. Assistant entries are
   * the flat-text projection; when `result` is present the FOLD owns
   * assistant content and these entries' assistant text is not re-rendered
   * (one unified plan owns both — spec §9 Change-1).
   */
  messages: TranscriptMessage[];
  historyCards?: HistoryCard[];
  /** R13 rehydration state; absent means loaded. */
  historyState?: "loading" | "gone" | "loaded";
  /** R0: optimistic-send lifecycle, keyed by clientMessageId; absent = settled. */
  sendStates?: Readonly<Record<string, "sending" | "failed">>;
  /** mountKey → live phase (R6 states). Keys match `ViewMountItem.key`. */
  viewPhases?: Readonly<Record<string, ViewHostPhase>>;
  /** The last turn ended by user abort (R1 aborted-partial + "Stopped."). */
  aborted?: boolean;
  /**
   * The last turn was ADOPTED from history after a mid-stream stall
   * (guuey#192's watchdog). Calm renders it identically to a streamed turn;
   * debug appends the recovered marker (spec §3, F10). The hook sets this
   * in the 3b live assembler.
   */
  adopted?: boolean;
}

/** Stable per-item identity — survives streaming updates (spec §7). */
export type ItemKey = string;

/** User-toggled collapse state — OWNED by the renderer, passed in (purity). */
export type TranscriptOverrides = Readonly<Record<ItemKey, { expanded?: boolean }>>;

// ─── DisplayItem variants (one per matrix row) ─────────────────────────────

interface BaseItem {
  key: ItemKey;
  /** Resolved collapse state: policy default, then `overrides[key]` wins. */
  expanded: boolean;
}

/** R0 — the caller's own turn. */
export interface UserMessageItem extends BaseItem {
  kind: "user";
  text: string;
  state: "sending" | "sent" | "failed";
  /** The failed-state affordance (policy-gated); never silently disappears. */
  retry: boolean;
}

/** R1 — assistant text. */
export interface TextItem extends BaseItem {
  kind: "text";
  text: string;
  markdown: boolean;
  streaming: boolean;
  /** Aborted-partial: kept, marked with `strings.stopped`. */
  stopped: boolean;
}

/** R2 — reasoning. */
export interface ReasoningItem extends BaseItem {
  kind: "reasoning";
  label: string;
  text: string;
  streaming: boolean;
}

/** R5 — a data result, embedded inside its R3 row's expansion. */
export interface DataResultItem extends BaseItem {
  kind: "data-result";
  /**
   * A bounded pretty-printed preview — NEVER the full payload (the plan
   * stays cheap; fixture 6). Null for binary/unrenderable content.
   */
  preview: string | null;
  byteCount: number;
  state: "small" | "giant" | "binary" | "empty";
  showBytes: boolean;
}

/** R3 — one tool call lifecycle line. */
export interface ToolItem extends BaseItem {
  kind: "tool";
  toolCallId: string;
  /** The wire name. */
  name: string;
  /** The humanized display title (policy's humanizer). */
  title: string;
  state: "running" | "done" | "failed" | "orphaned";
  /** Bounded args preview (policy-gated); null when args are hidden. */
  argsPreview: string | null;
  /** The result inside this row's expansion (R5); null while running. */
  result: DataResultItem | null;
  /**
   * True when this call's result renders as its own transcript row (an R6
   * view) and calm folds this line into that row's chrome as attribution
   * instead of a standalone line (R4's display-bearing rule).
   */
  attribution: boolean;
}

/** R4 — a collapsed run of adjacent settled SILENT tools. */
export interface ToolGroupItem extends BaseItem {
  kind: "tool-group";
  label: string;
  tools: ToolItem[];
  failureCount: number;
  /** Non-empty when failureCount > 0 ("1 failed" — badge without unrolling). */
  failureBadge: string | null;
}

/** R6 — a renderable result mounting through the wave-2 host. */
export interface ViewMountItem extends BaseItem {
  kind: "view";
  /** The mount material; null when the locator is dead (R13 expired path). */
  mount: ViewMount | null;
  channel: ViewMountChannel | null;
  /** Live host phase, or the R13 dead-locator state. */
  phase: ViewHostPhase | "expired";
  /** The channel-aware state label the renderer shows for non-connected phases. */
  label: string | null;
  /** Calm chrome: "via {tool}" when this mount broke an R4 group. */
  attribution: string | null;
}

/** R7 — media blocks. */
export interface MediaItem extends BaseItem {
  kind: "media";
  media: "image" | "audio" | "file" | "document";
  source: AgSource;
  name: string | null;
  presentation: "inline" | "chip";
}

/** R8 — code blocks. */
export interface CodeItem extends BaseItem {
  kind: "code";
  language: string;
  code: string;
  wrap: boolean;
}

/** R9 — a citation run collapsed to a chip row. */
export interface CitationsItem extends BaseItem {
  kind: "citations";
  label: string;
  sources: { title: string | null; url: string | null }[];
  style: "chips" | "list";
}

/** R10 — a consent/link prompt card. */
export interface PromptItem extends BaseItem {
  kind: "prompt";
  promptKind: "consent" | "link";
  appId: string;
  requested: "read" | "read-write";
  state: "pending" | "answered" | "declined" | "dismissed";
  /** Raw ask payload, populated only under the debug policy. */
  raw: JsonValue | null;
}

/** R11 — a coded, human-worded error notice. */
export interface ErrorItem extends BaseItem {
  kind: "error";
  family: "auth" | "quota" | "transient" | "invalid";
  code: string | null;
  copy: string;
  /** The wire message verbatim, populated only under the debug policy. */
  verbatim: string | null;
}

/** R13 — history rehydration boundary states. */
export interface HistoryBoundaryItem extends BaseItem {
  kind: "history-boundary";
  state: "loading" | "gone";
  label: string;
}

/** R14 — the compaction divider. */
export interface CompactionItem extends BaseItem {
  kind: "compaction";
  label: string;
}

/** R15 — the trust invariant: labeled, collapsed, never blank, never raw. */
export interface UnknownItem extends BaseItem {
  kind: "unknown";
  label: string;
  typeName: string;
  byteSize: number;
  /** Pretty-printed payload, populated only under the debug policy. */
  raw: JsonValue | null;
}

export type DisplayItem =
  | UserMessageItem
  | TextItem
  | ReasoningItem
  | ToolItem
  | ToolGroupItem
  | DataResultItem
  | ViewMountItem
  | MediaItem
  | CodeItem
  | CitationsItem
  | PromptItem
  | ErrorItem
  | HistoryBoundaryItem
  | CompactionItem
  | UnknownItem;

/** R12/§4 — the derived status line with its resolved copy. */
export interface StatusLineItem {
  kind: "status";
  key: "status";
  state:
    | "connecting"
    | "starting"
    | "long-start"
    | "thinking"
    | "using-tool"
    | "aborted";
  copy: string;
  /** Literal state + elapsed, populated only under the debug policy. */
  detail: string | null;
}

export interface TranscriptPlan {
  /** Ordered, stable keys (spec §7's determinism contract). */
  items: DisplayItem[];
  /** Null when there is nothing to show (`ready`, `responding`). */
  status: StatusLineItem | null;
  /**
   * The #192 recovered-turn marker: the resolved marker string under the
   * debug policy when `inputs.adopted` is set, else null — calm plans stay
   * byte-identical to a streamed turn's (fixture 17).
   */
  recovery: string | null;
}
