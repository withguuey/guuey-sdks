/**
 * The tap ledger (guuey#2031) — headless, no React: one entry per card tap a
 * host relays, so the tap draws at once as the visitor's action turn, in the
 * tapped control's own words when the host holds them, and is replaced in
 * place by the turn its doorbell sends.
 *
 * The life of an entry:
 *
 *  1. **begun** in the task that receives the relayed `tools/call`
 *     ({@link TapLedger.wrapCallTool}): the tap is read and its words
 *     resolved. An idle host draws it there, before the relay's fetch settles.
 *     While the host's turn is live ({@link TapLedgerOptions.deferDraw}: a
 *     listen that drains the tap, or no thread for the relay yet) the entry is
 *     held undrawn, so a tap the runtime will not ring for never flashes for
 *     one relay round trip. A relay that has not answered within
 *     {@link TAP_RELAY_GRACE_MS} withdraws it;
 *  2. **enqueued** — the relay's answer is read with the runtime classifier's
 *     mirror (`submitActionOutcome`); an answer the runtime will not ring for
 *     withdraws the entry (the card shows its own notice), and an enqueued one
 *     is drawn if it was held and waits for its doorbell, at most
 *     {@link TAP_DOORBELL_GRACE_MS};
 *  3. **claimed** by the doorbell that names its `actionId`
 *     ({@link TapLedger.claimDoorbell}); still drawn while it waits behind a
 *     live turn;
 *  4. **sent** with its id as the turn's `clientMessageId`
 *     ({@link TapLedger.markSent}; several taps merged into one send become
 *     one entry under the first id, their words in order) and **confirmed**
 *     when a committed message carries that id ({@link TapLedger.reconcile}).
 *     A commit that changed the messages without it, or no commit within
 *     {@link TAP_SENT_GRACE_MS}, withdraws the entry: the send refused, or an
 *     agent client ignored the send options.
 *
 * Every other ending is a withdrawal with a counts-only reason. A reload
 * between the tap and the send loses the entry: the client writes no row of
 * its own, and the gesture stays on the runtime's pipe. {@link TapLedger.dispose}
 * is terminal: nothing the ledger holds fires after it.
 */
import {
  readSubmitActionTap,
  readUserActionMeta,
  submitActionOutcome,
  type McpToolCallResult,
  type TapLabels,
  type UiActionRequest,
} from "@guuey/mcp-apps-host";
import type { PendingTap, TapWithdrawReason } from "./types.js";

export type { TapWithdrawReason } from "./types.js";

/**
 * How long an enqueued tap waits for its doorbell. The card's runtime rings in
 * the same task that reads the relay's answer, so this never races a real
 * doorbell; it bounds a runtime that stops ringing, a relay latch, or a mount
 * superseded mid-tap.
 */
export const TAP_DOORBELL_GRACE_MS = 5_000;

/**
 * How long a sent tap waits for a committed message carrying its id when the
 * messages never change at all (a send the hook refused).
 */
export const TAP_SENT_GRACE_MS = 5_000;

/**
 * How long a tap waits for its relay's answer. A healthy relay answers in a
 * round trip to the action door; this bounds a hung one (the card's own
 * request gives up far later), so no drawn tap outlives a relay that never
 * answers. A later answer changes nothing: the entry is gone, and its
 * doorbell, if one still rings, sends a plain continuation turn.
 */
export const TAP_RELAY_GRACE_MS = 10_000;

/** A claimed or sent tap: the id its send carries, and its words in tap order. */
export interface ClaimedTap {
  readonly id: string;
  readonly labels: TapLabels;
}

/** The slice of a transcript message the ledger reads: its `clientMessageId`. */
export interface TapLedgerMessage {
  readonly clientMessageId?: string;
}

export interface TapLedgerOptions {
  /**
   * Mint the id a tap's send will carry (`useAgentInvoke`'s
   * `newClientMessageId`). `undefined`: the host cannot name a turn before it
   * sends it, so the tap is relayed untouched and nothing is drawn.
   */
  newId: () => string | undefined;
  /**
   * The tapped control's words, or `null` (the continuation copy) —
   * `resolveTapLabel` over the host's live state, read at call time.
   * `boundSessionId` is the render session the host bound the mount to, when
   * it owns one.
   */
  resolveLabel: (request: UiActionRequest, boundSessionId: string | undefined) => string | null;
  /**
   * Read at tap time. `true` while the host's turn is live (a `ggui_consume`
   * listen included) or it has no thread for the relay yet: then the relay's
   * answer is likely not to ring (a live listen drains the tap; a relay with no
   * thread answers unavailable), so the entry is drawn only once the answer
   * classifies it enqueued, or its doorbell claims it. Absent: always drawn at
   * once.
   */
  deferDraw?: () => boolean;
  /** The pending set changed: re-read {@link TapLedger.pendingTaps}. */
  onChange: () => void;
  /** An entry closed without becoming a turn (counts-only: the reason, never the words). */
  onWithdraw?: (reason: TapWithdrawReason) => void;
}

export interface TapLedger {
  /**
   * Wrap a host's `tools/call` relay: a card tap begins an entry in the same
   * task, before the relay is called; the relay's answer is returned
   * untouched and its rejection still rejects. Any other call passes through.
   */
  wrapCallTool(
    relay: (request: UiActionRequest) => Promise<McpToolCallResult>,
    options?: { boundSessionId?: string },
  ): (request: UiActionRequest) => Promise<McpToolCallResult>;
  /**
   * The entry a `ui/message` doorbell stands for, joined on the `actionId`
   * (and render session) its structured mirror names, or `null`: a doorbell
   * with no mirror, or one no waiting entry matches, claims nothing.
   */
  claimDoorbell(params: { readonly [key: string]: unknown }): ClaimedTap | null;
  /**
   * The claimed taps `ids` were sent as ONE turn: they become one entry under
   * the first id with every tap's words in order. `messagesAtSend` is the
   * host's committed messages as they stood at the send. Returns that entry,
   * or `null` when none of the ids is waiting.
   */
  markSent(ids: readonly string[], messagesAtSend: readonly TapLedgerMessage[]): ClaimedTap | null;
  /** After a commit: confirm the sent entries its messages carry, withdraw those a changed set lacks. */
  reconcile(messages: readonly TapLedgerMessage[]): void;
  /** Close one entry without a turn (the host's own refusal). */
  withdraw(id: string, reason: TapWithdrawReason): void;
  /** Every entry not yet confirmed or withdrawn, in tap order (the planner's `pendingTaps`). */
  pendingTaps(): readonly PendingTap[];
  /** Drop every entry and timer (a cleared conversation holds nothing). */
  reset(): void;
  /**
   * Terminal (the host is going away): every timer stops, and no change
   * notice, withdrawal or timer follows, whatever a relay answers later. A
   * disposed ledger relays every call untouched, claims no doorbell and marks
   * no send.
   */
  dispose(): void;
}

type Phase = "relaying" | "awaiting-doorbell" | "claimed" | "sent";

interface Entry {
  id: string;
  actionId: string;
  renderSessionId: string;
  labels: TapLabels;
  phase: Phase;
  /** Whether the planner sees it. A held entry (see `deferDraw`) is drawn when its relay says the runtime will ring. */
  drawn: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  messagesAtSend: readonly TapLedgerMessage[] | undefined;
}

/** The same drawn set: the same ids with the same word lists, in the same order. */
function samePending(a: readonly PendingTap[], b: readonly PendingTap[]): boolean {
  return a.length === b.length && a.every((tap, i) => tap.id === b[i]?.id && tap.labels === b[i]?.labels);
}

export function createTapLedger(options: TapLedgerOptions): TapLedger {
  let entries: Entry[] = [];
  let pending: readonly PendingTap[] = [];
  let disposed = false;

  /** Recompute the drawn set; tell the host only when it changed. */
  const publish = (): void => {
    if (disposed) return;
    const next = entries.filter((e) => e.drawn).map((e) => ({ id: e.id, labels: e.labels }));
    if (samePending(next, pending)) return;
    pending = next;
    options.onChange();
  };
  const find = (id: string): Entry | undefined => entries.find((e) => e.id === id);
  const stopTimer = (entry: Entry): void => {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
  };
  const remove = (entry: Entry): void => {
    stopTimer(entry);
    entries = entries.filter((e) => e !== entry);
  };
  const withdrawEntry = (entry: Entry, reason: TapWithdrawReason): void => {
    remove(entry);
    publish();
    options.onWithdraw?.(reason);
  };
  const arm = (entry: Entry, ms: number, reason: TapWithdrawReason): void => {
    stopTimer(entry);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (!disposed && find(entry.id) === entry) withdrawEntry(entry, reason);
    }, ms);
  };
  /** Waiting in the relay's own phase: the one phase a relay's answer or rejection may close. */
  const stillRelaying = (entry: Entry): boolean => !disposed && find(entry.id) === entry && entry.phase === "relaying";

  const settleRelay = (entry: Entry, result: McpToolCallResult): void => {
    if (!stillRelaying(entry)) return; // withdrawn, reset, disposed, or already claimed
    const outcome = submitActionOutcome(result);
    if (outcome !== "enqueued") {
      withdrawEntry(entry, outcome);
      return;
    }
    entry.phase = "awaiting-doorbell";
    entry.drawn = true;
    arm(entry, TAP_DOORBELL_GRACE_MS, "no-doorbell");
    publish();
  };

  return {
    wrapCallTool(relay, wrapOptions) {
      const boundSessionId = wrapOptions?.boundSessionId;
      return (request) => {
        if (disposed) return relay(request);
        const tap = readSubmitActionTap(request);
        if (tap === null) return relay(request);
        const id = options.newId();
        if (id === undefined) return relay(request);
        const entry: Entry = {
          id,
          actionId: tap.actionId,
          renderSessionId: tap.renderSessionId,
          labels: [options.resolveLabel(request, boundSessionId)],
          phase: "relaying",
          drawn: options.deferDraw?.() !== true,
          timer: undefined,
          messagesAtSend: undefined,
        };
        entries = [...entries, entry];
        arm(entry, TAP_RELAY_GRACE_MS, "relay-timeout");
        publish();
        return relay(request).then(
          (result) => {
            settleRelay(entry, result);
            return result;
          },
          (error: unknown) => {
            if (stillRelaying(entry)) withdrawEntry(entry, "relay-failed");
            return Promise.reject(error);
          },
        );
      };
    },

    claimDoorbell(params) {
      if (disposed) return null;
      const meta = readUserActionMeta(params);
      if (meta === null) return null;
      const entry = entries.find(
        (e) =>
          e.actionId === meta.actionId &&
          e.renderSessionId === meta.sessionId &&
          (e.phase === "relaying" || e.phase === "awaiting-doorbell"),
      );
      if (entry === undefined) return null;
      stopTimer(entry);
      entry.phase = "claimed";
      // A doorbell is the runtime ringing: a held entry is drawn now.
      entry.drawn = true;
      publish();
      return { id: entry.id, labels: entry.labels };
    },

    markSent(ids, messagesAtSend) {
      if (disposed) return null;
      const group = ids.flatMap((id) => {
        const entry = find(id);
        return entry !== undefined && entry.phase === "claimed" ? [entry] : [];
      });
      const [head, ...rest] = group;
      if (head === undefined) return null;
      for (const entry of rest) remove(entry);
      head.labels = group.flatMap((e) => e.labels);
      head.phase = "sent";
      head.messagesAtSend = messagesAtSend;
      arm(head, TAP_SENT_GRACE_MS, "not-sent");
      publish();
      return { id: head.id, labels: head.labels };
    },

    reconcile(messages) {
      if (disposed) return;
      const sent = entries.filter((e) => e.phase === "sent");
      if (sent.length === 0) return;
      const present = new Set<string>();
      for (const m of messages) if (m.clientMessageId !== undefined) present.add(m.clientMessageId);
      let changed = false;
      const withdrawn: TapWithdrawReason[] = [];
      for (const entry of sent) {
        if (present.has(entry.id)) {
          remove(entry);
          changed = true;
        } else if (messages !== entry.messagesAtSend) {
          remove(entry);
          changed = true;
          withdrawn.push("not-sent");
        }
      }
      if (changed) publish();
      for (const reason of withdrawn) options.onWithdraw?.(reason);
    },

    withdraw(id, reason) {
      if (disposed) return;
      const entry = find(id);
      if (entry !== undefined) withdrawEntry(entry, reason);
    },

    pendingTaps() {
      return pending;
    },

    reset() {
      for (const entry of entries) stopTimer(entry);
      entries = [];
      publish();
    },

    dispose() {
      disposed = true;
      for (const entry of entries) stopTimer(entry);
      entries = [];
    },
  };
}
