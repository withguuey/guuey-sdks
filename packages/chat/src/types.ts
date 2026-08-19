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
import type {
  AgGrantMode,
  AgNoticeSource,
  AgPausedAsk,
  AgReduceResult,
  AgSource,
  JsonValue,
} from "@silverprotocol/core";
import type { AgentInvokeStatus, HistoryCard } from "@guuey/agent-client";
import type {
  ViewCspDiagnosis,
  ViewHostPhase,
  ViewMount,
  ViewMountChannel,
} from "@guuey/mcp-apps-host";

/**
 * One settled entry of the flat conversation transcript — structurally
 * compatible with the hook's `AgentMessage`, plus the optional
 * `clientMessageId` the R0 send-lifecycle join needs (the 3b live assembler
 * threads it through; history entries and older callers simply omit it).
 *
 * `role: "notice"` (spec draft.2, silverprotocol#16) is a host/adapter/
 * framework-injected session annotation — a PEER of user/assistant rows,
 * never assistant content. `noticeSource` is its provenance label (R16).
 */
export interface TranscriptMessage {
  role: "user" | "assistant" | "notice";
  text: string;
  /** Present on live-sent user turns — the `sendStates` join key (R0). */
  clientMessageId?: string;
  /** R16 provenance — meaningful only when `role === "notice"`. */
  noticeSource?: AgNoticeSource;
}

/**
 * A pending/resolved account-LINK invite (R10) — the turn-level
 * `profile-link` event lifted into renderable state. The assembler (3b)
 * accumulates these from `invokeTurn` events; `id` is assembler-chosen and
 * stable for the ask's lifetime. (Consent is NOT a profile arm any more:
 * since guuey#207 the pod asks over AgJSON `hitl.ask` + `turn.done
 * outcome:"paused"` with declared `grantModes`, and it renders through
 * {@link HitlPromptInput}.)
 */
export interface ProfilePromptInput {
  id: string;
  kind: "link";
  appId: string;
  requested: "read" | "read-write";
  state: "pending" | "answered" | "declined" | "dismissed";
}

/**
 * An AgJSON HITL ask (spec draft.2, silverprotocol#16) lifted from the
 * fold's PERSISTED declaration — the `AgPausedAsk` record in
 * `turn.done.outcome:"paused".asks[]` (the ask event itself is live-only;
 * the paused record is what a late-joining client renders from). Produced
 * by `hitlPromptsFromFold`; `id === ask.askId`.
 *
 * States encode guuey's ratified dismissal ruling (issue #16): `cancelled`
 * is still-pending-and-re-askable (the card stays answerable), `declined`
 * is the durable explicit deny.
 */
export interface HitlPromptInput {
  id: string;
  kind: "hitl";
  /** The persisted declaration — message, kind, and any declared grantModes. */
  ask: AgPausedAsk;
  state: "pending" | "resolved" | "declined" | "cancelled";
  /** Echo of the chosen declared mode; present iff `state === "resolved"`. */
  grantModeId?: string;
}

/**
 * R10 prompt inputs — a discriminated union (narrow on `kind`). The
 * profile arm is the guuey-wire LINK invite; `hitl` (spec draft.2) carries
 * every AgJSON ask, consent included. (Direct un-narrowed reads of
 * profile-only fields are the one shape this union retired — narrow first.)
 */
export type PromptItemInput = ProfilePromptInput | HitlPromptInput;

/** Everything the plan derives from. All fields are data — no clocks, no DOM. */
export interface TranscriptInputs {
  /**
   * The Reducer's fold (silver mode); null on bypass-frame streams.
   *
   * TURN-SCOPED (guuey#135 kit refinement): the fold owns the TRAILING
   * assistant turns it covers — its settled sources replace that many
   * trailing flat assistant entries, and any earlier flat entries (a
   * rehydrated/persisted prefix the session's Reducer never saw) render as
   * text in front. A fold spanning the whole conversation plans exactly as
   * before, so pure-live sessions are unaffected; persisted-overlay hosts
   * (portal's thread views) can now pass the session fold beside their
   * persisted rows instead of nulling it.
   */
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
  /** Pending/answered asks (R10): the link invite + AgJSON hitl asks (consent). */
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
  /**
   * mountKey → the host's CSP tripwire verdict (guuey#235): the embedding
   * page's own policy blocked the view. Renderer-supplied like
   * `viewPhases` (`<GuueyView onCspDiagnosis>` → `useTranscript`); a
   * `no-handshake` mount with a diagnosis labels the actionable cause
   * instead of the channel heuristic.
   */
  viewDiagnoses?: Readonly<Record<string, ViewCspDiagnosis>>;
  /**
   * The mount key a host-owned stage/canvas surface currently shows
   * (guuey#204 "promote and reference") — renderer-supplied state, like
   * `sendStates`. When set, the plan emits a compact {@link ViewRefItem}
   * in that mount's transcript slot instead of the full
   * {@link ViewMountItem}, so an interactive surface exists exactly ONCE.
   * Absent (or matching nothing / an expired mount) = today's behavior —
   * every mount renders inline. Hosts derive the key with
   * {@link newestViewKey} rather than hand-building it. Set per host
   * click (via `onViewRef`) this is the SELECTION half of guuey#301's
   * browser-history mechanic; the collapse-ALL-views half is the policy
   * knob `view.presentation: "chips"` — the two compose, this field alone
   * never chips more than the one promoted view.
   */
  promotedViewKey?: string;
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
  /**
   * The CSP tripwire's verdict when the embedding page blocked this view
   * (guuey#235) — WHY a `no-handshake`; `label` already carries its
   * message, this is the structured form for renderers/debug sinks.
   */
  diagnosis: ViewCspDiagnosis | null;
  /** Calm chrome: "via {tool}" when this mount broke an R4 group. */
  attribution: string | null;
  /** The producing call's humanized title (live mounts); null for history cards. */
  toolTitle: string | null;
  /**
   * The persisted `ui://` locator a mounted card's runtime actions bind to
   * (guuey#158) — the block's `uiData.resourceUri` for live mounts, the
   * card's own persisted identity for history snapshots; never a ggui
   * shell's synthetic payload uri. `null` → the host's relay answers its
   * in-band "not available" stub.
   */
  actionScope: string | null;
}

/**
 * R6's "promote and reference" chip (guuey#204): stands in for the ONE
 * {@link ViewMountItem} a host's stage/canvas currently shows
 * (`TranscriptInputs.promotedViewKey`), so the interactive surface exists
 * exactly once. `key` is the replaced mount's key — overrides and phase
 * reports keep their identity if the item swaps back to a full mount.
 */
export interface ViewRefItem extends BaseItem {
  kind: "viewRef";
  /** The display title (the producing call's, or the strings fallback). */
  title: string;
  /**
   * The full resolved chip text — `strings.viewPromoted(title)` for the
   * selected chip, `strings.viewChip(title)` / `viewChipExpired(title)`
   * for the rest under chips presentation (guuey#301).
   */
  label: string;
  /**
   * True when this chip's mount is the one the host's stage currently
   * shows (`key === promotedViewKey` and mountable). Renderers style it
   * as the active history entry (guuey#301).
   */
  selected: boolean;
  /**
   * The underlying mount's phase — chips presentation keeps expired /
   * unresolved views honest instead of hiding their state (guuey#301).
   */
  phase: ViewHostPhase | "expired";
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

/** R10 — the guuey-wire account-LINK prompt card (the original arm). */
export interface ProfilePromptItem extends BaseItem {
  kind: "prompt";
  /** The `PromptItemInput.id` this row records — the host's resolution key. */
  promptId: string;
  promptKind: "link";
  appId: string;
  requested: "read" | "read-write";
  state: "pending" | "answered" | "declined" | "dismissed";
  /** Raw ask payload, populated only under the debug policy. */
  raw: JsonValue | null;
}

/**
 * R10 — an AgJSON HITL ask card (spec draft.2). Display keys off each
 * mode's `label`/`description` ONLY — ids are echo-only identity, and
 * mode SEMANTICS are asker-scoped (normative: never hard-code meaning
 * onto an id string). `cancelled` renders as a dismissed record that is
 * still answerable when expanded (guuey's re-askable ruling); `declined`
 * and `resolved` are settled records.
 */
export interface HitlPromptItem extends BaseItem {
  kind: "prompt";
  promptId: string;
  promptKind: "hitl";
  /** The persisted declaration — carried so answer construction/validation has the record. */
  ask: AgPausedAsk;
  /** The asker's message, when it sent one. */
  message: string | null;
  askKind: AgPausedAsk["kind"];
  /** Declared accept variants; empty = a plain accept/decline ask. */
  grantModes: readonly AgGrantMode[];
  /**
   * The OAuth arm (guuey#178): set when the ask is `kind:"auth"` with
   * `authConfig.scheme:"oauth2"` + an `authorizationUrl`. There is no
   * answer door for this ask — a mode pick OPENS `authorizationUrl` with
   * `&mode=` + `&returnTo=` appended (`oauthAuthorizeHref`); "Not now" is a
   * plain dismissal. `null` for every other ask.
   */
  oauth: { authorizationUrl: string; scopes: readonly string[] } | null;
  state: "pending" | "resolved" | "declined" | "cancelled";
  /** Echo of the chosen mode id (identity, never displayed as meaning). */
  chosenModeId: string | null;
  /** Resolved display text for the chosen mode (label, else the id as literal text). */
  chosenModeLabel: string | null;
  /** Raw ask payload, populated only under the debug policy. */
  raw: JsonValue | null;
}

/** R10 union — narrow on `promptKind`. */
export type PromptItem = ProfilePromptItem | HitlPromptItem;

/**
 * R16 — a `role:"notice"` session annotation (spec draft.2): a labeled,
 * NON-conversational row that must never read as agent-authored.
 */
export interface NoticeItem extends BaseItem {
  kind: "notice";
  text: string;
  /** Provenance facet; null when the producer omitted it. */
  source: AgNoticeSource | null;
  /** Resolved provenance display — the facet verbatim under debug, else null. */
  sourceLabel: string | null;
}

/** R11 — a coded, human-worded error notice. */
export interface ErrorItem extends BaseItem {
  kind: "error";
  /**
   * The source message (wire body or client-side error copy), regardless of
   * policy — `copy` is the calm family sentence; overrides that keep a
   * surface's own voice (the widget renders pod messages verbatim) need the
   * original without opting into debug's `verbatim` formatting.
   */
  message: string;
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
  | ViewRefItem
  | MediaItem
  | CodeItem
  | CitationsItem
  | PromptItem
  | NoticeItem
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

/**
 * The debug sink's event union (spec §5's `onDebugEvent`, shipped as real
 * API in the #135 refinement wave) — built strictly from what the kit
 * actually knows, never invented telemetry:
 *
 *  - `view-phase`: an R6 mount's host-phase transition (incl. the R13
 *    `expired` verdict from a failed locator resolution);
 *  - `unknown-block`: an R15 sighting — a block type this kit version does
 *    not know rendered as a labeled row;
 *  - `turn-recovered`: the #192 adopted-turn marker resolved on the plan.
 *
 * The sink only fires under the debug policy (`debugDetail`) — `calm`
 * ignores it by design (spec §5's per-preset row).
 */
export type ChatDebugEvent =
  | {
      type: "view-phase";
      key: ItemKey;
      phase: ViewHostPhase | "expired";
      /** Present when the host's CSP tripwire diagnosed the failure (guuey#235). */
      diagnosis?: ViewCspDiagnosis;
    }
  | { type: "unknown-block"; key: ItemKey; typeName: string; byteSize: number }
  | { type: "turn-recovered"; marker: string };

/**
 * One renderable view the plan saw, BEFORE any chips/promotion pass —
 * the host-canvas contract (guuey#301): everything a stage needs to
 * render the selected mount and label a history rail, in transcript
 * order (history cards first, live mounts after — the same order the
 * items carry).
 */
export interface PlanViewSummary {
  key: ItemKey;
  /** The display title (the producing call's, or the strings fallback). */
  title: string;
  phase: ViewHostPhase | "expired";
  channel: ViewMountChannel | null;
  /** Null when the locator is dead (the R13 expired path). */
  mount: ViewMount | null;
  /** The persisted `ui://` locator actions bind to (guuey#158), or null. */
  actionScope: string | null;
  /**
   * Provenance: a LIVE fold mount vs a persisted HISTORY card. The roster
   * is in transcript order (history cards sit with the settled prefix), so
   * "newest" recency needs this — live outranks history, exactly
   * {@link newestViewKey}'s walk.
   */
  origin: "live" | "history";
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
  /**
   * Every view the plan saw (guuey#301's host-canvas contract) — present
   * regardless of `view.presentation`, so a stage can render the selected
   * mount even when the transcript shows only chips.
   */
  views: PlanViewSummary[];
}
