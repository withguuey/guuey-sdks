/**
 * Sealed conversations: how a reader tells which messages of a thread the
 * app's operator may not read.
 *
 * A thread may carry seal intervals ({@link ThreadRow.sealIntervals}). Each
 * one covers the messages from `fromSeq` to `toSeq`, both inclusive; an
 * interval without `toSeq` is still open, so it also covers every message
 * written after it. The writer records the intervals in the same atomic
 * update that allocates a message's seq, so a boundary always falls between
 * two messages.
 *
 * The rules every reader applies:
 *
 *   - no `sealIntervals` attribute: a legacy thread, wholly readable;
 *   - a well-formed list: a message is sealed when any interval covers its seq;
 *   - an attribute that is present but not a well-formed list: the reader
 *     cannot tell which messages it covers, so the WHOLE thread reads as
 *     sealed (fail closed, never open).
 *
 * The functions here are pure. They take the stored attribute as it came off
 * the row, so a reader never trusts a shape it did not check.
 */
import { createHash } from "node:crypto";
import type { SealInterval, ThreadRow } from "./rows.js";

/** A thread's seal state as a reader sees it, after the stored attribute was checked. */
export type ThreadSealState =
  /** No seal record: a legacy thread, wholly readable. */
  | { kind: "none" }
  /** A well-formed record: these intervals (possibly empty) decide each message. */
  | { kind: "intervals"; intervals: readonly SealInterval[] }
  /** A record that is present but malformed: every message reads as sealed. */
  | { kind: "unreadable" };

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function readInterval(value: unknown): SealInterval | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!("fromSeq" in value)) return undefined;
  const fromSeq = value.fromSeq;
  if (!isSeq(fromSeq)) return undefined;
  const toSeq = "toSeq" in value ? value.toSeq : undefined;
  if (toSeq === undefined) return { fromSeq };
  if (!isSeq(toSeq) || toSeq < fromSeq) return undefined;
  return { fromSeq, toSeq };
}

/**
 * Check a stored `sealIntervals` attribute. Absent (`undefined` or `null`) is
 * a legacy thread; anything else must be an array of well-formed intervals,
 * or the whole thread reads as sealed.
 */
export function readSealState(stored: unknown): ThreadSealState {
  if (stored === undefined || stored === null) return { kind: "none" };
  if (!Array.isArray(stored)) return { kind: "unreadable" };
  const intervals: SealInterval[] = [];
  for (const entry of stored) {
    const interval = readInterval(entry);
    if (interval === undefined) return { kind: "unreadable" };
    intervals.push(interval);
  }
  return { kind: "intervals", intervals };
}

/** Whether the message at `seq` is sealed under `state`. */
export function isSeqSealed(state: ThreadSealState, seq: number): boolean {
  if (state.kind === "none") return false;
  if (state.kind === "unreadable") return true;
  return state.intervals.some(
    (interval) => seq >= interval.fromSeq && (interval.toSeq === undefined || seq <= interval.toSeq),
  );
}

/**
 * Whether ANY part of the thread is, or was, sealed. A copy built from the
 * whole conversation (a model-written summary, a report) is refused when this
 * is true, since it may carry sealed messages whatever message triggered it.
 */
export function hasSealedPart(state: ThreadSealState): boolean {
  if (state.kind === "none") return false;
  if (state.kind === "unreadable") return true;
  return state.intervals.length > 0;
}

/**
 * The digest a writer stores beside a preview (`lastMessagePreviewDigest`), in
 * the same update that sets the preview and its source seq. It binds the seq to
 * the text: a writer that replaces the preview without stamping its seq (one
 * from before the stamp) leaves a digest that no longer matches, so a reader
 * cannot mistake the old seq for the new text's source.
 */
export function previewDigest(preview: string): string {
  return createHash("sha256").update(preview, "utf8").digest("hex").slice(0, 32);
}

/** The thread-row slice {@link readableThreadPreview} reads, as stored. */
export interface StoredPreviewSlice {
  lastMessagePreview?: string;
  /** The seq of the message the preview was taken from; absent on rows a writer before it wrote. */
  lastMessagePreviewSeq?: unknown;
  /** {@link previewDigest} of the preview the seq was stamped with; absent on rows a writer before it wrote. */
  lastMessagePreviewDigest?: unknown;
  sealIntervals?: unknown;
}

/**
 * The preview an operator-side reader may show: the stored preview, or `''`
 * when the message it was taken from is sealed. On a thread with any sealed
 * part, a preview whose source the reader cannot place is withheld too: no
 * recorded seq, or a digest absent or not matching the stored text (an older
 * writer replaced the text and left the previous seq beside it). A thread with
 * no sealed part shows its preview as stored.
 *
 * One case reads as placed though it is not: an older writer that stored the
 * very same text again. The text is then that of the stamped, readable
 * message, so nothing new is shown.
 */
export function readableThreadPreview(row: StoredPreviewSlice): string {
  const preview = row.lastMessagePreview ?? "";
  if (preview.length === 0) return "";
  const state = readSealState(row.sealIntervals);
  if (!hasSealedPart(state)) return preview;
  const source = row.lastMessagePreviewSeq;
  if (!isSeq(source)) return "";
  if (row.lastMessagePreviewDigest !== previewDigest(preview)) return "";
  return isSeqSealed(state, source) ? "" : preview;
}

/** {@link readSealState} over a typed {@link ThreadRow}. */
export function threadSealState(row: Pick<ThreadRow, "sealIntervals">): ThreadSealState {
  return readSealState(row.sealIntervals);
}
