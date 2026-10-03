/**
 * guuey#2120 — the thread snapshot is planned against the store's
 * {@link RowBudget} before a turn writes any row, the way guuey#1794 plans the
 * rows. A snapshot carrying a value its store cannot hold used to fail
 * `putSnapshot` AFTER the rows were written: the turn's sentinel was already
 * claimed, so the snapshot was never retried, and a `workingState` value the
 * next turn re-wrote failed every later snapshot too.
 *
 * The plan never fails. What cannot be stored is left out, and said so:
 *
 * - a `workingState` carrying a number the store cannot hold is refused as
 *   one update: the snapshot keeps the state the turn was seeded with;
 * - a thread-memory element carrying such a number is left out;
 * - over the size budget, the turn's working state is refused first (it is
 *   one opaque blob) when the seeded state is smaller, so the swap shrinks
 *   the row; then the thread-memory records this turn wrote or
 *   changed are left out, largest first. A record stored unchanged from the
 *   prior snapshot, and every carried element, stays: they were stored before.
 * - a snapshot that still does not fit is not written; the prior one stands.
 *
 * Pure: no I/O. Counts only in the report, never a value.
 */
import type { AgMemoryRecord, JsonValue } from "@silverprotocol/core";
import { carriesUnfitNumber, jsonEqual } from "./fold-rows.js";
import type { RowBudget, ThreadSnapshotRow } from "./rows.js";

/** Why part of a snapshot was not stored: a number its store cannot hold, or its size. */
export type SnapshotRefusalReason = "number" | "size";

/** What a planned snapshot left out (guuey#2120). Counts only. */
export interface SnapshotRefusal {
  /**
   * The turn's working state was not stored, and why. The snapshot keeps the
   * state the turn was seeded with ({@link PlanSnapshotInput.priorWorkingState}),
   * or none when it had none.
   */
  state?: SnapshotRefusalReason;
  /** Thread-memory elements left out because they carried a number the store cannot hold. */
  memoryNumber: number;
  /** Thread-memory records this turn wrote, left out so the snapshot fits. */
  memorySize: number;
  /** True when the snapshot could not fit even so and is not written: the prior snapshot stands. */
  notWritten: boolean;
}

export interface PlanSnapshotInput {
  /** The snapshot the turn would write. */
  row: ThreadSnapshotRow;
  /** The working state the turn was seeded with; absent = none. */
  priorWorkingState?: JsonValue;
  /** The thread records the turn was seeded with (`keepUnchangedThreadMemory` keeps an unchanged one by identity). */
  priorThreadMemory?: readonly AgMemoryRecord[];
}

export interface PlannedSnapshot {
  /** The snapshot to write, or `undefined` when it cannot be stored at all. */
  row: ThreadSnapshotRow | undefined;
  /** Set when anything was left out. */
  refusal?: SnapshotRefusal;
}

/** `row` with `workingState` set to `state`, or without it when `state` is undefined. */
function withState(row: ThreadSnapshotRow, state: JsonValue | undefined): ThreadSnapshotRow {
  const { workingState: _dropped, ...rest } = row;
  return state === undefined ? rest : { ...rest, workingState: state };
}

/**
 * Plan `input.row` under `budget` (see the module comment). Without a budget
 * the row is returned as it is.
 */
export function planSnapshot(input: PlanSnapshotInput, budget: RowBudget | undefined): PlannedSnapshot {
  if (budget === undefined) return { row: input.row };
  const fits = budget.numberFits;
  const unfit = (value: unknown): boolean => fits !== undefined && carriesUnfitNumber(value, fits);
  // The seeded state was read back from the store, so it can be stored; the
  // check only keeps a binding that held an unfit one from writing it again.
  const prior = unfit(input.priorWorkingState) ? undefined : input.priorWorkingState;

  let state: SnapshotRefusalReason | undefined;
  let row = input.row;
  if (row.workingState !== undefined && unfit(row.workingState)) {
    state = "number";
    row = withState(row, prior);
  }

  let memoryNumber = 0;
  const threadMemory = row.threadMemory.filter((rec) => {
    if (!unfit(rec)) return true;
    memoryNumber++;
    return false;
  });
  const carried = (row.carriedThreadMemory ?? []).filter((el) => {
    if (!unfit(el)) return true;
    memoryNumber++;
    return false;
  });
  const { carriedThreadMemory: _carried, ...rest } = row;
  row = { ...rest, threadMemory, ...(carried.length > 0 ? { carriedThreadMemory: carried } : {}) };

  let memorySize = 0;
  if (budget.bytesOf(row) > budget.maxBytes && state === undefined && !jsonEqual(row.workingState, prior)) {
    // Only a swap that shrinks the row: a prior state larger than this turn's
    // would grow it, drop more records than needed and lose a state that fits.
    const swapped = withState(row, prior);
    if (budget.bytesOf(swapped) < budget.bytesOf(row)) {
      state = "size";
      row = swapped;
    }
  }
  if (budget.bytesOf(row) > budget.maxBytes) {
    const seeded = new Set(input.priorThreadMemory ?? []);
    const written = row.threadMemory
      .filter((rec) => !seeded.has(rec))
      .map((rec) => ({ rec, bytes: budget.bytesOf({ threadId: "", userId: "", updatedAt: "", threadMemory: [rec] }) }))
      .sort((a, b) => b.bytes - a.bytes);
    for (const { rec } of written) {
      memorySize++;
      row = { ...row, threadMemory: row.threadMemory.filter((r) => r !== rec) };
      if (budget.bytesOf(row) <= budget.maxBytes) break;
    }
  }

  const notWritten = budget.bytesOf(row) > budget.maxBytes;
  const refused = state !== undefined || memoryNumber > 0 || memorySize > 0 || notWritten;
  return {
    row: notWritten ? undefined : row,
    ...(refused
      ? { refusal: { ...(state !== undefined ? { state } : {}), memoryNumber, memorySize, notWritten } }
      : {}),
  };
}
