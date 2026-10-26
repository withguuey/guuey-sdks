/**
 * Thread titles (guuey#2612):
 * the ONE reader every surface reads a stored title through, the ONE write
 * vocabulary every binding implements, and the per-thread bounds.
 *
 * A thread's title has a source:
 *   - `default`: the constant a new thread is minted with ({@link DEFAULT_THREAD_TITLE});
 *   - `generated`: written after a turn by the platform's titler;
 *   - `set`: written by the app (or the person, through the app). A set title
 *     wins and stays; unpinning it returns to the last generated title.
 *
 * Every write is one value of {@link TitleWrite}, applied by a binding's
 * optional `writeTitle` as ONE conditional update (`rows.ts`). The claim takes
 * a checkpoint before any model call, so a claimed checkpoint gets at most one
 * call, whatever its outcome and however many writers race, and a record
 * consumes its claim, so one claim yields at most one generated title.
 */
import { hasSealedPart, readSealState } from "./seal.js";

/** The title a thread is minted with. Never sent on an end-user wire (the reader answers `null`). */
export const DEFAULT_THREAD_TITLE = "New thread";

export type ThreadTitleSource = "default" | "generated" | "set";

/** A stored title as a reader may show it. */
export interface ThreadTitleView {
  /** `null` for a default title, and for an operator reading a thread with a sealed part. */
  title: string | null;
  source: ThreadTitleSource;
  /** When the title last changed (ISO), or `null` when no title write ever happened. */
  updatedAt: string | null;
}

/**
 * Who reads: `owner` = the thread's person (and their client);
 * `operator` = the app's builder console.
 */
export type ThreadTitleAudience = "owner" | "operator";

/** The thread-row slice {@link readThreadTitle} reads, as stored (never trusted). */
export interface TitleSlice {
  title?: unknown;
  titleSource?: unknown;
  titleUpdatedAt?: unknown;
  sealIntervals?: unknown;
}

/**
 * A stored `titleSource` read leniently (stored data is a wire too): absent,
 * `null` or any value this release does not know (a later writer's) reads as
 * `default`. Stored as a plain string, not an enum, so an unknown value never
 * breaks an older read of the whole item.
 */
export function readThreadTitleSource(stored: unknown): ThreadTitleSource {
  return stored === "generated" || stored === "set" ? stored : "default";
}

/**
 * The title a reader may show. A default title reads as `null`, so a client
 * applies its own fallback in its own language. An operator reading a thread
 * with any sealed part gets `null` for a generated and a set title alike: a
 * title is a copy built from the whole conversation, and that rule
 * (`hasSealedPart`, `seal.ts`) already refuses such copies.
 */
export function readThreadTitle(row: TitleSlice, audience: ThreadTitleAudience): ThreadTitleView {
  const source = readThreadTitleSource(row.titleSource);
  const updatedAt = typeof row.titleUpdatedAt === "string" ? row.titleUpdatedAt : null;
  if (source === "default") return { title: null, source, updatedAt };
  if (audience === "operator" && hasSealedPart(readSealState(row.sealIntervals))) {
    return { title: null, source, updatedAt };
  }
  return { title: typeof row.title === "string" ? row.title : null, source, updatedAt };
}

/** Model calls a thread may claim in its lifetime, whatever their outcome. */
export const TITLE_MAX_ATTEMPTS = 6;
/** Generated titles a thread may get in its lifetime. */
export const TITLE_MAX_GENERATIONS = 3;
/** The message seqs at which a thread is due a (re)title. */
export const TITLE_CHECKPOINTS = [2, 8, 20, 50] as const;

/**
 * The spend label a titling model call carries (guuey#2612): the titler
 * (a later leg) mints its egress token with this `usageReason`, and
 * the usage row of the call carries it as `metadata.usageReason`, so title
 * spend is told from turn spend by this field, never by parsing a session id.
 * Absent on a row means a turn. Named here so the titler and every reader
 * share one spelling.
 */
export const THREAD_TITLE_USAGE_REASON = "thread-title";

/**
 * One title write — the whole vocabulary of `writeTitle` (`rows.ts`).
 *
 * - `claim`: take `checkpoint` and spend one attempt, before any model call.
 *   Written only while the source is default or generated, the checkpoint is
 *   above the last one claimed, both caps have room, and the thread is neither
 *   sealed nor being erased.
 * - `record`: store a generated title for the claim at `checkpoint`. Written
 *   only while the stored claim is at that checkpoint (no claim at a later
 *   one, no unpin that cleared it), not yet consumed by an earlier record, and
 *   the claim's other conditions still hold. A record names a checkpoint, not
 *   a claimant: when an unpin cleared the claim and a new claim took the same
 *   checkpoint again, the first record for it to land (the earlier call's
 *   included) is the one generation, and the other refuses. The attempts and
 *   generations caps bound every case. `language` is the locale hint
 *   used; absent leaves the stored one as it was.
 * - `set`: the thread's owner sets (`title` a string) or unpins (`null`) the
 *   title, while the thread is not being erased. Unpinning restores the last
 *   generated title, or the default when there is none (and then the next
 *   turn may generate again).
 */
export type TitleWrite =
  | { kind: "claim"; checkpoint: number; at: string }
  | { kind: "record"; checkpoint: number; title: string; sourceSeq: number; language?: string; at: string }
  | { kind: "set"; userId: string; title: string | null; at: string };

/** A binding's answer: the conditional write held (`written`) or did not (`refused`, nothing changed). */
export type TitleWriteResult = "written" | "refused";

