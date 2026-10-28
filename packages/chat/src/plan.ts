/**
 * `planTranscript` — the headless view-model (wave-3a design §7, guuey#135).
 *
 * A PURE function: folded AgJSON + the flat status surface in, an ordered
 * display list with stable keys out. No clocks (elapsed time is an input),
 * no DOM, no React. Determinism contract: same inputs + policy + overrides
 * ⇒ deeply equal plan — the fixture corpus asserts this literally.
 *
 * Source-ownership rules (spec §9 Change-1 — one unified plan owns both):
 *
 *  - USER rows always come from the flat `inputs.messages`.
 *  - ASSISTANT content comes from the fold (`inputs.result`) for the
 *    TRAILING turns the fold covers; earlier flat assistant entries (a
 *    rehydrated/persisted prefix the session's Reducer never saw) render as
 *    text slots in front (the turn-scoped refinement — see
 *    `TranscriptInputs.result`). Without a fold, flat entries plus the
 *    in-flight `assistantText` own everything. Both paths normalize to the
 *    same block walk, so a silver stream carrying only text plans
 *    byte-identically to a bypass stream (fixture 5).
 *  - Interleaving is conversational alternation (user[i] then assistant[i]) —
 *    the transcript invariant of a request/reply chat. History cards are
 *    placed by read-plane seq: before the first seq-bearing user or
 *    assistant text row newer than the card, so a card stored inside a turn
 *    sits between that turn's text rows.
 *
 * Key scheme (stable across streaming updates): `u{slot}` user rows,
 * `a{slot}.t{n}`/`.r{n}`/`.m{n}`/`.c{n}`/`.d{n}`/`.s{n}`/`.k{n}`/`.u{n}`
 * per-kind ordinals inside an assistant slot, `tool.{toolCallId}` tool rows
 * (the id survives `running → done` — spec §7), `view.{toolCallId}` mounts,
 * `g.{firstToolKey}` derived groups, `card.{seq}` history cards, `p.{id}`
 * prompts, `error`, `history` boundaries. Append-only streams only ever
 * append ordinals, so every existing key survives each re-plan.
 */
import { JsonValue, type AgBlock, type AgReduceResult } from "@silverprotocol/core";
import {
  ELIDED_VALUE_MARKER,
  isElidedValue,
  isJsonObject,
  isViewDirectiveText,
  readTapLabels,
  snapshotViewMount,
  snapshotViewToolData,
  toolResultLocator,
  toolResultRenderRefusal,
  toolCallViewInput,
  toolResultViewMount,
  uiResourceChannel,
  viewToolData,
  type ViewMount,
} from "@guuey/mcp-apps-host";
import type { HistoryCard, HistoryToolCall, HistoryToolResult } from "@guuey/agent-client";
import type { TranscriptPolicy } from "./policy.js";
import { prettyJson } from "./highlight.js";
import { mediaDisplay } from "./media.js";
import { grantModeDisplay, hitlAnswerChannel } from "./hitl.js";
import { authRequiredFromAsks, oauthAuthorizeAsk } from "./oauth.js";
import { isGguiConsumeTool, isGguiProtocolTool } from "./listen.js";
import type {
  CitationsItem,
  DataResultItem,
  DisplayItem,
  ItemKey,
  MediaItem,
  NoticeItem,
  PlanViewSummary,
  StatusLineItem,
  ToolGroupItem,
  ToolItem,
  TranscriptInputs,
  TranscriptOverrides,
  TranscriptPlan,
  UnknownItem,
  ViewMountItem,
  ViewRefItem,
} from "./types.js";

/** R5's giant threshold: above this byte count the state is `giant`. */
const GIANT_RESULT_BYTES = 16_384;

type ToolResultBlock = Extract<AgBlock, { type: "tool-result" }>;

/** Approximate byte size of a JSON value — deterministic, allocation-bounded. */
function jsonByteSize(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : text.length;
}

/** Bounded (optionally pretty-printed) preview — never the full payload. */
function boundedPreview(value: unknown, previewChars: number, pretty = true): string | null {
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  if (text === undefined) return null;
  return text.length > previewChars ? text.slice(0, previewChars) : text;
}

/**
 * A JSON round-trip clone: any serializable value becomes a `JsonValue`
 * without asserting a shape the source type does not promise. The parse is
 * `unknown` until the protocol's own `JsonValue` schema reads it; a value it
 * does not read (none should, after a round trip) is shown as no raw value.
 */
function jsonClone(value: unknown): JsonValue | null {
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  const parsed: unknown = JSON.parse(text);
  const read = JsonValue.safeParse(parsed);
  return read.success ? read.data : null;
}

function resolveExpanded(
  key: ItemKey,
  policyDefault: boolean,
  overrides: TranscriptOverrides,
): boolean {
  const override = overrides[key]?.expanded;
  return override ?? policyDefault;
}

/** One assistant slot's renderable content, normalized across both sources. */
interface AssistantSource {
  blocks: AgBlock[];
  live: boolean;
  stopped: boolean;
  /**
   * The read-plane seq of the flat row each block came from, index-aligned
   * with `blocks` (guuey#2400). Only a rehydrated flat slot carries it; a
   * fold source has no read-plane seqs. A history card anchors on the first
   * seq-bearing row newer than it, so a card stored inside a turn lands
   * between that turn's text rows, where it was drawn live.
   */
  blockSeqs?: Array<number | undefined>;
  /**
   * guuey#2388: the reloaded calls this flat group holds, by `toolCallId`
   * (`TranscriptInputs.historyTools`). The tool-call arm reads a call's card
   * here, and tells a reloaded call the read gave no result from a live one.
   */
  historyCalls?: Map<string, HistoryToolCall>;
}

/** A fold-borne `role:"notice"` row, anchored to the source it followed. */
interface FoldNotice {
  text: string;
  source: NoticeItem["source"];
  /** Index into the returned sources of the message this notice followed; -1 = before any. */
  afterSourceIndex: number;
}

/** R16 notice text: the message's text blocks, joined (non-text blocks carry no notice prose). */
function noticeText(content: readonly AgBlock[]): string {
  return content
    .filter((b): b is Extract<AgBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * The fold's sources, its notices, and the two facts the seam reads from it:
 *
 *  - `sourceTurns`: for each source, the index in `result.turns` of the turn
 *    it belongs to, which is the space a user row's `precedingTurnCount`
 *    counts in. Null when a source cannot be tied to a turn record (a fold
 *    without turn identity), and then the seam keeps its count-based rule.
 *  - `pendingTurn`: that count-based rule's covered-but-sourceless turn: an
 *    in-flight turn with no frame folded yet.
 */
function foldAssistantSources(
  result: AgReduceResult,
  inFlight: boolean,
  aborted: boolean,
): {
  sources: AssistantSource[];
  notices: FoldNotice[];
  sourceTurns: number[] | null;
  pendingTurn: boolean;
} {
  // Real pod folds carry `tool-result` blocks in separate `role: "tool"`
  // messages between assistant turns (the production ggui-render capture is
  // the receipt — guuey#135 3b widget convergence found this): an
  // assistant-only filter orphans every call and drops every mount. A tool
  // message's blocks belong to the PRECEDING assistant slot's walk, exactly
  // the whole-fold message order the retired first-party renderers used.
  //
  // LIVE detection is turn-identity-based where the fold carries it: while
  // a turn is in flight, an assistant message whose `turnId` maps to a turn
  // record WITHOUT an `outcome` belongs to the open turn — settled earlier
  // turns stay settled even mid-session (what makes the tail alignment
  // below count them correctly). Nothing is live once the status is back to
  // `ready`, whatever the records say (a fold that missed `turn.done` must
  // not pin a settled turn open forever). Folds without turn identity (a
  // hand-driven fold that never saw `turn.*` lifecycle) fall back to the
  // last-source-is-live-iff-in-flight heuristic — the pre-refinement
  // behaviour, kept so identity-less folds plan exactly as before.
  const openTurns = new Set(
    result.turns.filter((t) => t.outcome === undefined).map((t) => t.turnId),
  );
  const hasTurnIdentity = result.messages.some(
    (m) => m.role === "assistant" && m.turnId !== undefined,
  );
  // ONE source per conversational TURN, not per assistant message segment
  // (guuey#306 — the mis-slotting bug): a pod fold emits SEVERAL assistant
  // messages per turn (thought/text/tool interleave — a generative-card
  // turn is ~6-8 segments), and the conversation loop pairs users to
  // sources BY SLOT — per-segment sources stretched the index space, so
  // from turn 2 on every user bubble rendered clustered inside turn 1's
  // segment run. Grouping: a `user` row closes the current group (the
  // fold's messages are the whole conversation, users included), and a
  // turnId CHANGE between assistant segments splits too (identity beats
  // adjacency — two turns without an intervening user row still separate).
  const sources: AssistantSource[] = [];
  const notices: FoldNotice[] = [];
  /** Sources holding a message of a turn the fold has not seen end (no `outcome`). */
  const openSources = new Set<AssistantSource>();
  const turnIndexById = new Map(result.turns.map((t, i) => [t.turnId, i]));
  /** Index-aligned with `sources`: the turn record each one belongs to (its first known turnId). */
  const sourceTurnIndex: Array<number | undefined> = [];
  let current: AssistantSource | null = null;
  let currentTurnId: string | undefined;
  for (const m of result.messages) {
    if (m.role === "user") {
      current = null;
      currentTurnId = undefined;
    } else if (m.role === "assistant") {
      const startsNewTurn =
        current === null ||
        (m.turnId !== undefined && currentTurnId !== undefined && m.turnId !== currentTurnId);
      if (startsNewTurn) {
        current = { blocks: [], live: false, stopped: false };
        sources.push(current);
        sourceTurnIndex.push(undefined);
        currentTurnId = undefined;
      }
      if (m.turnId !== undefined) currentTurnId = m.turnId;
      const at = sources.length - 1;
      if (sourceTurnIndex[at] === undefined && m.turnId !== undefined) sourceTurnIndex[at] = turnIndexById.get(m.turnId);
      current!.blocks.push(...m.content);
      if (hasTurnIdentity && m.turnId !== undefined && openTurns.has(m.turnId)) {
        openSources.add(current!);
        if (inFlight) current!.live = true;
      }
    } else if (m.role === "tool" && sources.length > 0) {
      // Tool results belong to the turn in progress — or, when they trail a
      // user boundary before the next assistant segment, to the PRECEDING
      // turn (the pre-#306 last-source semantics, kept).
      (current ?? sources[sources.length - 1]!).blocks.push(...m.content);
    } else if (m.role === "notice") {
      // R16 (spec draft.2): a session annotation — a PEER row, never folded
      // into assistant content; it anchors after the source it followed.
      notices.push({
        text: noticeText(m.content),
        source: m.noticeSource ?? null,
        afterSourceIndex: sources.length - 1,
      });
    }
  }
  const last = sources[sources.length - 1];
  if (last) {
    if (!hasTurnIdentity) last.live = inFlight;
    // guuey#2445: the stop marker belongs to the stopped turn's own source.
    // With turn identity that is the last source only when it holds the open
    // turn: a turn stopped before its first frame has no source at all, and
    // the settled answer in front of it is not the one that stopped.
    last.stopped = aborted && (!hasTurnIdentity || openSources.has(last));
  }
  const sourceTurns = sourceTurnIndex.every((t): t is number => t !== undefined) ? sourceTurnIndex : null;
  // The count-based seam's turn that is covered but has no source yet: in
  // flight, before its first frame. The stamp-anchored seam (planTranscript)
  // needs no such guess and does not read it.
  const pendingTurn = !hasTurnIdentity
    ? inFlight && !sources.some((s) => s.live)
    : inFlight && openSources.size === 0;
  return { sources, notices, sourceTurns, pendingTurn };
}

/**
 * Flat assistant rows grouped by conversational ORDER (guuey#306): a user
 * row closes the current slot, consecutive assistant rows merge into one —
 * the assembler's interleave IS the turn structure, and the old
 * filter/zip threw it away (double/empty assistant rows drifted every
 * later user bubble by one). Shared by the flat path and the fold-vs-flat
 * seam, so both count the same slots.
 */
/**
 * The settled flat groups AND, from the SAME walk, how many groups already
 * existed when each user row was seen (guuey#1333). Deriving the order here
 * rather than in a second pass is deliberate: a separate walk could drift
 * from the grouping rules below (notably guuey#1101's empty slot), and a
 * drifted order is a mis-pairing that tests green.
 *
 * This is the REHYDRATED path's interleave key. A reloaded session carries
 * both roles in `messages` in order, so the chronology is already present —
 * it needs no assembler stamp and no wire change. Without it a reloaded
 * session containing a bound hello (#1183's bootstrap door — a platform
 * feature, so ANY app carrying one is count-mismatched from its first
 * exchange) rendered `hey / welcome card`, the same face as the live bug.
 */
function flatSettledGroups(
  messages: TranscriptInputs["messages"],
  historyTools: TranscriptInputs["historyTools"],
): {
  groups: AssistantSource[];
  userOrder: number[];
} {
  const groups: AssistantSource[] = [];
  const userOrder: number[] = [];
  let current: AssistantSource | null = null;
  // A user row seen with no assistant row after it yet.
  let openUserTurn = false;
  // guuey#2388: the read's tool entries, spliced in by `seq`. A tool-only row
  // never enters `messages`, so its entries are placed against the rows that
  // did: each entry acts like an agent row (it joins the open group or opens
  // one, and closes the user turn), so a turn whose agent rows were all
  // tool-only fills its guuey#1101 slot instead of leaving it empty.
  const entries = historyToolEntries(historyTools);
  let nextEntry = 0;
  /** Place every entry not yet placed whose seq passes `due`, in seq order. */
  const flushEntries = (due: (seq: number) => boolean): void => {
    while (nextEntry < entries.length && due(entries[nextEntry]!.seq)) {
      const entry = entries[nextEntry++]!;
      if (current === null) {
        current = { blocks: [], live: false, stopped: false, blockSeqs: [] };
        groups.push(current);
      }
      if (entry.kind === "call") {
        const { toolCallId, name, title, input } = entry.call.call;
        current.blocks.push({ type: "tool-call", toolCallId, name, input, ...(title !== undefined ? { title } : {}) });
        (current.historyCalls ??= new Map()).set(toolCallId, entry.call);
      } else {
        current.blocks.push(entry.result.block);
      }
      current.blockSeqs?.push(entry.seq);
      openUserTurn = false;
    }
  };
  for (const m of messages) {
    const seq = m.seq;
    // Before a row with a seq: every entry older than it. At the first row
    // without one (a live row: the send after a reload): EVERY entry left, so
    // a trailing tool-only turn closes its own turn and never opens the group
    // the new send's reply pairs with (guuey#2676's face).
    flushEntries(seq !== undefined ? (s) => s < seq : () => true);
    if (m.role === "user") {
      // guuey#1101: a user turn CLOSED by the next user row with no assistant
      // rows between is an EMPTY slot, never a vanished one. The history
      // mapping drops text-less agent rows (an aborted turn persists five of
      // them and a card), so without this the next turn's answer paired with
      // THIS turn's bubble and the card spliced before the wrong user
      // (`u0 → "Bye!" → card → u1`, QA's reloaded Playground). The trailing
      // user turn is left open on purpose: its assistant is the in-flight or
      // abort-kept partial that `flatAssistantSources` appends.
      if (openUserTurn) groups.push({ blocks: [], live: false, stopped: false });
      userOrder.push(groups.length);
      current = null;
      openUserTurn = true;
    } else if (m.role === "assistant") {
      if (current === null) {
        current = { blocks: [], live: false, stopped: false, blockSeqs: [] };
        groups.push(current);
      }
      // A rehydrated row's narration plans as the interim text it was live, before its answer.
      for (const line of m.narration ?? []) {
        current.blocks.push({ type: "text", text: line, phase: "interim" });
        current.blockSeqs?.push(m.seq);
      }
      current.blocks.push({ type: "text", text: m.text });
      current.blockSeqs?.push(m.seq);
      openUserTurn = false;
    }
    // An entry stored on this row itself goes right after its text.
    if (seq !== undefined) flushEntries((s) => s <= seq);
  }
  flushEntries(() => true);
  return { groups, userOrder };
}

/** One reloaded tool entry: a stored call, or a stored result no card stands for. */
type HistoryToolEntry =
  | { kind: "call"; seq: number; call: HistoryToolCall }
  | { kind: "result"; seq: number; result: HistoryToolResult };

/** The read's calls and results in one list by seq; at an equal seq a call comes before a result. */
function historyToolEntries(historyTools: TranscriptInputs["historyTools"]): HistoryToolEntry[] {
  if (historyTools === undefined) return [];
  const entries: HistoryToolEntry[] = [
    ...historyTools.calls.map((call): HistoryToolEntry => ({ kind: "call", seq: call.seq, call })),
    ...historyTools.results.map((result): HistoryToolEntry => ({ kind: "result", seq: result.seq, result })),
  ];
  // A stable sort keeps the call-first order of equal seqs.
  return entries.sort((a, b) => a.seq - b.seq);
}

/** The seam clamped into the flat groups: never negative, never past the last group. */
function clampSeam(keep: number, flatGroups: number): number {
  return Math.max(0, Math.min(flatGroups, keep));
}

/** Whether a flat group holds anything to draw (guuey#1101's empty slot and an empty placeholder do not). */
function hasDrawableText(group: AssistantSource): boolean {
  return group.blocks.some((b) => b.type !== "text" || b.text.trim() !== "");
}

/**
 * guuey#2445 — the conversation from the first stamped user row on, one user
 * row at a time, in the rows' own order. The rows are the authority for which
 * user rows there are and where each sits: after a history read replaced them
 * (the hook adopting a cut turn), they hold every send, including one this
 * client never made (another tab on the same thread) and the reader line of a
 * failed turn. The fold is the authority for the replies it streamed, and it
 * is tied to the rows by the stamps alone:
 *
 *  - A stamped row owns the fold's sources from its stamp up to the next
 *    stamped row's (a send answered in two turns owns both). Every fold source
 *    from the anchor on falls in exactly one such range.
 *  - A row that owns no fold source draws its own flat group when that has
 *    text: an unstamped row (a send the fold never saw), or a stamped send
 *    whose reply the fold never saw (a turn adopted with no assistant frame,
 *    or a stopped send whose answer the pod stored anyway).
 *  - Otherwise the row owns one EMPTY slot, as guuey#1101 gives a flat user row
 *    with no reply: a send stopped, failed or cut before its first frame. It
 *    draws nothing, and it gives the row a place of its own for what follows
 *    it (a failed turn's notice), so the next row never shares it.
 *
 * Every row from the anchor on therefore owns at least one slot, in order,
 * with nothing counted: no fold source is dropped or drawn twice, and no flat
 * group is drawn where the fold holds its reply.
 *
 * Returns the suffix's sources in order, the slot each row from the anchor on
 * precedes, the last slot each one owns, and the slot of each fold source, all
 * offset by `keep` (the flat prefix in front).
 */
function liveSuffix(
  users: readonly TranscriptInputs["messages"][number][],
  firstLive: number,
  flat: { groups: readonly AssistantSource[]; userOrder: readonly number[] },
  foldSources: readonly AssistantSource[],
  sourcesBefore: (turnCount: number) => number,
  keep: number,
): {
  sources: AssistantSource[];
  userSlots: Map<number, number>;
  userEnds: Map<number, number>;
  foldSlots: number[];
} {
  /** Each row's stamp as fold sources before it; undefined on an unstamped row. */
  const from = users.map((u) => (u.precedingTurnCount !== undefined ? sourcesBefore(u.precedingTurnCount) : undefined));
  const sources: AssistantSource[] = [];
  const userSlots = new Map<number, number>();
  const userEnds = new Map<number, number>();
  const foldSlots: number[] = [];
  /** Place the fold's sources up to (not including) `end`, each once, in fold order. */
  const placeFoldSourcesBefore = (end: number): void => {
    for (const source of foldSources.slice(foldSlots.length, end)) {
      foldSlots.push(keep + sources.length);
      sources.push(source);
    }
  };
  // Fold sources of turns before the first live send (an unprompted greeting)
  // stand in for the flat groups `keep` left out in front of the anchor.
  placeFoldSourcesBefore(from[firstLive] ?? 0);
  for (let i = firstLive; i < users.length; i++) {
    userSlots.set(i, keep + sources.length);
    const placedBefore = sources.length;
    const start = from[i];
    if (start !== undefined) {
      const next = from.slice(i + 1).find((f): f is number => f !== undefined);
      placeFoldSourcesBefore(next ?? foldSources.length);
    }
    if (sources.length === placedBefore) {
      const at = flat.userOrder[i] ?? flat.groups.length;
      const ownsGroup = at < (flat.userOrder[i + 1] ?? flat.groups.length);
      const own = ownsGroup ? flat.groups[at] : undefined;
      sources.push(own !== undefined && hasDrawableText(own) ? own : { blocks: [], live: false, stopped: false });
    }
    userEnds.set(i, keep + sources.length - 1);
  }
  placeFoldSourcesBefore(foldSources.length);
  return { sources, userSlots, userEnds, foldSlots };
}

function flatAssistantSources(inputs: TranscriptInputs, inFlight: boolean): AssistantSource[] {
  const settled: AssistantSource[] = flatSettledGroups(inputs.messages, inputs.historyTools).groups;
  // The in-flight (or abort-kept) partial is its own trailing slot — settled
  // turns live in `messages`; `assistantText` is ignored once `ready` again
  // UNLESS the turn ended by abort (R1 aborted-partial keeps it).
  if (inputs.assistantText !== "" && (inFlight || inputs.aborted === true)) {
    settled.push({
      blocks: [{ type: "text", text: inputs.assistantText }],
      live: inFlight,
      stopped: inputs.aborted === true,
    });
  }
  return settled;
}

/** The parts of a tool result that render as their own R7 rows (guuey#2369). */
type PromotedMediaBlock = Extract<AgBlock, { type: "image" | "audio" }>;

function isPromotedMedia(b: AgBlock): b is PromotedMediaBlock {
  return b.type === "image" || b.type === "audio";
}

/** An R7 row's planned presentation and load decision, shared by top-level and tool-born media. */
function mediaItem(
  key: ItemKey,
  block: Extract<AgBlock, { type: "image" | "audio" | "file" | "document" }>,
  toolCallId: string | null,
  policy: TranscriptPolicy,
  overrides: TranscriptOverrides,
): MediaItem {
  const name =
    block.type === "file" ? (block.filename ?? null) : block.type === "document" ? (block.title ?? null) : null;
  const presentation: MediaItem["presentation"] =
    policy.media.chipOnly || block.type === "file" || block.type === "document" ? "chip" : "inline";
  return {
    kind: "media",
    key,
    expanded: resolveExpanded(key, true, overrides),
    media: block.type,
    source: block.source,
    name,
    presentation,
    display: mediaDisplay(block.type, block.source, presentation === "inline", policy.media),
    toolCallId,
  };
}

/**
 * guuey#2369 — a tool result's image and audio parts, as R7 rows that render
 * in flow after the call's row (R4's display-bearing rule). They show even
 * when the ggui filter hides the row itself, like a view mount.
 */
function toolResultMediaItems(
  block: ToolResultBlock,
  policy: TranscriptPolicy,
  overrides: TranscriptOverrides,
): MediaItem[] {
  return block.content
    .filter(isPromotedMedia)
    .map((part, i) => mediaItem(`media.${block.toolCallId}.${i}`, part, block.toolCallId, policy, overrides));
}

/**
 * The `bytes` a persistence elision marker records (the UTF-8 length of the
 * elided value's JSON), or 0 when it records no usable count.
 */
function elidedMarkerBytes(marker: JsonValue): number {
  const inner = isJsonObject(marker) ? marker[ELIDED_VALUE_MARKER] : undefined;
  const bytes = isJsonObject(inner) ? inner["bytes"] : undefined;
  return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0;
}

/**
 * R5 for a tool result. Image and audio parts are not part of it — they
 * render as their own rows — so a result made only of them has no data row
 * (null) instead of a byte count. A `structuredContent` read back from the
 * store as the elision marker (guuey#2388; live never produces one) is a
 * giant result of the marker's recorded size, with no preview: the marker is
 * not the tool's output and is never shown.
 */
function dataResultFromToolResult(
  block: ToolResultBlock,
  key: ItemKey,
  policy: TranscriptPolicy,
  overrides: TranscriptOverrides,
): DataResultItem | null {
  const payload = block.structuredContent !== undefined ? block.structuredContent : undefined;
  const textParts = block.content
    .filter((b): b is Extract<AgBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .filter((t) => t !== "");
  // Files and documents stay inside the row; image and audio are promoted.
  const mediaParts = block.content.filter((b) => b.type === "file" || b.type === "document");
  const promoted = block.content.some(isPromotedMedia);

  let state: DataResultItem["state"];
  let preview: string | null;
  let byteCount: number;
  // guuey#2367: the readable whole (when it is not giant) and its language.
  let whole: string | null = null;
  let lang: "json" | undefined;
  if (payload !== undefined && isElidedValue(payload)) {
    byteCount = elidedMarkerBytes(payload);
    preview = null;
    state = "giant";
  } else if (payload !== undefined) {
    byteCount = jsonByteSize(payload);
    preview = boundedPreview(payload, policy.dataResult.previewChars, policy.dataResult.prettyPrint);
    state = byteCount > GIANT_RESULT_BYTES ? "giant" : "small";
    lang = "json";
    if (state === "small") {
      const text = policy.dataResult.prettyPrint ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
      whole = text === undefined ? null : text;
    }
  } else if (textParts.length > 0) {
    const joined = textParts.join("\n");
    byteCount = joined.length;
    state = byteCount > GIANT_RESULT_BYTES ? "giant" : "small";
    // Text that IS JSON (most MCP tools return JSON as text) reads pretty-printed.
    const pretty = state === "small" && policy.dataResult.prettyPrint ? prettyJson(joined) : null;
    const readable = pretty ?? joined;
    if (pretty !== null) lang = "json";
    whole = state === "small" ? readable : null;
    preview =
      readable.length > policy.dataResult.previewChars
        ? readable.slice(0, policy.dataResult.previewChars)
        : readable;
  } else if (mediaParts.length > 0) {
    byteCount = jsonByteSize(mediaParts);
    preview = null;
    state = "binary";
  } else if (block.errorText !== undefined && block.errorText !== "") {
    byteCount = block.errorText.length;
    preview = block.errorText;
    state = "small";
  } else if (promoted) {
    return null;
  } else {
    byteCount = 0;
    preview = null;
    state = "empty";
  }

  return {
    kind: "data-result",
    key,
    expanded: resolveExpanded(key, true, overrides),
    preview,
    byteCount,
    state,
    showBytes: policy.dataResult.alwaysShowBytes || state === "giant",
    ...(whole !== null && preview !== null && whole.length > preview.length ? { full: whole } : {}),
    ...(lang !== undefined && preview !== null ? { lang } : {}),
  };
}

function toolFailed(result: ToolResultBlock): boolean {
  if (result.isError === true) return true;
  const outcome = result.outcome;
  // `input_required` is a pause (its ask surfaces through R10's hitl twin),
  // not a failure — only error/denied read as ✕.
  if (outcome === "error" || outcome === "denied") return true;
  if (outcome === undefined) return result.errorText !== undefined && result.errorText !== "";
  return false;
}

/**
 * The sandbox-trust channel a view item will MOUNT on. For a resolved mount
 * that is the mount's own channel; for the `"locator"` arm it is what the
 * reader will assign at resolution — derived from the requested uri
 * (`uiResourceChannel`), the same rule the reader itself applies. Since the
 * ggui vendor arm retired (guuey#209) every live ggui card is a locator at
 * plan time, so the channel-aware label must look through the arm.
 */
function trustChannel(item: Pick<ViewMountItem, "mount" | "channel">): "inline" | "ggui" | null {
  if (item.mount === null) return item.channel === "ggui" || item.channel === "inline" ? item.channel : null;
  return item.mount.channel === "locator" ? uiResourceChannel(item.mount.resourceUri) : item.mount.channel;
}

function viewLabel(
  item: Pick<ViewMountItem, "phase" | "channel" | "mount" | "diagnosis">,
  policy: TranscriptPolicy,
): string | null {
  const s = policy.strings;
  switch (item.phase) {
    case "connected":
      return null;
    case "negotiating":
      return s.viewNegotiating;
    case "expired":
      return s.viewExpired;
    case "no-handshake":
      // The host's CSP tripwire outranks the channel heuristic (guuey#235):
      // a blocked runtime never negotiates on ANY channel, and the verdict
      // is actionable — name the blocked URI and the allowance.
      if (item.diagnosis !== null) return s.viewCspBlocked(item.diagnosis);
      // Channel-aware (R6): a ggui shell that never handshakes is a boot
      // failure; inline tenant HTML may legitimately be a non-App document.
      // Keyed on the TRUST channel (locators resolve to it by uri), not the
      // mount arm — a live ggui card is a locator until its read lands.
      return trustChannel(item) === "ggui" ? s.viewBootFailure : s.viewInlineFallback;
  }
}

/**
 * guuey#847 — true when a JSON value carries no information a reader could
 * act on: `null`/`undefined`, the empty string, an empty array or object, or
 * an array/object whose every member is itself informationless. Numbers and
 * booleans are information (a `0` or `false` says something); a non-empty
 * string is. Vendor-neutral by construction — the rule reads the payload's
 * shape, never the vendor or a key name.
 */
function isInformationless(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value === "";
  if (typeof value === "number" || typeof value === "boolean") return false;
  if (Array.isArray(value)) return value.every((v) => isInformationless(v));
  return Object.values(value).every((v) => isInformationless(v));
}

function unknownFromValue(
  key: ItemKey,
  typeName: string,
  value: unknown,
  policy: TranscriptPolicy,
  overrides: TranscriptOverrides,
): UnknownItem {
  return {
    kind: "unknown",
    key,
    expanded: resolveExpanded(key, false, overrides),
    label: policy.strings.unknownLabel,
    typeName,
    byteSize: jsonByteSize(value),
    raw: policy.unknown.raw ? jsonClone(value) : null,
  };
}

/**
 * guuey#2388: what a reloaded call hands the R13 view builder so its card is
 * drawn at the call's own position, as the call drew it live.
 */
interface CardCall {
  /** The call's `title ?? name`, humanized: names the card as it names the row. */
  toolTitle: string;
  /** R4's `via <tool>` fold, as the live arm gives it. */
  attribution: string | null;
  /** The call's input, sent to the view as tool-input. */
  input: JsonValue;
}

/** The card at `cardSeq` drawn for a reloaded call, or null when R13's rules draw it nowhere. */
type CardAtCall = (cardSeq: number, call: CardCall) => ViewMountItem | null;

/** Walk one assistant slot's blocks into display items (matrix R1–R9, R14, R15). */
function planAssistantSource(
  source: AssistantSource,
  slot: number,
  inputs: TranscriptInputs,
  policy: TranscriptPolicy,
  overrides: TranscriptOverrides,
  /** Filled with the read-plane seq of each text item drawn from a seq-bearing flat row (guuey#2400). */
  seqByKey: Map<ItemKey, number>,
  cardAtCall: CardAtCall,
): DisplayItem[] {
  const items: DisplayItem[] = [];
  const prefix = `a${slot}`;
  const ordinals = { t: 0, r: 0, m: 0, c: 0, d: 0, s: 0, k: 0, u: 0 };
  const resultsById = new Map<string, ToolResultBlock>();
  for (const block of source.blocks) {
    if (block.type === "tool-result") resultsById.set(block.toolCallId, block);
  }
  const consumedResults = new Set<string>();

  let citationRun: CitationsItem["sources"] = [];
  const flushCitations = (): void => {
    if (citationRun.length === 0) return;
    const key = `${prefix}.s${ordinals.s++}`;
    items.push({
      kind: "citations",
      key,
      expanded: resolveExpanded(key, false, overrides),
      label: policy.strings.citations(citationRun.length),
      sources: citationRun,
      style: policy.citations.style,
    });
    citationRun = [];
  };

  const streamingText = source.live && inputs.status === "responding";
  const streamingReasoning = source.live && inputs.status === "thinking";
  let lastTextKey: ItemKey | null = null;
  let lastReasoningKey: ItemKey | null = null;

  for (const [blockIndex, block] of source.blocks.entries()) {
    if (block.type !== "search-result" && block.type !== "resource" && block.type !== "resource-link") {
      flushCitations();
    }
    switch (block.type) {
      case "text": {
        if (block.text === "") break; // R1 empty-turn: no empty bubble.
        const key = `${prefix}.t${ordinals.t++}`;
        lastTextKey = key;
        const seq = source.blockSeqs?.[blockIndex];
        if (seq !== undefined) seqByKey.set(key, seq);
        items.push({
          kind: "text",
          key,
          expanded: resolveExpanded(key, true, overrides),
          text: block.text,
          markdown: policy.text.markdown,
          streaming: false, // the LAST text item of a live slot flips below
          stopped: false, // the abort marker lands on the last text item below
          // AgJSON's open-string `phase`: only the one value this kit knows restyles.
          ...(block.phase === "interim" ? { tone: "interim" as const } : {}),
        });
        break;
      }
      case "reasoning": {
        if (!policy.reasoning.show) break;
        const text = block.text ?? "";
        // Redacted/absent reasoning: no text and no opaque content → row omitted.
        if (text === "" && block.opaque === undefined) break;
        const key = `${prefix}.r${ordinals.r++}`;
        lastReasoningKey = key;
        items.push({
          kind: "reasoning",
          key,
          expanded: resolveExpanded(key, policy.reasoning.expandedByDefault, overrides),
          label: policy.strings.reasoningLabel,
          text,
          streaming: false, // the last reasoning item of a live slot flips below
        });
        break;
      }
      case "tool-call": {
        const key = `tool.${block.toolCallId}`;
        // guuey#2388: a reloaded call whose result a card stands for. The
        // card is the result: its stored part decides the state, and the card
        // is drawn right after the row, where the live mount was.
        const reloaded = source.historyCalls?.get(block.toolCallId);
        const card = reloaded?.card;
        const result = card === undefined ? resultsById.get(block.toolCallId) : undefined;
        if (result) consumedResults.add(block.toolCallId);
        const mount: ViewMount | undefined = result ? toolResultViewMount(result) : undefined;
        // guuey#836 — a pre-generation refusal is named, not shown as an
        // opaque tool error: no mount (nothing was rendered), no data-result
        // dump (the envelope IS the message), the row faces the refusal.
        const refusal = result ? (toolResultRenderRefusal(result) ?? null) : null;
        const failed =
          result !== undefined
            ? refusal !== null || toolFailed(result)
            : card?.result !== undefined && toolFailed(card.result);
        const state: ToolItem["state"] =
          result || card
            ? failed
              ? "failed"
              : "done"
            : source.live && inputs.aborted !== true
              ? "running"
              : "orphaned";
        const title = policy.tool.humanizeTitle(block.title ?? block.name);
        const isGguiProtocol = isGguiProtocolTool(block.name);
        const cardView =
          card === undefined
            ? null
            : cardAtCall(card.seq, {
                toolTitle: title,
                attribution: policy.debugDetail || isGguiProtocol ? null : policy.strings.viaTool(title),
                input: block.input,
              });
        const tool: ToolItem = {
          kind: "tool",
          key,
          expanded: resolveExpanded(key, policy.tool.expandByDefault, overrides),
          toolCallId: block.toolCallId,
          name: block.name,
          title,
          state,
          // guuey#2388: an input the store elided has no arguments to show
          // (the marker is not them, and no other field stands in for them).
          argsPreview:
            policy.tool.argsVisible && !isElidedValue(block.input)
              ? boundedPreview(block.input, policy.dataResult.previewChars)
              : null,
          result:
            result && mount === undefined && refusal === null
              ? dataResultFromToolResult(result, `${key}.result`, policy, overrides)
              : null,
          refusal,
          // R4's display-bearing rule: in calm the call line folds into the
          // view row's chrome as attribution; debug keeps the explicit line.
          attribution: (mount !== undefined || cardView !== null) && !policy.debugDetail,
          // guuey#2388: a reloaded call the read gave no result: not "didn't finish".
          ...(reloaded !== undefined && state === "orphaned" ? { reloadedWithoutResult: true as const } : {}),
        };
        // guuey#1279: ggui protocol/lifecycle rows (handshake/render/consume)
        // are machinery, not chrome — filtered from the transcript by
        // construction under `showToolRows: "non-ggui"` (default). The wire is
        // unchanged (the pod still emits the events); only the ROW is dropped —
        // the render card MOUNT below still shows.
        // A FAILED ggui row is a NAMED error the user needs (guuey#836's
        // refusal), NOT chatter — keep it even under the ggui filter; only the
        // done/running SUCCESS narration is machinery to drop.
        const isFailedRow = state === "failed";
        const showToolRow =
          policy.tool.showToolRows === "all" ||
          (policy.tool.showToolRows === "non-ggui" && (!isGguiProtocol || isFailedRow));
        if (showToolRow) items.push(tool);
        // guuey#2369: the result's image/audio render in flow after the row —
        // even when the filter dropped the row, like the view mount below.
        if (result && mount === undefined && refusal === null) {
          items.push(...toolResultMediaItems(result, policy, overrides));
        }
        if (mount !== undefined) {
          const viewKey = `view.${block.toolCallId}`;
          const view: ViewMountItem = {
            kind: "view",
            key: viewKey,
            expanded: resolveExpanded(viewKey, true, overrides),
            mount,
            channel: mount.channel,
            phase: inputs.viewPhases?.[viewKey] ?? "negotiating",
            label: null,
            diagnosis: inputs.viewDiagnoses?.[viewKey] ?? null,
            // R4 display-bearing: in calm the call line folds into the view's
            // chrome as attribution. guuey#1288 (ggui#1077 ruled R4 is guuey's
            // own rule, not ggui's contract): a ggui protocol mount shows the
            // CARD only — no "via ggui render" strip (protocol chatter). Non-ggui
            // tools keep their `via <tool>` fold.
            attribution: policy.debugDetail || isGguiProtocol ? null : policy.strings.viaTool(tool.title),
            toolTitle: tool.title,
            // `result` is narrowed by `mount !== undefined` above; the scope
            // is the PERSISTED locator (`uiData.resourceUri`), never the
            // mount payload's own uri (synthetic for a ggui shell).
            actionScope: result ? (toolResultLocator(result) ?? null) : null,
            // What the view is sent after its `initialized` (spec tool-input +
            // tool-result): this call's arguments and its result.
            ...(result ? { toolData: viewToolData(block, result) } : {}),
          };
          view.label = viewLabel(view, policy);
          items.push(view);
        }
        if (cardView !== null) items.push(cardView);
        break;
      }
      case "tool-result": {
        // Paired results were consumed by their call; an unpaired result is
        // still rendered honestly as a standalone data row (R5's non-paired
        // arm), never dropped.
        if (consumedResults.has(block.toolCallId)) break;
        if (resultsById.get(block.toolCallId) !== block) break; // duplicate id: first one owns
        const hasCall = source.blocks.some(
          (b) => b.type === "tool-call" && b.toolCallId === block.toolCallId,
        );
        if (hasCall) break; // its call renders it
        const data = dataResultFromToolResult(block, `${prefix}.d${ordinals.d}`, policy, overrides);
        if (data !== null) {
          ordinals.d++;
          items.push(data);
        }
        items.push(...toolResultMediaItems(block, policy, overrides));
        break;
      }
      case "image":
      case "audio":
      case "file":
      case "document": {
        items.push(mediaItem(`${prefix}.m${ordinals.m++}`, block, null, policy, overrides));
        break;
      }
      case "code": {
        const key = `${prefix}.c${ordinals.c++}`;
        items.push({
          kind: "code",
          key,
          expanded: resolveExpanded(key, true, overrides),
          language: block.language,
          code: block.code,
          wrap: policy.code.wrap,
        });
        break;
      }
      case "code-result":
      case "data": {
        // R5's standalone arms (no R3 pair to live inside).
        const key = `${prefix}.d${ordinals.d++}`;
        const payload = block.type === "data" ? block.data : block.output;
        const byteCount = block.type === "data" ? jsonByteSize(payload) : block.output.length;
        const preview =
          block.type === "data"
            ? boundedPreview(payload, policy.dataResult.previewChars)
            : block.output.length > policy.dataResult.previewChars
              ? block.output.slice(0, policy.dataResult.previewChars)
              : block.output;
        items.push({
          kind: "data-result",
          key,
          expanded: resolveExpanded(key, true, overrides),
          preview: byteCount === 0 ? null : preview,
          byteCount,
          state: byteCount === 0 ? "empty" : byteCount > GIANT_RESULT_BYTES ? "giant" : "small",
          showBytes: policy.dataResult.alwaysShowBytes || byteCount > GIANT_RESULT_BYTES,
        });
        break;
      }
      case "search-result": {
        citationRun.push({ title: block.title ?? null, url: block.url ?? null });
        break;
      }
      case "resource": {
        citationRun.push({ title: null, url: block.resource.uri ?? null });
        break;
      }
      case "resource-link": {
        citationRun.push({ title: null, url: block.uri });
        break;
      }
      case "compaction": {
        if (!policy.compaction.show) break;
        const key = `${prefix}.k${ordinals.k++}`;
        items.push({
          kind: "compaction",
          key,
          expanded: resolveExpanded(key, true, overrides),
          label: policy.strings.compaction,
        });
        break;
      }
      case "provider-raw": {
        if (!policy.unknown.show) break;
        // guuey#847 — a lossless carry that carries NOTHING (the google-adk
        // facet carries an ADK event's empty `artifactDelta` dict as a
        // provider-raw block, `{ artifactDelta: {} }`) is not "unrecognized
        // content": there is no content. Calm shows no row for
        // it; debug keeps every carry visible. A carry WITH a payload — an
        // unmapped genai part field, a non-text MCP content part, any vendor's
        // real bytes — still renders as the labeled unknown row (R15).
        if (!policy.debugDetail && isInformationless(block.raw)) break;
        items.push(
          unknownFromValue(`${prefix}.u${ordinals.u++}`, `provider-raw:${block.vendor}`, block.raw, policy, overrides),
        );
        break;
      }
      default: {
        // R15's trust invariant: a block type this version does not know (a
        // future AgJSON addition reaching us through a lenient fold) renders
        // as a LABELED row — never blank, never raw JSON in calm.
        if (!policy.unknown.show) break;
        const shape: { type: string } = block;
        items.push(
          unknownFromValue(`${prefix}.u${ordinals.u++}`, shape.type, shape, policy, overrides),
        );
        break;
      }
    }
  }
  flushCitations();

  // Streaming + abort markers land on the slot's LAST text/reasoning item.
  if (lastTextKey !== null) {
    for (const item of items) {
      if (item.key === lastTextKey && item.kind === "text") {
        item.streaming = streamingText;
        item.stopped = source.stopped;
      }
    }
  }
  if (lastReasoningKey !== null && streamingReasoning) {
    for (const item of items) {
      if (item.key === lastReasoningKey && item.kind === "reasoning") item.streaming = true;
    }
  }
  return items;
}

/**
 * R4's grouping pass — a VIEW-MODEL derivation, never wire: runs of
 * adjacent SETTLED SILENT tool rows (done/failed, no display-bearing
 * result) of at least the threshold collapse to one group row. A
 * display-bearing result (its ViewMountItem sits between the tool rows)
 * breaks adjacency at its sequence position by construction; the active
 * tool is never absorbed (its state is `running`, not settled).
 */
function groupTools(
  items: DisplayItem[],
  policy: TranscriptPolicy,
  overrides: TranscriptOverrides,
): DisplayItem[] {
  const threshold = policy.toolGroup.threshold;
  if (threshold === false) return items;
  const out: DisplayItem[] = [];
  let run: ToolItem[] = [];

  const flush = (): void => {
    if (run.length >= threshold) {
      const key = `g.${run[0].key}`;
      const failureCount = run.filter((t) => t.state === "failed").length;
      const group: ToolGroupItem = {
        kind: "tool-group",
        key,
        expanded: resolveExpanded(key, false, overrides),
        label: policy.strings.toolGroup(run.length),
        tools: run,
        failureCount,
        failureBadge: failureCount > 0 ? policy.strings.toolGroupFailures(failureCount) : null,
      };
      out.push(group);
    } else {
      out.push(...run);
    }
    run = [];
  };

  items.forEach((item, i) => {
    // Silent = the row's entire output lives inside its own expansion (R5
    // data, however large). Display-bearing calls carry `attribution` and
    // their ViewMountItem already sits between tool rows, breaking the run;
    // a call whose media rows follow it (guuey#2369) is display-bearing too.
    const next = items[i + 1];
    const mediaBearing =
      item.kind === "tool" && next !== undefined && next.kind === "media" && next.toolCallId === item.toolCallId;
    if (
      item.kind === "tool" &&
      (item.state === "done" || item.state === "failed") &&
      !item.attribution &&
      !mediaBearing
    ) {
      run.push(item);
    } else {
      flush();
      out.push(item);
    }
  });
  flush();
  return out;
}

/** The fields {@link planStatusLine} reads: a host header passes exactly these. */
export type StatusInputs = Pick<
  TranscriptInputs,
  "status" | "statusElapsedMs" | "activeTool" | "aborted" | "connectWait"
>;

/**
 * §4's status derivation — thresholds and copy from policy, elapsed as input.
 * The ONE status line (guuey#2453): `planTranscript` draws it, and a host
 * header that reads the same line calls it with the same fields.
 */
export function planStatusLine(inputs: StatusInputs, policy: TranscriptPolicy): StatusLineItem | null {
  const s = policy.strings;
  const detail = policy.debugDetail ? `${inputs.status} · ${inputs.statusElapsedMs} ms` : null;
  if (inputs.aborted === true) {
    return { kind: "status", key: "status", state: "aborted", copy: s.stopped, detail };
  }
  switch (inputs.status) {
    case "ready":
    case "responding":
      return null; // streaming text is its own indicator; idle copy is 3c's composer.
    case "connecting": {
      // guuey#2604: the transport is waiting to send again because the agent
      // is at its concurrent-turn ceiling. Say so, rather than letting the
      // connecting ladder climb to "Still getting ready…" over the wait.
      const wait = inputs.connectWait;
      if (wait?.kind === "busy") {
        const copy = s.saturationRetrying(wait.attempt, wait.totalAttempts, wait.secondsLeft);
        // guuey#2608: the countdown changes the visible words every second; the
        // live region announces the attempt only (the line without it).
        const announce = s.saturationRetrying(wait.attempt, wait.totalAttempts);
        return {
          kind: "status",
          key: "status",
          state: "busy",
          copy,
          ...(announce !== copy ? { announce } : {}),
          detail,
        };
      }
      // guuey#2453: a sleeping app is waking. The signal names it at once (no
      // guess from the elapsed time), and the line swaps once to its long
      // words at the policy's one long threshold.
      if (wait?.kind === "waking") {
        const copy = inputs.statusElapsedMs < policy.status.longStartMs ? s.waking : s.wakingLong;
        return { kind: "status", key: "status", state: "waking", copy, detail };
      }
      const state =
        inputs.statusElapsedMs >= policy.status.longStartMs
          ? "long-start"
          : inputs.statusElapsedMs >= policy.status.wakingMs
            ? "starting"
            : "connecting";
      const copy =
        state === "long-start" ? s.longStart : state === "starting" ? s.starting : s.connecting;
      return { kind: "status", key: "status", state, copy, detail };
    }
    case "thinking":
      return { kind: "status", key: "status", state: "thinking", copy: s.thinking, detail };
    case "using-tool": {
      // guuey#1658 — a `ggui_consume` LISTEN is not work in progress (guuey#1038):
      // the card is live, the composer is open, and the agent is waiting on the
      // reader's click or reply. There is no status line for it. The rail's
      // "Preparing interactive card…" stood for the whole wait, up to 25 s after
      // the card painted (QA's pin-11 re-time: 14 of 14 card turns).
      if (isGguiConsumeTool(inputs.activeTool ?? null)) return null;
      // guuey#1279 — BY CONSTRUCTION, not by filter: a ggui protocol tool
      // never reaches `policy.tool.humanizeTitle` here at all. That hook is
      // HOST-OVERRIDABLE, so a host humanizer returning the wire name would
      // otherwise put "ggui render" in the status line — the one piece of
      // chrome `showToolRows` never covered (it filters tool ROWS; the status
      // line is always visible). Routing the protocol case around the hook is
      // what makes the rule structural: there is no humanizer, host-supplied
      // or not, that can name a lifecycle step here.
      if (isGguiProtocolTool(inputs.activeTool ?? null)) {
        return { kind: "status", key: "status", state: "using-tool", copy: s.preparingCard, detail };
      }
      const title = policy.tool.humanizeTitle(inputs.activeTool ?? "");
      return { kind: "status", key: "status", state: "using-tool", copy: s.usingTool(title), detail };
    }
  }
}

/**
 * Built-in per-code voices (guuey#417) — consulted AFTER the policy's own
 * `copyByCode` (host override always wins) and before family copy. These
 * are codes whose family styling fits but whose family COPY lies:
 * THREAD_HISTORY_UNAVAILABLE is not "something went wrong — try again"
 * (nothing is wrong and there is nothing to retry — a fresh session is
 * already composed); the honest notice is the guard's own.
 */
const CODE_COPY: Record<string, (s: import("./strings.js").ChatStrings) => string> = {
  THREAD_HISTORY_UNAVAILABLE: (s) => s.errorHistoryUnavailable,
  CONTENT_BLOCKED: (s) => s.errorContentBlocked,
  // The model stopped before it wrote a reply: its own honest line, but the
  // transient family's Retry stays (no ERROR_FAMILIES entry), since the stop
  // is often intermittent.
  NO_REPLY: (s) => s.errorNoReply,
  // guuey#2293: the turn's images — the runtime did not take them, or the
  // send's list broke the rules. Both are "change the request" (no Retry).
  ATTACHMENTS_UNSUPPORTED: (s) => s.errorAttachmentsUnsupported,
  ATTACHMENTS_INVALID: (s) => s.errorAttachmentsInvalid,
  // guuey#2549: a turn without words the agent does not take (its worker
  // turned it down, or its runtime refused it before it started). Both are
  // "add a few words" (no Retry: the same turn meets the same refusal).
  INPUT_KIND_NOT_DECLARED: (s) => s.errorInputKindNotDeclared,
  INPUT_KIND_NOT_ADVERTISED: (s) => s.errorInputKindNotAdvertised,
  // A temporary capacity limit stopped the turn: its own line, and the
  // transient family's Retry stays (no ERROR_FAMILIES entry), since trying
  // again shortly is exactly what the reader should do.
  WORKER_POD_RESOURCE_EXHAUSTED: (s) => s.errorResourceExhausted,
  // guuey#2604: every concurrent-turn slot was still taken after the retries.
  // A plain "try again" line in place of the pod's envelope (which names the
  // turn cap); the transient family's Retry stays.
  POD_SATURATED: (s) => s.errorPodSaturated,
  // The pod is restarting: a plain "try again" line in place of the pod's
  // envelope, which names a pod and its re-routing; the transient Retry stays.
  DRAINING: (s) => s.errorDraining,
  // guuey#2453: the app did not wake within the wake budget (a client code).
  // The transient family's Retry stays (no ERROR_FAMILIES entry): sending
  // again usually finds it awake.
  WAKE_TIMED_OUT: (s) => s.errorWakeTimedOut,
};

/**
 * Codes whose error item wears the RETRY tone (guuey#2453): nothing is broken,
 * so the face is the plain surface with the in-place Retry as its only cue.
 * Every other code is a fault.
 */
const RETRY_TONE_CODES: ReadonlySet<string> = new Set(["WAKE_TIMED_OUT"]);

/**
 * The one tone rule, read by both faces of a failure: the error item's `tone`
 * and a refused bubble's `failureTone`. `undefined` is a fault: both fields are
 * set only for the retry tone.
 */
function toneOf(code: string | null): "retry" | undefined {
  return code !== null && RETRY_TONE_CODES.has(code) ? "retry" : undefined;
}

/**
 * R11's voice resolution, shared by the live error item and a reloaded failed
 * turn's notice so one failure reads the same both ways: the host's exact
 * per-code sentence wins; then a verbatim match renders the SOURCE message
 ("all" covers code-less client errors too — the widget's #162 posture; a
 * client code's source is the SDK's own sentence, so "all" shows it, as
 * WAKE_TIMED_OUT's `WAKE_TIMED_OUT_MESSAGE`); then the built-in per-code
 * voice; then the family's copy. An empty source message falls back rather
 * than rendering a blank notice.
 */
function codedErrorCopy(
  code: string | null,
  message: string,
  policy: TranscriptPolicy,
): {
  family: "auth" | "quota" | "transient" | "invalid";
  copy: string;
  /** The copy is this code's own sentence (host, verbatim or built-in), not the family's fallback. */
  specific: boolean;
  /** The failure's face ({@link toneOf}): the error item's `tone`, a refused bubble's `failureTone`; `undefined` is a fault. */
  tone: "retry" | undefined;
} {
  const family = (code !== null ? ERROR_FAMILIES[code] : undefined) ?? "transient";
  const familyCopy =
    family === "auth"
      ? policy.strings.errorAuth
      : family === "quota"
        ? policy.strings.errorQuota
        : family === "invalid"
          ? policy.strings.errorInvalid
          : policy.strings.errorTransient;
  const { copyByCode, verbatimCodes } = policy.error;
  const perCode = code !== null ? copyByCode[code] : undefined;
  const verbatimVoice = verbatimCodes === "all" || (code !== null && verbatimCodes.includes(code));
  const builtIn = code !== null ? CODE_COPY[code] : undefined;
  const specificCopy =
    perCode ?? (verbatimVoice && message !== "" ? message : undefined) ?? builtIn?.(policy.strings);
  return { family, copy: specificCopy ?? familyCopy, specific: specificCopy !== undefined, tone: toneOf(code) };
}

const ERROR_FAMILIES: Record<string, "auth" | "quota" | "invalid"> = {
  UNAUTHORIZED: "auth",
  AUTH_REQUIRED: "auth",
  GUEST_ACCESS_DISABLED: "auth",
  FORBIDDEN: "auth",
  QUOTA_EXCEEDED: "quota",
  MANAGED_SPEND_CAP: "quota",
  INVALID_REQUEST: "invalid",
  // A reply the model's safety filter withheld: not a fault a retry can fix
  // (the same message meets the same refusal), so never the transient family,
  // whose renderers offer a Retry. "invalid" is the family whose reading is
  // "change the request", which is what the reader line asks for.
  CONTENT_BLOCKED: "invalid",
  // guuey#2293: sending the same images again meets the same refusal.
  ATTACHMENTS_UNSUPPORTED: "invalid",
  ATTACHMENTS_INVALID: "invalid",
  // guuey#2549: the same turn without words meets the same refusal.
  INPUT_KIND_NOT_DECLARED: "invalid",
  INPUT_KIND_NOT_ADVERTISED: "invalid",
};

/** A persisted card with its mount and its surface identity (null when it has no mount). */
interface HistoryCardEntry {
  card: HistoryCard;
  mount: ViewMount | undefined;
  scope: string | null;
}

/**
 * The ONE R13 view builder: a persisted card as a view item. A card a
 * reloaded call stands beside (guuey#2388) is named and attributed by that
 * call, as the live mount was, and is sent the call's input; a card with no
 * call on the read keeps its own tool name and no attribution.
 */
function historyCardView(
  { card, mount, scope }: HistoryCardEntry,
  inputs: TranscriptInputs,
  policy: TranscriptPolicy,
  overrides: TranscriptOverrides,
  call?: CardCall,
): ViewMountItem {
  const key = `card.${card.seq}`;
  const view: ViewMountItem = {
    kind: "view",
    key,
    expanded: resolveExpanded(key, true, overrides),
    mount: mount ?? null,
    channel: mount?.channel ?? null,
    phase: mount === undefined ? "expired" : (inputs.viewPhases?.[key] ?? "negotiating"),
    label: null,
    diagnosis: mount === undefined ? null : (inputs.viewDiagnoses?.[key] ?? null),
    attribution: call !== undefined ? call.attribution : null,
    // guuey#402: the chip titles with the producing tool's humanized
    // name once the read plane persists it (the platform half); absent
    // keeps the generic fallback — pre-enabler rows are indistinguishable
    // by construction, never by invention. A call on the read outranks it.
    toolTitle:
      call !== undefined
        ? call.toolTitle
        : card.toolName !== undefined
          ? policy.tool.humanizeTitle(card.toolName)
          : null,
    actionScope: scope,
  };
  // The stored result; the projection stores no call, so the tool-input is
  // the paired call's (none when the store elided it).
  const stored = mount === undefined ? undefined : snapshotViewToolData(card.cardSnapshot);
  if (stored !== undefined) {
    const input = call !== undefined ? toolCallViewInput(call.input) : stored.input;
    view.toolData = {
      ...(input !== undefined ? { input } : {}),
      ...(stored.result !== undefined ? { result: stored.result } : {}),
    };
  }
  view.label = viewLabel(view, policy);
  return view;
}

/** The one pure function (spec §7). */
export function planTranscript(
  inputs: TranscriptInputs,
  policy: TranscriptPolicy,
  overrides: TranscriptOverrides = {},
): TranscriptPlan {
  const items: DisplayItem[] = [];

  // R13 boundary states precede everything.
  if (inputs.historyState === "loading") {
    items.push({
      kind: "history-boundary",
      key: "history",
      expanded: true,
      state: "loading",
      label: policy.strings.historyLoading,
    });
  } else if (inputs.historyState === "gone") {
    items.push({
      kind: "history-boundary",
      key: "history",
      expanded: true,
      state: "gone",
      label: policy.strings.threadGone,
    });
  } else if (inputs.historyTruncated === true) {
    // guuey#2858: the history read stopped at its page cap and left the
    // OLDEST messages out; say so once, above the earliest message drawn.
    items.push({
      kind: "history-boundary",
      key: "history",
      expanded: true,
      state: "truncated",
      label: policy.strings.historyTruncated,
    });
  }

  const inFlight = inputs.status !== "ready";
  const users = inputs.messages.filter((m) => m.role === "user");
  // guuey#2604: the turn's error, when its latest send was refused before
  // admission. Read here so the user row and R11 decide from one fact. The
  // debug formatting knob keeps the separate notice: its code-prefixed raw
  // line is the builder's diagnostic, and a bubble line cannot carry it.
  const lastUser = users[users.length - 1];
  const refusedSend =
    inputs.error &&
    !policy.error.verbatim &&
    lastUser?.clientMessageId !== undefined &&
    inputs.sendStates?.[lastUser.clientMessageId] === "failed"
      ? codedErrorCopy(inputs.error.code, inputs.error.message, policy)
      : null;
  // R16 — notice rows are session annotations anchored between turns: a
  // flat notice renders after the conversation slot of the user turn it
  // followed (usersSeen-1; -1 = before the conversation). They are PEER
  // rows — excluded from both the user pairing and the assistant seam
  // count, so the fold alignment below never sees them. guuey#2445: from the
  // stamp anchor on, a row's slots are no longer its index, so a flat notice
  // there moves to the last slot of the user row it followed (`afterUser`).
  const notices: Array<{
    key: string;
    text: string;
    source: NoticeItem["source"];
    failure?: { code: string | null };
    afterSlot: number;
    /** A flat notice's user row (index in `users`; -1 = before the conversation). */
    afterUser?: number;
  }> = [];
  {
    let usersSeen = 0;
    // guuey#2355: the closing turn's reloaded row is voiced by the plan's
    // `threadClosed` instead, never twice.
    const closedCode = inputs.threadClosed?.code;
    inputs.messages.forEach((m, i) => {
      if (m.role === "user") usersSeen += 1;
      else if (m.role === "notice" && closedCode !== undefined && m.failure?.code === closedCode) return;
      // A failed turn's notice is shown whatever the notice policy, as the
      // live error it stands for always is (R11).
      else if (m.role === "notice" && (policy.notice.show || m.failure !== undefined)) {
        notices.push({
          key: `n${i}`,
          text: m.text,
          source: m.noticeSource ?? null,
          ...(m.failure !== undefined ? { failure: m.failure } : {}),
          afterSlot: usersSeen - 1,
          afterUser: usersSeen - 1,
        });
      }
    });
  }
  // Turn-scoped fold composition (guuey#135 kit refinement): the fold owns
  // the TRAILING turns of the conversation — the ones this session saw
  // live — and any EARLIER flat entries (a rehydrated/persisted prefix the
  // session's Reducer never saw) keep rendering as flat text slots in
  // front. When the fold spans the whole conversation (a pure-live session
  // — the corpus's world), the kept prefix is empty and the plan is
  // byte-identical to the old wholesale replace. Fold sources group per
  // turn (user boundary + turnId change), flat entries group by
  // conversational order (guuey#306).
  //
  // The seam is anchored on USER turns (guuey#982). The fold is always a
  // suffix of the conversation, so the flat prefix is exactly the flat
  // groups in front of that suffix.
  //
  // When the assembler stamps its live rows (`precedingTurnCount`), the
  // suffix begins at the FIRST stamped user row: every stamped row was sent
  // live, and the fold holds what those sends produced. The prefix is the
  // flat groups before that row, less any fold source of a turn that came
  // before it. A stamp counts fold TURNS, and a turn can have no source (a
  // send stopped, failed or cut before its first assistant frame, or a
  // paused hitl turn), so each stamp is mapped to the number of fold sources
  // whose turn came before it. From the anchor on, the rows place every user
  // row in their own order, each owning at least one slot (`liveSuffix`): a
  // stamped row owns the fold's sources between its stamp and the next
  // stamped row's; a row that owns none draws its own flat group if that has
  // text (a send the fold never saw, or a reply the fold never saw, which a
  // history read brought in), else an empty slot. A flat notice there sits
  // after the last slot of the row it followed. A history read that replaces
  // the rows (the hook adopting a cut turn) keeps each live row's stamp
  // (guuey#2445), matched by the row's `clientMessageId` or, for a read that
  // serves no keys, by position; when it cannot tie every live send, the hook
  // drops the fold instead, and the rows plan flat.
  // guuey#2445: the earlier count-based rule assumed one source per live
  // send, so such a send, once it was no longer the latest, kept the fold's
  // previous answer again as a flat prefix, drawn above its own question,
  // and every later question was placed one slot too far.
  //
  // Without stamps (an older assembler, or another assembler that sets
  // history's rows beside a fold) or without turn identity the seam keeps
  // the count-based rule:
  // `users - foldCovers`, where an in-flight turn counts as covered even
  // before its first frame. The rule before it — flat groups minus SETTLED
  // fold sources — assumed the flat side never holds the live turn's rows;
  // when a history read lands after the pod persisted a turn but before the
  // client saw its `turn.done`, that rule kept the flat copy of the previous
  // turn AND appended the fold's copy: three assistant slots against two
  // users, turn 1's answer rendered after the turn-2 bubble (the reported
  // Playground DOM; replayed from real dev shapes in plan.issue982.test.ts,
  // phase P6).
  let assistants: AssistantSource[];
  /**
   * Index in `assistants` where the FOLD's sources begin. Everything before
   * it is the settled flat prefix, whose slots (including the deliberate
   * EMPTY ones guuey#1101 keeps for a user turn with no reply) are already
   * positionally correct. guuey#1333's merge applies to the suffix only.
   */
  let foldSeam = 0;
  /**
   * guuey#2445: the slot each user row from the stamp anchor on precedes, and
   * the last slot it owns, when the seam is anchored on stamps. Null on the
   * count-based rule, where a stamp maps to `foldSeam + sourcesBefore(stamp)`.
   */
  let liveUserSlots: ReadonlyMap<number, number> | null = null;
  let liveUserEnds: ReadonlyMap<number, number> | null = null;
  /** Each fold source's turn index, when stamps are mapped into source space. */
  let stampedSourceTurns: readonly number[] | null = null;
  /** A live row's stamp (fold turns before it) as fold SOURCES before it. */
  const sourcesBefore = (turnCount: number): number =>
    stampedSourceTurns === null ? turnCount : stampedSourceTurns.filter((t) => t < turnCount).length;
  const flat = flatSettledGroups(inputs.messages, inputs.historyTools);
  if (inputs.result) {
    const fold = foldAssistantSources(inputs.result, inFlight, inputs.aborted === true);
    const foldSources = fold.sources;
    const firstLive = users.findIndex((u) => u.precedingTurnCount !== undefined);
    const anchor = users[firstLive]?.precedingTurnCount;
    /** The global slot of each fold source, index-aligned with `foldSources`. */
    let foldSlots: readonly number[];
    if (anchor !== undefined && fold.sourceTurns !== null) {
      stampedSourceTurns = fold.sourceTurns;
      const keep = clampSeam((flat.userOrder[firstLive] ?? 0) - sourcesBefore(anchor), flat.groups.length);
      const suffix = liveSuffix(users, firstLive, flat, foldSources, sourcesBefore, keep);
      foldSeam = keep;
      liveUserSlots = suffix.userSlots;
      liveUserEnds = suffix.userEnds;
      foldSlots = suffix.foldSlots;
      assistants = [...flat.groups.slice(0, keep), ...suffix.sources];
    } else {
      // `users` includes the optimistic row of an in-flight turn, so the
      // subtraction lands on the same prefix before and after its first frame.
      const keep = clampSeam(users.length - (foldSources.length + (fold.pendingTurn ? 1 : 0)), flat.groups.length);
      foldSeam = keep;
      foldSlots = foldSources.map((_, i) => keep + i);
      assistants = [...flat.groups.slice(0, keep), ...foldSources];
    }
    if (policy.notice.show) {
      // Fold-borne notices anchor to the slot of the fold source they followed
      // (-1 = before any: the slot in front of the seam).
      fold.notices.forEach((n, i) => {
        const afterSlot = foldSlots[n.afterSourceIndex] ?? foldSeam + n.afterSourceIndex;
        notices.push({ key: `nf${i}`, text: n.text, source: n.source, afterSlot });
      });
    }
  } else {
    assistants = flatAssistantSources(inputs, inFlight);
  }
  if (liveUserEnds !== null) {
    for (const n of notices) {
      const end = n.afterUser !== undefined ? liveUserEnds.get(n.afterUser) : undefined;
      if (end !== undefined) n.afterSlot = end;
    }
  }

  const slots = Math.max(users.length, assistants.length);
  /**
   * guuey#1333 — the live interleave key. In a fully live session `users`
   * and `assistants` are DISJOINT lists (the wire sends no user row into
   * the fold), so index pairing was the only bridge and mis-paired the
   * whole transcript whenever the counts diverged — a welcome card (turn
   * with no user) or a chip click (user action with no user row).
   *
   * When the assembler stamps `precedingTurnCount`, a user row is placed
   * before the agent turn it actually preceded instead of before whichever
   * turn shares its index. When NO row carries it (an older assembler
   * across the npm boundary), `order` is null and the loop below keeps the
   * previous index pairing byte-for-byte.
   */
  const flatUserOrder = flat.userOrder;
  const stamped = users.some((u) => u.precedingTurnCount !== undefined);
  const order: readonly number[] | null =
    stamped || flatUserOrder.length === users.length
      ? users.map((u, i) =>
          // A LIVE row's stamp counts FOLD turns; mapped to the fold sources
          // before it, it is offset by the seam, since those sources sit after
          // the settled prefix in `assistants`. A rehydrated row has no stamp
          // and its position is already a count of flat groups, which ARE the
          // prefix. Both land in one comparable space.
          // From the stamp anchor on, every row's slot is read from the suffix.
          // With NO fold (none yet, or an adoption dropped it) a stamp counts
          // the turns of a fold that does not exist, so it says nothing about
          // where the row sits: every row takes its flat position, after the
          // flat groups above it (a reloaded answer stays under its question).
          (liveUserSlots?.get(i) ??
            (u.precedingTurnCount !== undefined && inputs.result
              ? foldSeam + sourcesBefore(u.precedingTurnCount)
              : (flatUserOrder[i] ?? i))),
        )
      : null;
  // R13's persisted cards, seq order, each with its mount and its surface
  // identity (guuey#535: the LATEST reference to a surface anchors it). Read
  // here, before the conversation, because a reloaded call draws its card at
  // its own position (guuey#2388); the R13 pass below places the rest.
  const cards = [...(inputs.historyCards ?? [])].sort((a, b) => a.seq - b.seq);
  const scopes = cards.map((card): HistoryCardEntry => {
    const mount = snapshotViewMount(card.cardSnapshot);
    return {
      card,
      mount,
      scope:
        mount === undefined
          ? null
          : mount.channel === "locator"
            ? mount.resourceUri
            : mount.resource.uri,
    };
  });
  const latestSeqByScope = new Map<string, number>();
  for (const { card, scope } of scopes) {
    if (scope !== null) latestSeqByScope.set(scope, card.seq);
  }
  const cardEntryBySeq = new Map(scopes.map((entry) => [entry.card.seq, entry]));
  /** Keys of the cards a reloaded call drew at its own position. */
  const cardsAtCalls = new Set<ItemKey>();
  const cardAtCall: CardAtCall = (cardSeq, call) => {
    const entry = cardEntryBySeq.get(cardSeq);
    if (entry === undefined || cardsAtCalls.has(`card.${cardSeq}`)) return null;
    // R13's rule decides whether the card is drawn; the call decides only where.
    if (entry.scope !== null && latestSeqByScope.get(entry.scope) !== cardSeq) return null;
    const view = historyCardView(entry, inputs, policy, overrides, call);
    cardsAtCalls.add(view.key);
    return view;
  };
  const conversation: DisplayItem[] = [];
  /** guuey#2400: the read-plane seq of each assistant text item drawn from a rehydrated row. */
  const assistantSeqByKey = new Map<ItemKey, number>();
  // A reloaded failed turn's notice speaks with the live error's voice for its
  // code (and carries no Retry: the failure is past); a plain notice keeps its text.
  const noticeItem = (n: (typeof notices)[number]): NoticeItem => ({
    kind: "notice",
    key: n.key,
    expanded: true,
    text: n.failure !== undefined ? codedErrorCopy(n.failure.code, n.text, policy).copy : n.text,
    source: n.source,
    sourceLabel: policy.debugDetail && n.source !== null ? n.source : null,
    ...(n.failure !== undefined ? { failure: n.failure } : {}),
  });
  for (const n of notices) if (n.afterSlot < 0) conversation.push(noticeItem(n));
  // ONE emission body for both modes, so the interleave decides only WHEN a
  // row is emitted and never HOW. The key stays `u{index-in-users}` and an
  // assistant source keeps its source ordinal — exactly the keys the
  // index-paired loop assigned, so no key churns when a stamped assembler
  // appears (the append-only key contract, spec §7).
  const pushUser = (index: number): void => {
    const user = users[index];
    if (!user) return;
    const key = `u${index}`;
    const sendState =
      user.clientMessageId !== undefined
        ? (inputs.sendStates?.[user.clientMessageId] ?? "sent")
        : "sent";
    // guuey#2604: the LATEST send refused before admission carries the turn's
    // error as its own state line, and R11 draws no second box for it. One
    // turn, one state.
    const refusal = sendState === "failed" && index === users.length - 1 ? refusedSend : null;
    // guuey#422 close-condition 3: a forwarded view directive (the
    // `ui/message` doorbell's `<ggui_directive>` carrier, relayed through
    // the composer's send gate) is not typed speech. guuey#2031: it draws as
    // an ACTION turn — the tapped controls' own words when the row carries
    // them, else the continuation line. DISPLAY-ONLY — `text` stays
    // wire-verbatim; the wire itself was never touched. The test is the ONE
    // directive predicate the runtime shares (`isViewDirectiveText`), so a
    // row draws the same live and after a reload whatever ggui's directive
    // looks like inside.
    const directive = policy.userMessage.collapseDirectives && isViewDirectiveText(user.text);
    // The reader contract (`readTapLabels`): typed text never shows a label.
    const tapLabels = directive ? readTapLabels(user.tapLabels) : undefined;
    // guuey#2549: a turn sent without words draws its own line, never an empty
    // bubble: only a row whose text is empty (typed text, and a relayed
    // directive, never take it). The kind arrives already read: the live send
    // stamps a known one, and the history reader keeps only a known one.
    const inputKind = user.text === "" ? user.inputKind : undefined;
    conversation.push({
      kind: "user",
      key,
      // A directive row's `expanded` is its raw-directive toggle (debug only).
      expanded: resolveExpanded(key, !directive, overrides),
      text: user.text,
      state: sendState,
      retry:
        sendState === "failed" &&
        policy.userMessage.retryAffordance &&
        (refusal === null || refusal.family === "transient"),
      ...(refusal !== null && (refusal.specific || refusal.family !== "transient")
        ? { failureLine: refusal.copy }
        : {}),
      // guuey#2453: the refused bubble wears the error item's tone rule.
      ...(refusal !== null && refusal.tone !== undefined ? { failureTone: refusal.tone } : {}),
      // guuey#2608: the id a Retry names so its re-send takes this row's place.
      ...(sendState === "failed" && user.clientMessageId !== undefined
        ? { clientMessageId: user.clientMessageId }
        : {}),
      directive,
      ...(tapLabels !== undefined ? { tapLabels } : {}),
      ...(inputKind !== undefined ? { inputKind } : {}),
      ...(directive && policy.userMessage.rawDirective ? { rawDirective: true } : {}),
    });
  };

  // The prefix pairs positionally (its users are already beside their own
  // settled turns); the merge takes over at the seam and counts FOLD TURNS,
  // which is what the assembler counted when it stamped the field.
  let nextUser = 0;
  /** Every user row that preceded the source at `slot`, in order. */
  const emitUsersBefore = (slot: number): void => {
    while (nextUser < users.length && (order?.[nextUser] ?? nextUser) <= slot) {
      pushUser(nextUser);
      nextUser++;
    }
  };

  for (let slot = 0; slot < slots; slot++) {
    if (order === null) pushUser(slot);
    else emitUsersBefore(slot);
    const assistant = assistants[slot];
    if (assistant) {
      conversation.push(
        ...planAssistantSource(assistant, slot, inputs, policy, overrides, assistantSeqByKey, cardAtCall),
      );
    }
    for (const n of notices) if (n.afterSlot === slot) conversation.push(noticeItem(n));
  }
  // Users stamped as following the LAST agent turn (or sent while it is
  // still in flight) have no source to precede — they close the transcript.
  if (order !== null) while (nextUser < users.length) pushUser(nextUser++);
  // Dedupe against LIVE mounts by actionScope (the persisted `ui://`
  // identity both sides carry): a session whose fold still holds a turn the
  // read plane has ALSO persisted — the #192 adopted turn, a thread view's
  // post-handoff refetch — would otherwise render the same card twice. The
  // fold's view row owns it (richer phase state); the history snapshot
  // renders only when no live mount claims its identity, whether a reloaded
  // call drew it or R13 places it below.
  const liveViewScopes = new Set<string>();
  for (const item of conversation) {
    if (item.kind === "view" && !cardsAtCalls.has(item.key) && item.actionScope !== null) {
      liveViewScopes.add(item.actionScope);
    }
  }
  const placed = conversation.filter(
    (item) =>
      !(item.kind === "view" && cardsAtCalls.has(item.key) && item.actionScope !== null && liveViewScopes.has(item.actionScope)),
  );
  items.push(...groupTools(placed, policy, overrides));

  // R13 — persisted cards, seq order. POSITION (guuey#423): interleaved at
  // their TRUE transcript positions when the flat surface carries read-plane
  // seqs (the assemblers thread `TranscriptMessage.seq` since #423 — the
  // refinement the 3b-era note deferred): a card slots before the first
  // HISTORY user turn whose seq exceeds it. Cards newer than every seq-
  // bearing turn — and every card in a seq-less (live-only) session — keep
  // the tail, byte-identical to the old behavior. The old tail-always
  // placement + bottom-pin buried a returning visitor's conversation above
  // a stale trailing card (the #423 face). A card a reloaded call drew at
  // its own position (guuey#2388) is not placed again.
  // guuey#2031 §4.7: the first LIVE user row, on a surface whose rows carry read-plane seqs.
  const surfaceCarriesSeqs = inputs.messages.some((m) => m.seq !== undefined);
  const firstLiveUserSlot = surfaceCarriesSeqs ? users.findIndex((u) => u.seq === undefined) : -1;
  // guuey#535: ONE render session = ONE surface. Multiple history cards
  // sharing an actionScope are the same surface referenced across turns
  // (ggui SPEC §7.1.2.1 makes the amend result's {sessionId, resourceUri}
  // the normative re-anchor reference — ggui#652; the stamp rides the
  // existing locator persistence lane untouched). The LATEST reference
  // anchors the surface; earlier references emit nothing — and latest
  // wins even when it is locator-only, because the locator re-fetch
  // restores CURRENT session state, better than an older frozen snapshot.
  /** The read-plane seq an item was drawn from: a history user row or a rehydrated assistant text row. */
  const userSeqByKey = new Map<ItemKey, number>();
  users.forEach((u, i) => {
    if (u.seq !== undefined) userSeqByKey.set(`u${i}`, u.seq);
  });
  const itemSeq = (key: ItemKey): number | undefined => userSeqByKey.get(key) ?? assistantSeqByKey.get(key);
  for (const entry of scopes) {
    const { card, scope } = entry;
    if (cardsAtCalls.has(`card.${card.seq}`)) continue; // its call drew it
    if (scope !== null && latestSeqByScope.get(scope) !== card.seq) continue; // a later turn re-anchored it
    if (scope !== null && liveViewScopes.has(scope)) continue; // live mount owns it
    const view = historyCardView(entry, inputs, policy, overrides);
    // The interleave: find the first seq-bearing user turn NEWER than the
    // card; insert before its item. Cards processed in ascending seq order,
    // so same-target cards keep their relative order (each splice lands
    // after the previous card, before the user item).
    //
    // guuey#2031 §4.7: a card NEWER than every seq-bearing user turn sits
    // before the first LIVE user row when there is one — where it will sit
    // after a reload, once that row's stored seq exceeds the card's. Without
    // this, a tap on the trailing card (the greeting, most often) drew its
    // row and answer ABOVE the card, and the card jumped below the new turn.
    // A live row is a seq-less user row on a surface whose rows carry
    // read-plane seqs; on a surface with no seqs at all, every row is
    // seq-less and the tail stands, as before. History cards arrive with
    // the history seed, which lands only on an untouched chat, so a history
    // card predates every live row.
    //
    // guuey#2400: the anchor is the first seq-bearing ITEM newer than the
    // card, an assistant text row as well as a user row. A rehydrated turn's
    // assistant rows merge into one slot, so anchoring on users alone put a
    // card stored inside a turn after the whole turn, below the closing text
    // it was drawn above live.
    const newerIdx = items.findIndex((it) => {
      const seq = itemSeq(it.key);
      return seq !== undefined && card.seq < seq;
    });
    const anchorIdx =
      newerIdx !== -1
        ? newerIdx
        : firstLiveUserSlot === -1
          ? -1
          : items.findIndex((it) => it.key === `u${firstLiveUserSlot}`);
    if (anchorIdx === -1) {
      items.push(view);
    } else {
      items.splice(anchorIdx, 0, view);
    }
  }

  // R0b (guuey#2031) — card taps not yet sent as a turn, drawn at once in
  // tap order after the history cards: a pending tap sits below the card it
  // tapped, where its row will land. The plan that first shows a message
  // carrying a tap's id (`clientMessageId`) drops the tap, so the swap is
  // one plan: never both rows, never neither. Only where directive rows draw
  // as action turns; a builder who chose the verbatim bubble sees the sent
  // row alone.
  if (policy.userMessage.collapseDirectives && inputs.pendingTaps !== undefined && inputs.pendingTaps.length > 0) {
    const sentIds = new Set<string>();
    for (const m of inputs.messages) if (m.clientMessageId !== undefined) sentIds.add(m.clientMessageId);
    for (const tap of inputs.pendingTaps) {
      if (sentIds.has(tap.id)) continue;
      items.push({ kind: "tap", key: `tap.${tap.id}`, expanded: true, labels: tap.labels });
    }
  }

  // R10 — prompts, in input order (narrow on `kind`: the guuey-wire
  // link-invite arm vs the AgJSON hitl arm — spec draft.2; consent rides
  // hitl since guuey#207).
  for (const prompt of inputs.prompts) {
    const key = `p.${prompt.id}`;
    if (prompt.kind === "hitl") {
      const answer = hitlAnswerChannel(prompt.ask);
      const chosen =
        prompt.grantModeId !== undefined
          ? (prompt.ask.grantModes ?? []).find((m) => m.id === prompt.grantModeId)
          : undefined;
      items.push({
        kind: "prompt",
        key,
        promptId: prompt.id,
        // `cancelled` collapses to a dismissed record but stays expandable —
        // guuey's re-askable ruling (silverprotocol#16); pending opens.
        expanded: resolveExpanded(key, prompt.state === "pending", overrides),
        promptKind: "hitl",
        ask: prompt.ask,
        message: prompt.ask.message ?? null,
        askKind: prompt.ask.kind,
        grantModes: prompt.ask.grantModes ?? [],
        // guuey#1860: only an ask the broker answers carries the OAuth arm; an
        // agent framework's own credential ask (an ADK authUri) has no answer
        // channel here, so it is never offered as a connect button.
        oauth: answer === "broker" ? oauthAuthorizeAsk(prompt.ask) : null,
        answer,
        state: prompt.state,
        chosenModeId: prompt.grantModeId ?? null,
        chosenModeLabel: chosen !== undefined ? grantModeDisplay(chosen) : null,
        raw: policy.prompt.rawPayload
          ? { askId: prompt.ask.askId, kind: prompt.ask.kind, state: prompt.state, grantModeId: prompt.grantModeId ?? null }
          : null,
      });
      continue;
    }
    items.push({
      kind: "prompt",
      key,
      promptId: prompt.id,
      expanded: resolveExpanded(key, prompt.state === "pending", overrides),
      promptKind: prompt.kind,
      appId: prompt.appId,
      requested: prompt.requested,
      state: prompt.state,
      raw: policy.prompt.rawPayload
        ? { id: prompt.id, kind: prompt.kind, appId: prompt.appId, requested: prompt.requested, state: prompt.state }
        : null,
    });
  }

  // R11 — the coded error notice, always last. guuey#2355: the agent ending
  // the conversation is voiced by `threadClosed`, so its error is not drawn.
  const closedVoice = inputs.threadClosed ?? null;
  // guuey#2604: a send refused before admission is voiced by its own failed
  // bubble (R0's `failureLine`), so its error is not drawn twice.
  if (inputs.error && refusedSend === null && !(closedVoice !== null && inputs.error.code === closedVoice.code)) {
    const code = inputs.error.code;
    const { family, copy, tone } = codedErrorCopy(code, inputs.error.message, policy);
    items.push({
      kind: "error",
      key: "error",
      expanded: true,
      family,
      ...(tone !== undefined ? { tone } : {}),
      code,
      copy,
      message: inputs.error.message,
      verbatim: policy.error.verbatim ? `${code ?? "uncoded"}: ${inputs.error.message}` : null,
    });
  }

  // The host-canvas contract (guuey#301): every view the plan saw, with
  // its mount material — collected BEFORE any chips/promotion pass, so a
  // stage can render the selected mount even when the transcript shows
  // only chips.
  const views: PlanViewSummary[] = [];
  for (const item of items) {
    if (item.kind !== "view") continue;
    views.push({
      key: item.key,
      title: item.toolTitle ?? policy.strings.viewRefFallbackTitle,
      phase: item.phase,
      channel: item.channel,
      mount: item.mount,
      actionScope: item.actionScope,
      // The kit's own key scheme is authoritative here: `card.{seq}` is
      // exactly the history-card emission (this file builds both).
      origin: item.key.startsWith("card.") ? "history" : "live",
    });
  }

  // Two composable behaviors over the assembled items:
  //
  // guuey#204 "promote and reference" (inline presentation): the ONE mount
  // a host-owned stage shows (`inputs.promotedViewKey`) renders as a
  // compact reference chip instead of a second live app instance. A key
  // matching nothing (stale host state) or an expired mount promotes
  // nothing — the honest no-op; the next render's key corrects it.
  //
  // guuey#301 chips presentation (`policy.view.presentation === "chips"`):
  // EVERY view plans as a chip — the full render belongs to the host's
  // stage; the promoted key marks the SELECTED chip (browser-history
  // mechanic), and expired/dead views chip with their honest state.
  //
  // Either way a chip keeps the mount's key, so overrides and phase
  // reports survive a swap back to the full mount.
  const promoted = inputs.promotedViewKey;
  const chips = policy.view.presentation === "chips";
  const finalItems =
    !chips && promoted === undefined
      ? items
      : items.map((item): DisplayItem => {
          if (item.kind !== "view") return item;
          const title = item.toolTitle ?? policy.strings.viewRefFallbackTitle;
          if (chips) {
            const mountable = item.phase !== "expired" && item.mount !== null;
            const selected = mountable && item.key === promoted;
            const ref: ViewRefItem = {
              kind: "viewRef",
              key: item.key,
              expanded: false,
              title,
              label: selected
                ? policy.strings.viewPromoted(title)
                : mountable
                  ? policy.strings.viewChip(title)
                  : policy.strings.viewChipExpired(title),
              selected,
              phase: item.phase,
            };
            return ref;
          }
          if (item.key !== promoted) return item;
          if (item.phase === "expired" || item.mount === null) return item;
          const ref: ViewRefItem = {
            kind: "viewRef",
            key: item.key,
            expanded: false,
            title,
            label: policy.strings.viewPromoted(title),
            selected: true,
            phase: item.phase,
          };
          return ref;
        });

  return {
    items: finalItems,
    status: planStatusLine(inputs, policy),
    recovery:
      inputs.adopted === true && policy.debugDetail ? policy.strings.recoveredFromHistory : null,
    views,
    // guuey#605 — the typed refusal, derived from the PENDING hitl asks only.
    // A settled or dismissed record never gates the surface: the pod is the
    // enforcer (it refuses each turn and re-cards), and a "no" that locked the
    // composer would dead-end a user who cannot un-dismiss.
    authRequired: authRequiredFromAsks(
      inputs.prompts.flatMap((p) => (p.kind === "hitl" && p.state === "pending" ? [p.ask] : [])),
    ),
    threadClosed: closedVoice !== null ? { code: closedVoice.code, message: closedVoice.message } : null,
  };
}

/**
 * The plan key of the NEWEST mountable view — what a "most recent card"
 * stage (the widget's CanvasPane) will show, derived in the same family
 * the plan's own emission uses: live fold mounts (transcript order, last
 * wins) outrank history cards (ascending `seq`). `undefined` when nothing
 * narrows to a mountable resource. Hosts pass the key back as
 * `TranscriptInputs.promotedViewKey`; `channel` lets a host decline to
 * promote a bare locator when no reader is wired (the stage would show
 * nothing, and a chip must never point at an empty canvas).
 */
export function newestViewKey(
  inputs: Pick<TranscriptInputs, "result" | "historyCards">,
): { key: string; channel: ViewMount["channel"] } | undefined {
  let newest: { key: string; channel: ViewMount["channel"] } | undefined;
  const cards = [...(inputs.historyCards ?? [])].sort((a, b) => a.seq - b.seq);
  for (const card of cards) {
    const mount = snapshotViewMount(card.cardSnapshot);
    if (mount === undefined) continue;
    newest = { key: `card.${card.seq}`, channel: mount.channel };
  }
  for (const message of inputs.result?.messages ?? []) {
    for (const block of message.content) {
      if (block.type !== "tool-result") continue;
      const mount = toolResultViewMount(block);
      if (mount === undefined) continue;
      newest = { key: `view.${block.toolCallId}`, channel: mount.channel };
    }
  }
  return newest;
}
