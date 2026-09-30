/**
 * `useTapEcho` (guuey#2031) — the React owner of a {@link TapLedger}: a card
 * tap draws at once as the visitor's action turn, and the doorbell's send
 * replaces it in place.
 *
 * One hook for every host that sinks `ui/message` itself (the kit's
 * `<GuueyChat>` and the widget page both do), so the two doorbell sinks never
 * grow two ledgers. The host:
 *
 *  - wraps its `tools/call` relay with {@link TapEcho.wrapCallTool} (the
 *    wrapper reads the live fold and the mounted cards through refs at CALL
 *    time — a view captures its `onCallTool` when it attaches);
 *  - in its `ui/message` sink, claims the doorbell's tap
 *    ({@link TapEcho.claimDoorbell}), sends with `{ clientMessageId, tapLabels }`
 *    and reports the send ({@link TapEcho.markSent}), or withdraws the tap
 *    when it cannot send;
 *  - hands {@link TapEcho.pendingTaps} to the planner as
 *    `TranscriptInputs.pendingTaps`.
 *
 * After each commit of the invoke's messages the ledger reconciles its sent
 * taps: confirmed by a message carrying the id, withdrawn when the messages
 * changed without it.
 *
 * While a turn is in flight (a `ggui_consume` listen included) or there is no
 * thread yet, a tap is drawn only once its relay says the runtime will ring
 * (the ledger's `deferDraw`), so a tap a live listen drains never flashes.
 *
 * The ledger lives as long as the effect that owns it: disposing one is
 * terminal, so a remount (StrictMode's simulated one included) makes a fresh
 * ledger, and every function this hook returns reaches the CURRENT ledger at
 * call time, so a view that captured them on attach keeps working.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgReduceResult } from "@silverprotocol/core";
import type { UseAgentInvokeReturn } from "@guuey/agent-client";
import { resolveTapLabel, type MountedCardProps, type PaintPart } from "@guuey/mcp-apps-host";
import { createTapLedger, type ClaimedTap, type TapLedger } from "../tap-ledger.js";
import type { PendingTap, TapWithdrawReason } from "../types.js";

export interface UseTapEchoArgs {
  /**
   * The live invoke: its committed messages, its id minter, its live fold, and
   * its turn state and thread (read at tap time for the deferred draw).
   */
  invoke: Pick<UseAgentInvokeReturn, "messages" | "newClientMessageId" | "reduceResult" | "status" | "threadId">;
  /**
   * A mounted card's own props, by render session (`mountedCardProps` over
   * the host's mounts) — the base for a tap on a card whose paints are not in
   * the live fold (a card painted before a reload). Read at tap time.
   */
  mountedFor?: (renderSessionId: string) => MountedCardProps | undefined;
  /** A pending tap closed without a turn — counts-only (the reason, never the words). */
  onWithdraw?: (reason: TapWithdrawReason) => void;
}

export interface TapEcho {
  /** See {@link TapLedger.wrapCallTool}. A stable function for the hook's life; the wrapper reaches the current ledger per call. */
  wrapCallTool: TapLedger["wrapCallTool"];
  /** See {@link TapLedger.claimDoorbell}. */
  claimDoorbell: TapLedger["claimDoorbell"];
  /**
   * The claimed taps `ids` are being sent as ONE turn (see
   * {@link TapLedger.markSent}): call it BEFORE the send, and send with what it
   * returns (its id as the `clientMessageId`, its words as the `tapLabels`),
   * so the send and the ledger's head are one source. `null`: none of the ids
   * is waiting, so the send carries neither.
   */
  markSent: (ids: readonly string[]) => ClaimedTap | null;
  /** See {@link TapLedger.withdraw}. */
  withdraw: TapLedger["withdraw"];
  /** See {@link TapLedger.reset}. */
  reset: TapLedger["reset"];
  /** The planner input: every tap not yet confirmed or withdrawn, in tap order. */
  pendingTaps: readonly PendingTap[];
}

/** The live fold's parts in transcript order — the shape the one paint reducer reads. */
function foldParts(result: AgReduceResult | null): readonly PaintPart[] {
  return result === null ? [] : result.messages.flatMap((m) => m.content);
}

export function useTapEcho({ invoke, mountedFor, onWithdraw }: UseTapEchoArgs): TapEcho {
  // Live reads (the ledger's callbacks run long after this render): the
  // latest invoke, mounted-card lookup and debug sink, through refs.
  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;
  const mountedForRef = useRef(mountedFor);
  mountedForRef.current = mountedFor;
  const onWithdrawRef = useRef(onWithdraw);
  onWithdrawRef.current = onWithdraw;

  const [pendingTaps, setPendingTaps] = useState<readonly PendingTap[]>([]);
  const createLedger = useCallback((): TapLedger => {
    const ledger: TapLedger = createTapLedger({
      newId: () => invokeRef.current.newClientMessageId(),
      resolveLabel: (request, boundSessionId) => {
        const lookup = mountedForRef.current;
        return resolveTapLabel({
          request,
          parts: foldParts(invokeRef.current.reduceResult),
          ...(boundSessionId !== undefined ? { boundSessionId } : {}),
          ...(lookup !== undefined ? { mountedFor: lookup } : {}),
        });
      },
      deferDraw: () => invokeRef.current.status !== "ready" || invokeRef.current.threadId === null,
      onChange: () => setPendingTaps(ledger.pendingTaps()),
      onWithdraw: (reason) => onWithdrawRef.current?.(reason),
    });
    return ledger;
  }, []);
  // Made during the first render, so the wrapped relay works from the first
  // mount; afterwards the effect below owns the ledger's life.
  const ledgerRef = useRef<TapLedger | null>(null);
  if (ledgerRef.current === null) ledgerRef.current = createLedger();

  useEffect(() => {
    ledgerRef.current ??= createLedger();
    const ledger = ledgerRef.current;
    return () => {
      ledger.dispose();
      if (ledgerRef.current === ledger) ledgerRef.current = null;
    };
  }, [createLedger]);
  // Each commit of the messages: confirm a sent tap its row now carries, or
  // withdraw one the changed messages lack.
  useEffect(() => {
    ledgerRef.current?.reconcile(invoke.messages);
  }, [invoke.messages]);

  // Stable for the hook's life, each reading the current ledger at call time.
  const wrapCallTool = useCallback<TapLedger["wrapCallTool"]>(
    (relay, options) => (request) => {
      const ledger = ledgerRef.current;
      return ledger === null ? relay(request) : ledger.wrapCallTool(relay, options)(request);
    },
    [],
  );
  const claimDoorbell = useCallback<TapLedger["claimDoorbell"]>((params) => ledgerRef.current?.claimDoorbell(params) ?? null, []);
  const markSent = useCallback(
    (ids: readonly string[]): ClaimedTap | null => ledgerRef.current?.markSent(ids, invokeRef.current.messages) ?? null,
    [],
  );
  const withdraw = useCallback<TapLedger["withdraw"]>((id, reason) => ledgerRef.current?.withdraw(id, reason), []);
  const reset = useCallback<TapLedger["reset"]>(() => ledgerRef.current?.reset(), []);

  return useMemo(
    () => ({ wrapCallTool, claimDoorbell, markSent, withdraw, reset, pendingTaps }),
    [wrapCallTool, claimDoorbell, markSent, withdraw, reset, pendingTaps],
  );
}
