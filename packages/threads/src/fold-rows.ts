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

export interface RowCtx {
  threadId: string;
  userId: string;
  seq: number;
  at: string;
  clientMessageId: string;
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
    content: msg,
    ...(ctx.turnRecord ? { aiContext: ctx.turnRecord } : {}),
  };
}

/**
 * MCP-App cards ride `tool-result` blocks' UI channels inside AgMessages —
 * the Claude facet emits NO `artifact.*` events, so `fold.artifacts` alone
 * misses every generative-UI card and nothing ever wrote a `kind:'card'`
 * row for them (guuey#86: cards never rehydrated after a reload). Project
 * UI-carrying tool-result blocks into synthetic AgArtifacts so the
 * EXISTING card-row lane persists them; the client's `cardCardMount`
 * mounts `{ parts: [block] }` through its inline arm unchanged. Facets
 * that DO emit artifact events don't stamp `uiData` on tool-results, so
 * the two sources don't double-write for one card.
 *
 * The narrowing MIRRORS `@guuey/agent-client`'s `toolResultUiResource`
 * (@guuey/agent-client's block-ui.ts — keep the two in sync):
 *   1. `uiData` carrying an MCP resource payload (`{uri, text|blob}`,
 *      inlined directly or wrapped as `{ resource: {...} }`) — the explicit
 *      surface channel, no `ui://` gate on purpose;
 *   2. a `ui://` resource degraded into a `provider-raw` content part —
 *      gated on the scheme, because provider-raw is a lossy catch-all.
 */
function isJsonObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isResourcePayload(v: JsonValue | undefined): boolean {
  if (!isJsonObject(v)) return false;
  if (typeof v.uri !== "string") return false;
  return typeof v.text === "string" || typeof v.blob === "string";
}

function resourceUri(v: JsonValue | undefined): string | undefined {
  if (!isJsonObject(v)) return undefined;
  return typeof v.uri === "string" ? v.uri : undefined;
}

function uiDataCarriesResource(uiData: JsonValue | undefined): boolean {
  if (!isJsonObject(uiData)) return false;
  return isResourcePayload(uiData) || isResourcePayload(uiData.resource);
}

function providerRawCarriesUiResource(raw: JsonValue | undefined): boolean {
  if (!isJsonObject(raw)) return false;
  const candidate = raw.resource !== undefined ? raw.resource : raw;
  if (!isResourcePayload(candidate)) return false;
  return resourceUri(candidate)?.startsWith("ui://") === true;
}

export function uiCardArtifactsFromMessages(messages: AgMessage[]): AgArtifact[] {
  const artifacts: AgArtifact[] = [];
  for (const msg of messages) {
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i]!;
      if (block.type !== "tool-result") continue;
      const carriesUi =
        uiDataCarriesResource(block.uiData) ||
        block.content.some(
          (part) => part.type === "provider-raw" && providerRawCarriesUiResource(part.raw),
        );
      if (!carriesUi) continue;
      artifacts.push({
        artifactId: `${msg.id}#ui#${i}`,
        turnId: msg.turnId ?? "",
        threadId: msg.threadId ?? "",
        parts: [block],
      });
    }
  }
  return artifacts;
}

export function agArtifactToCardRow(art: AgArtifact, ctx: RowCtx): ThreadMessageRow {
  return {
    threadId: ctx.threadId,
    seq: ctx.seq,
    userId: ctx.userId,
    clientMessageId: ctx.clientMessageId,
    at: ctx.at,
    kind: "card",
    authorRole: "agent",
    content: { producedInTurnId: art.turnId },
    cardSnapshot: art,
  };
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
