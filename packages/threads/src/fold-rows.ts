/**
 * Pure mappers between the AgJSON fold (`AgReduceResult` components) and
 * `ThreadMessage` rows / `ThreadSnapshot`. No AWS, no I/O — the byte-identity
 * round-trip lives here and is unit-tested table-free. See
 * docs/superpowers/specs/2026-06-23-agjson-persistence-fold-design.md §6–§9.
 */
import type {
  AgMessage,
  AgArtifact,
  AgTurnRecord,
  AgRole,
  AgReduceResult,
  AgEvent,
  AgMemoryRecord,
  JsonValue,
} from "@silverprotocol/core";
import { AgMessage as AgMessageSchema } from "@silverprotocol/core";
import type { ThreadMessageRow, ThreadMessageRole, ThreadMessageKind, ThreadSnapshotRow } from "./rows.js";
import { asUiResource, scanProviderRawForUiResource, toolResultLocator } from "@guuey/mcp-apps-host/narrowing";

export interface RowCtx {
  threadId: string;
  userId: string;
  seq: number;
  at: string;
  clientMessageId: string;
  /**
   * guuey#524: set by the pod for a page-aware turn's writes — every row
   * of that turn (message and card alike) carries the stamp. See
   * `ThreadMessageRow.untrustedOrigin`.
   */
  untrustedOrigin?: boolean;
}

/** AgRole → the row's coarse authorRole projection (secondary; role of record lives in content). */
function roleToAuthor(role: AgRole): ThreadMessageRole {
  if (role === "user") return "user";
  if (role === "system") return "system";
  return "agent"; // assistant | tool
}

/**
 * Plain-text projection of an AgMessage. Distinct text blocks are distinct
 * paragraphs, so they join with a paragraph break — the same block-boundary
 * contract as `@guuey/agent-client`'s live flat-text fold (guuey#98); raw
 * concatenation jammed "…instead.Here's your packing…". Empty blocks
 * contribute nothing (no stacked separators).
 */
export function messageText(msg: AgMessage): string {
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text" && block.text) parts.push(block.text);
  }
  return parts.join("\n\n");
}

export function agMessageToRow(
  msg: AgMessage,
  ctx: RowCtx & { turnRecord?: AgTurnRecord }
): ThreadMessageRow {
  const text = messageText(msg);
  const kind: ThreadMessageKind = "text";
  return {
    threadId: ctx.threadId,
    seq: ctx.seq,
    userId: ctx.userId,
    clientMessageId: ctx.clientMessageId,
    at: ctx.at,
    kind,
    authorRole: roleToAuthor(msg.role),
    ...(text ? { text } : {}),
    // guuey#122: the ONE deliberate byte-identity exception — tool-result
    // `_meta` (live-turn mount material, incl. short-TTL credentials) is
    // stripped before persistence, on the message row exactly as on the
    // card projection.
    content: messageWithoutToolResultMeta(msg),
    // SANCTIONED EXCEPTION to the #122 no-short-TTL rule (explicit decision,
    // 2026-08-08): the turnRecord persists verbatim, INCLUDING paused-outcome
    // asks[].token/expiresAt — reassembleFold round-trips turns into the
    // reducer seed, so stripping could orphan a paused turn's resume after a
    // reload, and the token authorizes the thread owner's OWN resume (not a
    // cross-trust credential like a render wsToken). Revisit on guuey#122.
    ...(ctx.turnRecord ? { aiContext: ctx.turnRecord } : {}),
    ...(ctx.untrustedOrigin === true ? { untrustedOrigin: true } : {}),
  };
}

/** Strip every tool-result block's `_meta` (guuey#122); identity when none carried one. */
function messageWithoutToolResultMeta(msg: AgMessage): AgMessage {
  let changed = false;
  const content = msg.content.map((block) => {
    if (block.type !== "tool-result") return block;
    const stripped = withoutToolResultMeta(block);
    if (stripped !== block) changed = true;
    return stripped;
  });
  return changed ? { ...msg, content } : msg;
}

/**
 * MCP-App cards ride `tool-result` blocks' UI channels inside AgMessages —
 * the Claude facet emits NO `artifact.*` events, so `fold.artifacts` alone
 * misses every generative-UI card and nothing ever wrote a `kind:'card'`
 * row for them (guuey#86: cards never rehydrated after a reload). Project
 * UI-carrying tool-result blocks into synthetic AgArtifacts so the
 * EXISTING card-row lane persists them; the client's `snapshotViewMount`
 * mounts `{ parts: [block] }` through its inline arm unchanged. Facets
 * that DO emit artifact events don't stamp `uiData` on tool-results, so
 * the two sources don't double-write for one card.
 *
 * The narrowing is IMPORTED from `@guuey/mcp-apps-host` (the SEP-1865 Host
 * package) — one implementation, no mirror to keep in sync:
 *   1. `uiData` carrying an MCP resource payload (`{uri, text|blob}`,
 *      inlined directly or wrapped as `{ resource: {...} }`) — the explicit
 *      surface channel, no `ui://` gate on purpose;
 *   2. a `ui://` resource degraded into a `provider-raw` content part —
 *      gated on the scheme, because provider-raw is a lossy catch-all.
 */
/**
 * Persistence boundary rule (guuey#122): a tool-result block's `_meta` is
 * live-turn MOUNT/TRANSPORT material — vendor slices there routinely carry
 * short-TTL credentials (ggui's render bootstrap `wsToken` is the concrete
 * case) and are dead on arrival when replayed, so `_meta` NEVER persists.
 * Durable identity belongs in `uiData`/`content`, which survive untouched.
 * Deliberately vendor-agnostic: no `_meta` key list to maintain, and the
 * next vendor's expiring credential is unpersistable by construction.
 */
function withoutToolResultMeta(
  block: Extract<AgMessage["content"][number], { type: "tool-result" }>,
): typeof block {
  if (block._meta === undefined) return block;
  const { _meta: _dropped, ...rest } = block;
  return rest;
}

export function uiCardArtifactsFromMessages(messages: AgMessage[]): AgArtifact[] {
  const artifacts: AgArtifact[] = [];
  for (const msg of messages) {
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i]!;
      if (block.type !== "tool-result") continue;
      // guuey#122: a ui:// locator (uiData.resourceUri — ggui renders are
      // one producer) persists as a PLACEHOLDER row: the locator without
      // mount material (mount = re-fetch of the resourceUri). Before this,
      // locator-only results persisted nothing and vanished from history.
      // The locator reads BOTH channels (guuey#209): the claude-agent-sdk
      // facet stamps `uiData` only when the result's sibling `_meta.ui` is
      // present (guuey#170); a producer that withholds `_meta` delivers the
      // same `ui://` locator in `structuredContent` instead — without this
      // read the render's own locator would never mint a placeholder row and
      // the read plane 404s it. Mount MATERIAL still never rides `_meta` here
      // (see the metaOnly pin in fold-rows.test.ts): a bare locator persists
      // as a placeholder whose mount is a re-fetch.
      const carriesUi =
        asUiResource(block.uiData) !== undefined ||
        toolResultLocator(block) !== undefined ||
        block.content.some(
          (part) =>
            part.type === "provider-raw" && scanProviderRawForUiResource(part.raw) !== undefined,
        );
      if (!carriesUi) continue;
      artifacts.push({
        artifactId: `${msg.id}#ui#${i}`,
        turnId: msg.turnId ?? "",
        threadId: msg.threadId ?? "",
        parts: [withoutToolResultMeta(block)],
      });
    }
  }
  return artifacts;
}

/**
 * toolCallId → tool name, read off every `tool-call` block in the fold's
 * messages (guuey#402). The name rides ONLY the tool-call block; results
 * carry just the id, so this map is how a card row learns which tool
 * produced it. First writer wins on a duplicate id (ids are unique per
 * provider contract; a collision would be the provider's bug).
 */
export function toolNamesByCallId(messages: AgMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool-call" && !names.has(block.toolCallId)) {
        names.set(block.toolCallId, block.name);
      }
    }
  }
  return names;
}

/**
 * The producing tool's name for a card artifact: the first tool-result part
 * whose `toolCallId` the fold's tool-call blocks named (guuey#402).
 * `undefined` when unresolvable — a first-class `artifact.*` event with no
 * tool-result part, or a call outside this fold. Callers persist absence,
 * never a guess (humanization and fallbacks are the kit's, one owner).
 */
export function producingToolName(
  art: AgArtifact,
  toolNames: ReadonlyMap<string, string>,
): string | undefined {
  for (const part of art.parts) {
    if (isJsonObjectLike(part) && part.type === "tool-result" && typeof part.toolCallId === "string") {
      const name = toolNames.get(part.toolCallId);
      if (name !== undefined) return name;
    }
  }
  return undefined;
}

export function agArtifactToCardRow(art: AgArtifact, ctx: RowCtx, toolName?: string): ThreadMessageRow {
  // guuey#122: the projection lane strips tool-result _meta upstream, but
  // REAL artifact.* events land here verbatim — apply the same persistence
  // boundary to any tool-result-typed part (and the artifact-level _meta),
  // so no lane can persist a short-TTL credential.
  const parts = art.parts.map((part) =>
    isJsonObjectLike(part) && part.type === "tool-result" ? withoutToolResultMeta(part) : part,
  );
  const { _meta: _artifactMeta, ...artRest } = art as AgArtifact & { _meta?: unknown };
  const snapshot: AgArtifact = { ...artRest, parts };
  return {
    threadId: ctx.threadId,
    seq: ctx.seq,
    userId: ctx.userId,
    clientMessageId: ctx.clientMessageId,
    at: ctx.at,
    kind: "card",
    authorRole: "agent",
    content: { producedInTurnId: art.turnId },
    cardSnapshot: snapshot,
    // guuey#402: the RAW producing tool name, resolved by the caller from
    // the fold's tool-call blocks. Absent stays absent — old rows and
    // unresolvable producers keep the reader's fallback honest.
    ...(toolName !== undefined ? { toolName } : {}),
    ...(ctx.untrustedOrigin === true ? { untrustedOrigin: true } : {}),
  };
}

/** Local structural check (narrow enough for the strip dispatch above). */
function isJsonObjectLike(v: unknown): v is { type?: unknown; _meta?: unknown } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Reconstruct an AgMessage from a row. Agent-fold rows store the verbatim
 * AgMessage in `content`; user/system rows (persisted up-front) store plain
 * `{ kind, text }` — synthesize a single-text-block AgMessage for those so
 * the reassembled transcript is uniform.
 */
export function rowToAgMessage(row: ThreadMessageRow): AgMessage {
  const parsed = AgMessageSchema.safeParse(row.content);
  if (parsed.success) return parsed.data;
  const role: AgRole =
    row.authorRole === "user" ? "user" : row.authorRole === "system" ? "system" : "assistant";
  const text = row.text ?? "";
  return {
    id: `${row.threadId}#${row.seq}`,
    role,
    content: text ? [{ type: "text", text }] : [],
    threadId: row.threadId,
  };
}

/** Extract the AgArtifact from a kind='card' row, or undefined if malformed. */
export function cardRowToAgArtifact(row: ThreadMessageRow): AgArtifact | undefined {
  const snap = row.cardSnapshot;
  if (snap && typeof snap === "object" && "artifactId" in snap) {
    return snap as AgArtifact;
  }
  return undefined;
}

/**
 * Reassemble an AgReduceResult from persisted rows + the thread snapshot.
 * Inverse of the per-turn write (design §9). Append components come from
 * rows in seq order; latest-replace components from the snapshot. Byte-
 * identical to reduce() over the agent-folded portion — EXCEPT that
 * `artifacts` additionally carries the UI-card projections
 * ({@link uiCardArtifactsFromMessages}) the live reduce() never produced.
 * Re-persisting a reassembled fold through `appendFold` stays single-write:
 * the projection is deduped by its deterministic `<msgId>#ui#<idx>`
 * artifactIds there.
 */
export function reassembleFold(
  rows: ThreadMessageRow[],
  snapshot: ThreadSnapshotRow | undefined
): AgReduceResult {
  const ordered = rows.slice().sort((a, b) => a.seq - b.seq);
  const messages: AgMessage[] = [];
  const artifacts: AgArtifact[] = [];
  const turnsById = new Map<string, AgTurnRecord>();

  for (const row of ordered) {
    if (row.kind === "card") {
      const art = cardRowToAgArtifact(row);
      if (art) artifacts.push(art);
      continue;
    }
    messages.push(rowToAgMessage(row));
    const tr = row.aiContext;
    if (tr && typeof tr === "object" && "turnId" in tr) {
      const rec = tr as AgTurnRecord;
      if (!turnsById.has(rec.turnId)) turnsById.set(rec.turnId, rec);
    }
  }

  return {
    messages,
    artifacts,
    memory: snapshot?.threadMemory ?? [],
    turns: [...turnsById.values()],
    ...(snapshot?.workingState !== undefined ? { state: snapshot.workingState } : {}),
  };
}

/**
 * Synthetic events that seed a reducer with prior latest-replace state before
 * folding a turn (design §8.1). Seeds state + thread-memory ONLY — never
 * messages/artifacts/turns — so result() yields this turn's append-delta while
 * carrying cumulative state/memory. Contiguous seqs 0..K (no internal gap); the
 * live stream that follows uses its own per-message 0-based seqs (backward
 * jumps, which the reducer tolerates). Push these into the reducer but never
 * emit them to the client.
 *
 * Each synthetic `memory.write` carries `turnId` so the reducer's SET handler
 * lands it back onto the AgMemoryRecord — without it, a re-seeded thread-memory
 * record loses its turnId and memory byte-identity breaks from turn 2 on.
 * (`threadId` is NOT carried: `memory.write` has no threadId on its event arm,
 * so it cannot round-trip through a live write — that is expected.)
 */
export function seedEventsForReducer(
  priorState: JsonValue | undefined,
  priorThreadMemory: AgMemoryRecord[]
): AgEvent[] {
  const events: AgEvent[] = [];
  let seq = 0;
  if (priorState !== undefined) {
    events.push({ seq: seq++, type: "state.snapshot", snapshot: priorState });
  }
  for (const rec of priorThreadMemory) {
    events.push({
      seq: seq++,
      type: "memory.write",
      scope: "thread",
      ...(rec.key !== undefined ? { key: rec.key } : {}),
      value: rec.value,
      ...(rec.reason !== undefined ? { reason: rec.reason } : {}),
      ...(rec.durable !== undefined ? { durable: rec.durable } : {}),
      ...(rec.turnId !== undefined ? { turnId: rec.turnId } : {}),
    });
  }
  return events;
}
