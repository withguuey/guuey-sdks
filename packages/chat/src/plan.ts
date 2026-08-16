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
 *    the transcript invariant of a request/reply chat. Finer-grained
 *    interleaving (true seq-ordering of history cards inside turns) needs
 *    read-plane sequence numbers the flat surface does not carry; the 3b
 *    assemblers own that refinement.
 *
 * Key scheme (stable across streaming updates): `u{slot}` user rows,
 * `a{slot}.t{n}`/`.r{n}`/`.m{n}`/`.c{n}`/`.d{n}`/`.s{n}`/`.k{n}`/`.u{n}`
 * per-kind ordinals inside an assistant slot, `tool.{toolCallId}` tool rows
 * (the id survives `running → done` — spec §7), `view.{toolCallId}` mounts,
 * `g.{firstToolKey}` derived groups, `card.{seq}` history cards, `p.{id}`
 * prompts, `error`, `history` boundaries. Append-only streams only ever
 * append ordinals, so every existing key survives each re-plan.
 */
import type { AgBlock, AgReduceResult, JsonValue } from "@silverprotocol/core";
import {
  snapshotViewMount,
  toolResultLocator,
  toolResultViewMount,
  uiResourceChannel,
  type ViewMount,
} from "@guuey/mcp-apps-host";
import type { TranscriptPolicy } from "./policy.js";
import { grantModeDisplay } from "./hitl.js";
import type {
  CitationsItem,
  DataResultItem,
  DisplayItem,
  ItemKey,
  NoticeItem,
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
 * without asserting a shape the source type does not promise. `JSON.parse`'s
 * output IS JsonValue by construction — the assertion states that fact.
 */
function jsonClone(value: unknown): JsonValue | null {
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  return JSON.parse(text) as JsonValue;
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

function foldAssistantSources(
  result: AgReduceResult,
  inFlight: boolean,
  aborted: boolean,
): { sources: AssistantSource[]; notices: FoldNotice[] } {
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
  const sources: AssistantSource[] = [];
  const notices: FoldNotice[] = [];
  for (const m of result.messages) {
    if (m.role === "assistant") {
      sources.push({
        blocks: [...m.content],
        live: inFlight && hasTurnIdentity && m.turnId !== undefined && openTurns.has(m.turnId),
        stopped: false,
      });
    } else if (m.role === "tool" && sources.length > 0) {
      sources[sources.length - 1]!.blocks.push(...m.content);
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
    last.stopped = aborted;
  }
  return { sources, notices };
}

function flatAssistantSources(inputs: TranscriptInputs, inFlight: boolean): AssistantSource[] {
  const settled: AssistantSource[] = inputs.messages
    .filter((m) => m.role === "assistant")
    .map((m) => ({ blocks: [{ type: "text", text: m.text }], live: false, stopped: false }));
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

function dataResultFromToolResult(
  block: ToolResultBlock,
  key: ItemKey,
  policy: TranscriptPolicy,
  overrides: TranscriptOverrides,
): DataResultItem {
  const payload = block.structuredContent !== undefined ? block.structuredContent : undefined;
  const textParts = block.content
    .filter((b): b is Extract<AgBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .filter((t) => t !== "");
  const mediaParts = block.content.filter(
    (b) => b.type === "image" || b.type === "audio" || b.type === "file" || b.type === "document",
  );

  let state: DataResultItem["state"];
  let preview: string | null;
  let byteCount: number;
  if (payload !== undefined) {
    byteCount = jsonByteSize(payload);
    preview = boundedPreview(payload, policy.dataResult.previewChars, policy.dataResult.prettyPrint);
    state = byteCount > GIANT_RESULT_BYTES ? "giant" : "small";
  } else if (textParts.length > 0) {
    const joined = textParts.join("\n");
    byteCount = joined.length;
    preview =
      joined.length > policy.dataResult.previewChars
        ? joined.slice(0, policy.dataResult.previewChars)
        : joined;
    state = byteCount > GIANT_RESULT_BYTES ? "giant" : "small";
  } else if (mediaParts.length > 0) {
    byteCount = jsonByteSize(mediaParts);
    preview = null;
    state = "binary";
  } else if (block.errorText !== undefined && block.errorText !== "") {
    byteCount = block.errorText.length;
    preview = block.errorText;
    state = "small";
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
  item: Pick<ViewMountItem, "phase" | "channel" | "mount">,
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
      // Channel-aware (R6): a ggui shell that never handshakes is a boot
      // failure; inline tenant HTML may legitimately be a non-App document.
      // Keyed on the TRUST channel (locators resolve to it by uri), not the
      // mount arm — a live ggui card is a locator until its read lands.
      return trustChannel(item) === "ggui" ? s.viewBootFailure : s.viewInlineFallback;
  }
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

/** Walk one assistant slot's blocks into display items (matrix R1–R9, R14, R15). */
function planAssistantSource(
  source: AssistantSource,
  slot: number,
  inputs: TranscriptInputs,
  policy: TranscriptPolicy,
  overrides: TranscriptOverrides,
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

  for (const block of source.blocks) {
    if (block.type !== "search-result" && block.type !== "resource" && block.type !== "resource-link") {
      flushCitations();
    }
    switch (block.type) {
      case "text": {
        if (block.text === "") break; // R1 empty-turn: no empty bubble.
        const key = `${prefix}.t${ordinals.t++}`;
        lastTextKey = key;
        items.push({
          kind: "text",
          key,
          expanded: resolveExpanded(key, true, overrides),
          text: block.text,
          markdown: policy.text.markdown,
          streaming: false, // the LAST text item of a live slot flips below
          stopped: false, // the abort marker lands on the last text item below
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
        const result = resultsById.get(block.toolCallId);
        if (result) consumedResults.add(block.toolCallId);
        const mount: ViewMount | undefined = result ? toolResultViewMount(result) : undefined;
        const failed = result !== undefined && toolFailed(result);
        const state: ToolItem["state"] = result
          ? failed
            ? "failed"
            : "done"
          : source.live && inputs.aborted !== true
            ? "running"
            : "orphaned";
        const tool: ToolItem = {
          kind: "tool",
          key,
          expanded: resolveExpanded(key, policy.tool.expandByDefault, overrides),
          toolCallId: block.toolCallId,
          name: block.name,
          title: policy.tool.humanizeTitle(block.title ?? block.name),
          state,
          argsPreview: policy.tool.argsVisible
            ? boundedPreview(block.input, policy.dataResult.previewChars)
            : null,
          result:
            result && mount === undefined
              ? dataResultFromToolResult(result, `${key}.result`, policy, overrides)
              : null,
          // R4's display-bearing rule: in calm the call line folds into the
          // view row's chrome as attribution; debug keeps the explicit line.
          attribution: mount !== undefined && !policy.debugDetail,
        };
        items.push(tool);
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
            attribution: policy.debugDetail ? null : policy.strings.viaTool(tool.title),
            toolTitle: tool.title,
            // `result` is narrowed by `mount !== undefined` above; the scope
            // is the PERSISTED locator (`uiData.resourceUri`), never the
            // mount payload's own uri (synthetic for a ggui shell).
            actionScope: result ? (toolResultLocator(result) ?? null) : null,
          };
          view.label = viewLabel(view, policy);
          items.push(view);
        }
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
        const key = `${prefix}.d${ordinals.d++}`;
        items.push(dataResultFromToolResult(block, key, policy, overrides));
        break;
      }
      case "image":
      case "audio":
      case "file":
      case "document": {
        const key = `${prefix}.m${ordinals.m++}`;
        const name =
          block.type === "file"
            ? (block.filename ?? null)
            : block.type === "document"
              ? (block.title ?? null)
              : null;
        items.push({
          kind: "media",
          key,
          expanded: resolveExpanded(key, true, overrides),
          media: block.type,
          source: block.source,
          name,
          presentation:
            policy.media.chipOnly || block.type === "file" || block.type === "document"
              ? "chip"
              : "inline",
        });
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

  for (const item of items) {
    // Silent = the row's entire output lives inside its own expansion (R5
    // data, however large). Display-bearing calls carry `attribution` and
    // their ViewMountItem already sits between tool rows, breaking the run.
    if (item.kind === "tool" && (item.state === "done" || item.state === "failed") && !item.attribution) {
      run.push(item);
    } else {
      flush();
      out.push(item);
    }
  }
  flush();
  return out;
}

/** §4's status derivation — thresholds and copy from policy, elapsed as input. */
function deriveStatus(inputs: TranscriptInputs, policy: TranscriptPolicy): StatusLineItem | null {
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
      const title = policy.tool.humanizeTitle(inputs.activeTool ?? "");
      return { kind: "status", key: "status", state: "using-tool", copy: s.usingTool(title), detail };
    }
  }
}

const ERROR_FAMILIES: Record<string, "auth" | "quota" | "invalid"> = {
  UNAUTHORIZED: "auth",
  AUTH_REQUIRED: "auth",
  GUEST_ACCESS_DISABLED: "auth",
  FORBIDDEN: "auth",
  QUOTA_EXCEEDED: "quota",
  MANAGED_SPEND_CAP: "quota",
  INVALID_REQUEST: "invalid",
};

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
  }

  const inFlight = inputs.status !== "ready";
  const users = inputs.messages.filter((m) => m.role === "user");
  // R16 — notice rows are session annotations anchored between turns: a
  // flat notice renders after the conversation slot of the user turn it
  // followed (usersSeen-1; -1 = before the conversation). They are PEER
  // rows — excluded from both the user pairing and the assistant seam
  // count, so the fold alignment below never sees them.
  const notices: Array<{ key: string; text: string; source: NoticeItem["source"]; afterSlot: number }> = [];
  if (policy.notice.show) {
    let usersSeen = 0;
    inputs.messages.forEach((m, i) => {
      if (m.role === "user") usersSeen += 1;
      else if (m.role === "notice") {
        notices.push({ key: `n${i}`, text: m.text, source: m.noticeSource ?? null, afterSlot: usersSeen - 1 });
      }
    });
  }
  // Turn-scoped fold composition (guuey#135 kit refinement): the fold owns
  // the TRAILING assistant turns it actually covers — its settled sources
  // replace that many trailing flat assistant entries; any EARLIER flat
  // entries (a rehydrated/persisted prefix the session's Reducer never saw)
  // keep rendering as flat text slots in front. When the fold spans the
  // whole conversation (a pure-live session — the corpus's world), the kept
  // prefix is empty and the plan is byte-identical to the old wholesale
  // replace. Alignment is by COUNT (trailing flat entries ↔ settled fold
  // sources): flat rows carry no turn identity, so a persisted CARD-ONLY
  // turn inside the fold's span (an empty-text assistant row the assembler
  // dropped) can offset the seam by one — a documented approximation, same
  // class as the header's read-plane-seq note, resolved for the visible
  // cards by the actionScope dedupe below.
  let assistants: AssistantSource[];
  if (inputs.result) {
    const fold = foldAssistantSources(inputs.result, inFlight, inputs.aborted === true);
    const foldSources = fold.sources;
    const settledFoldCount = foldSources.filter((s) => !s.live).length;
    const flatSettled = inputs.messages.filter((m) => m.role === "assistant");
    const keep = Math.max(0, flatSettled.length - settledFoldCount);
    assistants = [
      ...flatSettled.slice(0, keep).map(
        (m): AssistantSource => ({
          blocks: [{ type: "text", text: m.text }],
          live: false,
          stopped: false,
        }),
      ),
      ...foldSources,
    ];
    if (policy.notice.show) {
      // Fold-borne notices anchor to the fold source they followed, which
      // sits at global slot `keep + afterSourceIndex` after the seam.
      fold.notices.forEach((n, i) => {
        notices.push({ key: `nf${i}`, text: n.text, source: n.source, afterSlot: keep + n.afterSourceIndex });
      });
    }
  } else {
    assistants = flatAssistantSources(inputs, inFlight);
  }

  const slots = Math.max(users.length, assistants.length);
  const conversation: DisplayItem[] = [];
  const noticeItem = (n: (typeof notices)[number]): NoticeItem => ({
    kind: "notice",
    key: n.key,
    expanded: true,
    text: n.text,
    source: n.source,
    sourceLabel: policy.debugDetail && n.source !== null ? n.source : null,
  });
  for (const n of notices) if (n.afterSlot < 0) conversation.push(noticeItem(n));
  for (let slot = 0; slot < slots; slot++) {
    const user = users[slot];
    if (user) {
      const key = `u${slot}`;
      const sendState =
        user.clientMessageId !== undefined
          ? (inputs.sendStates?.[user.clientMessageId] ?? "sent")
          : "sent";
      conversation.push({
        kind: "user",
        key,
        expanded: true,
        text: user.text,
        state: sendState,
        retry: sendState === "failed" && policy.userMessage.retryAffordance,
      });
    }
    const assistant = assistants[slot];
    if (assistant) {
      conversation.push(...planAssistantSource(assistant, slot, inputs, policy, overrides));
    }
    for (const n of notices) if (n.afterSlot === slot) conversation.push(noticeItem(n));
  }
  items.push(...groupTools(conversation, policy, overrides));

  // R13 — persisted cards, seq order. (Position: after the settled
  // conversation; true in-turn interleave needs read-plane seqs the flat
  // surface lacks — the 3b assemblers own that refinement.)
  //
  // Dedupe against LIVE mounts by actionScope (the persisted `ui://`
  // identity both sides carry): a session whose fold still holds a turn the
  // read plane has ALSO persisted — the #192 adopted turn, a thread view's
  // post-handoff refetch — would otherwise render the same card twice. The
  // fold's view row owns it (richer phase state); the history snapshot
  // renders only when no live mount claims its identity.
  const liveViewScopes = new Set<string>();
  for (const item of items) {
    if (item.kind === "view" && item.actionScope !== null) liveViewScopes.add(item.actionScope);
  }
  const cards = [...(inputs.historyCards ?? [])].sort((a, b) => a.seq - b.seq);
  for (const card of cards) {
    const key = `card.${card.seq}`;
    const mount = snapshotViewMount(card.cardSnapshot);
    const scope =
      mount === undefined
        ? null
        : mount.channel === "locator"
          ? mount.resourceUri
          : mount.resource.uri;
    if (scope !== null && liveViewScopes.has(scope)) continue; // live mount owns it
    const view: ViewMountItem = {
      kind: "view",
      key,
      expanded: resolveExpanded(key, true, overrides),
      mount: mount ?? null,
      channel: mount?.channel ?? null,
      phase: mount === undefined ? "expired" : (inputs.viewPhases?.[key] ?? "negotiating"),
      label: null,
      attribution: null,
      toolTitle: null,
      actionScope: scope,
    };
    view.label = viewLabel(view, policy);
    items.push(view);
  }

  // R10 — prompts, in input order (narrow on `kind`: the guuey-wire
  // profile arm vs the AgJSON hitl arm, spec draft.2).
  for (const prompt of inputs.prompts) {
    const key = `p.${prompt.id}`;
    if (prompt.kind === "hitl") {
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

  // R11 — the coded error notice, always last.
  if (inputs.error) {
    const code = inputs.error.code;
    const family = (code !== null ? ERROR_FAMILIES[code] : undefined) ?? "transient";
    const familyCopy =
      family === "auth"
        ? policy.strings.errorAuth
        : family === "quota"
          ? policy.strings.errorQuota
          : family === "invalid"
            ? policy.strings.errorInvalid
            : policy.strings.errorTransient;
    // Voice resolution (R11's per-code knob): an exact per-code sentence
    // wins; then a verbatim match renders the SOURCE message ("all" covers
    // code-less client errors too — the widget's #162 posture); an empty
    // source message falls back to family copy rather than a blank notice.
    const { copyByCode, verbatimCodes } = policy.error;
    const perCode = code !== null ? copyByCode[code] : undefined;
    const verbatimVoice =
      verbatimCodes === "all" || (code !== null && verbatimCodes.includes(code));
    const copy =
      perCode ?? (verbatimVoice && inputs.error.message !== "" ? inputs.error.message : familyCopy);
    items.push({
      kind: "error",
      key: "error",
      expanded: true,
      family,
      code,
      copy,
      message: inputs.error.message,
      verbatim: policy.error.verbatim ? `${code ?? "uncoded"}: ${inputs.error.message}` : null,
    });
  }

  // guuey#204 "promote and reference": the ONE mount a host-owned stage
  // shows (`inputs.promotedViewKey`) renders as a compact reference chip
  // instead of a second live app instance. A key matching nothing (stale
  // host state) or an expired mount promotes nothing — the honest no-op;
  // the next render's key corrects it. The chip keeps the mount's key, so
  // overrides and phase reports survive a swap back to the full mount.
  const promoted = inputs.promotedViewKey;
  const finalItems =
    promoted === undefined
      ? items
      : items.map((item): DisplayItem => {
          if (item.kind !== "view" || item.key !== promoted) return item;
          if (item.phase === "expired" || item.mount === null) return item;
          const title = item.toolTitle ?? policy.strings.viewRefFallbackTitle;
          const ref: ViewRefItem = {
            kind: "viewRef",
            key: item.key,
            expanded: false,
            title,
            label: policy.strings.viewPromoted(title),
          };
          return ref;
        });

  return {
    items: finalItems,
    status: deriveStatus(inputs, policy),
    recovery:
      inputs.adopted === true && policy.debugDetail ? policy.strings.recoveredFromHistory : null,
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
