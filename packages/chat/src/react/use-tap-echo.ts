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
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgReduceResult } from "@silverprotocol/core";
import type { UseAgentInvokeReturn } from "@guuey/agent-client";
import { resolveTapLabel, type MountedCardProps, type PaintPart } from "@guuey/mcp-apps-host";
import { createTapLedger, type ClaimedTap, type TapLedger } from "../tap-ledger.js";
import type { PendingTap, TapWithdrawReason } from "../types.js";

export interface UseTapEchoArgs {
  /** The live invoke: its committed messages, its id minter, its live fold. */
  invoke: Pick<UseAgentInvokeReturn, "messages" | "newClientMessageId" | "reduceResult">;
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
  /** See {@link TapLedger.wrapCallTool}. A stable function for the hook's life. */
  wrapCallTool: TapLedger["wrapCallTool"];
  /** See {@link TapLedger.claimDoorbell}. */
  claimDoorbell: TapLedger["claimDoorbell"];
  /** The claimed taps `ids` were sent as ONE turn, just now (see {@link TapLedger.markSent}). */
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
  const ledgerRef = useRef<TapLedger | null>(null);
  if (ledgerRef.current === null) {
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
      onChange: () => setPendingTaps(ledger.pendingTaps()),
      onWithdraw: (reason) => onWithdrawRef.current?.(reason),
    });
    ledgerRef.current = ledger;
  }
  const ledger = ledgerRef.current;

  // Each commit of the messages: confirm a sent tap its row now carries, or
  // withdraw one the changed messages lack.
  useEffect(() => {
    ledger.reconcile(invoke.messages);
  }, [ledger, invoke.messages]);
  useEffect(() => () => ledger.dispose(), [ledger]);

  return useMemo(
    () => ({
      wrapCallTool: ledger.wrapCallTool,
      claimDoorbell: ledger.claimDoorbell,
      markSent: (ids: readonly string[]) => ledger.markSent(ids, invokeRef.current.messages),
      withdraw: ledger.withdraw,
      reset: ledger.reset,
      pendingTaps,
    }),
    [ledger, pendingTaps],
  );
}
