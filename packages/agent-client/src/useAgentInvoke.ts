/**
 * useAgentInvoke — the base-platform chat client.
 *
 * Speaks the nocode-runtime pod's Bedrock-style SSE contract (NOT the parked
 * ggui generative-UI protocol that `@ggui-ai/mcp-apps-react`'s useInvoke targets):
 *
 *   POST {endpointUrl}/agent/invoke
 *     body: the one shape `buildInvokeBody` builds (`./invoke-body`)
 *   ← SSE:
 *     event: session  { sessionId, userId, threadId? }
 *     event: message  <SDKMessage JSON>          (assistant turns + result)
 *     event: done     { stopReason, threadId?, userSeq?, agentSeq? }
 *     event: error    { code, message }
 *
 * History persistence (B1) is server-side: the pod resolves a durable Thread
 * from the `threadId` we replay and persists each turn. The threadId is kept
 * in consumer-provided storage (per app) so a reload continues the same
 * conversation.
 *
 * Platform-agnostic: storage, id generation, and the network transport (which
 * also carries anonymous identity) are injected via `opts.adapters`. See
 * `./web-adapters` for the web (Studio) bundle; Portal supplies RN adapters.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Reducer, type AgClientCapabilities, type AgReduceResult } from "@silverprotocol/core";
import { invokeTurn, toInvokeUrl } from "./invoke-turn.js";
import { buildInvokeBody } from "./invoke-body.js";
import { AgentResponseError } from "./errors.js";
import { withActivityObserver } from "./transport.js";
import { CLIENT_ERROR_CODES } from "./error-codes.js";
import { HistoryUnauthorizedError } from "./history.js";
import { writeTapLabels } from "@guuey/mcp-apps-host/narrowing";
import { describeImageAttachmentRefusal, validateImageAttachments } from "./attachments.js";
import { type InputKind, isInputKindRefusal } from "./input-kinds.js";
import type {
  AgentInvokeAdapters,
  AgentInvokeStatus,
  AgentMessage,
  HistoryCard,
  HistoryLoadResult,
  ProfileLinkRequest,
  SendOptions,
  StallRecoveryOptions,
  ThreadClosed,
  UseAgentInvokeOptions,
  UseAgentInvokeReturn,
} from "./types.js";

function threadStorageKey(appId: string | undefined): string {
  return `guuey:thread:${appId ?? "default"}`;
}

/**
 * What a block-preserving consumer advertises by default (guuey#207): it
 * folds `turn.done outcome:"paused"` records, so it can render the AgJSON
 * hitl card with declared grant modes — the `@guuey/chat` path. See
 * `UseAgentInvokeOptions.capabilities`.
 */
export const DEFAULT_BLOCK_PRESERVING_CAPABILITIES: AgClientCapabilities = {
  hitl: { ask: true, grantModes: true },
};

/**
 * What an embedder advertises when it delivers EVERY `ui/message` a card's
 * view posts as the next agent turn: sent immediately when idle, queued while
 * a turn is live, and a drop surfaced by the host, never silent. The guuey
 * widget's doorbell does exactly that. On this declaration the pod tells the
 * generative-UI server the session can take a view's message as a turn, and
 * the server lets a render turn end at paint instead of waiting on the view.
 * Pass it as `UseAgentInvokeOptions.capabilities` ONLY when that delivery is
 * really wired: a surface without it would be promising turns it never sends.
 * A pod that predates the field strips it and serves the session unchanged.
 */
export const VIEW_MESSAGE_TURN_CAPABILITIES: AgClientCapabilities = {
  ...DEFAULT_BLOCK_PRESERVING_CAPABILITIES,
  uiResources: { viewMessageTurns: true },
};

/** The decision `applyHistoryResult` reaches for a loaded transcript. */
export type HistoryApplication =
  | { kind: "seed"; messages: AgentMessage[] }
  | { kind: "skip" }
  | { kind: "clear" };

/**
 * Pure decision seam for post-hydration history application (see
 * `AgentInvokeHistoryAdapter` in `./types`). `gone` always clears the
 * persisted thread. Otherwise a non-empty transcript seeds the chat UNLESS
 * the chat has already been touched (`currentMessages.length > 0`) — a
 * mid-flight send always beats late-arriving history.
 */
export function applyHistoryResult(
  result: HistoryLoadResult,
  currentMessages: AgentMessage[],
): HistoryApplication {
  if ("gone" in result) return { kind: "clear" };
  if (currentMessages.length > 0 || result.messages.length === 0) return { kind: "skip" };
  return { kind: "seed", messages: result.messages };
}

/**
 * guuey#2445 — what an adoption sets: history's rows, and whether the fold
 * stays beside them.
 *
 * History holds every row of the conversation, so it is the authority for
 * which rows there are and where each sits. The fold holds the turns this
 * session saw live, and it stays only when each of them can be tied to its
 * row in history: then the adopted turn and every earlier live turn keep
 * drawing as they streamed. The tie is the stamp (`precedingTurnCount`) each
 * live send carries, which only this client knows: it is carried onto
 * history's copy of that send's row.
 *
 * A row is tied by its `clientMessageId`, which the read plane serves on every
 * row it stores (the pod writes the invoke body's key on the user row). A
 * history that serves no keys at all (the `guuey dev` server, an older read
 * plane, or an adapter that does not carry them) is tied by position, but
 * only when its user rows are exactly the local ones, in order and word for
 * word.
 *
 * When a live send cannot be tied (history holds no row for it, as for a send
 * the `guuey dev` server did not store, or a keyless history whose rows differ
 * from the local ones), `keepsFold` is false: the hook drops the fold, and
 * history's rows draw the whole conversation, as a reload draws it. Keeping
 * the fold there would leave the planner to guess which history rows the fold
 * covers, and a wrong guess draws an answer twice or under the wrong question.
 */
export function adoptedTranscript(
  history: AgentMessage[],
  local: readonly AgentMessage[],
): { messages: AgentMessage[]; keepsFold: boolean } {
  const localUsers = local.filter((m) => m.role === "user");
  const live = localUsers.filter((m) => m.precedingTurnCount !== undefined);
  if (live.length === 0) return { messages: history, keepsFold: true };
  const historyUsers = history.filter((m) => m.role === "user");
  const keyless = historyUsers.every((m) => m.clientMessageId === undefined);
  if (keyless) {
    const samePositions =
      historyUsers.length === localUsers.length && historyUsers.every((m, i) => m.text === localUsers[i]?.text);
    if (!samePositions) return { messages: history, keepsFold: false };
    let userIndex = 0;
    const messages = history.map((m) => {
      if (m.role !== "user") return m;
      const sent = localUsers[userIndex++];
      return sent?.precedingTurnCount === undefined ? m : { ...m, precedingTurnCount: sent.precedingTurnCount };
    });
    return { messages, keepsFold: true };
  }
  const stamps = new Map<string, number>();
  for (const m of live) {
    if (m.clientMessageId !== undefined && m.precedingTurnCount !== undefined) {
      stamps.set(m.clientMessageId, m.precedingTurnCount);
    }
  }
  const tied = new Set<string>();
  const messages = history.map((m) => {
    if (m.role !== "user" || m.clientMessageId === undefined) return m;
    const precedingTurnCount = stamps.get(m.clientMessageId);
    if (precedingTurnCount === undefined) return m;
    tied.add(m.clientMessageId);
    return { ...m, precedingTurnCount };
  });
  const keepsFold = live.every((m) => m.clientMessageId !== undefined && tied.has(m.clientMessageId));
  // A dropped fold leaves no stamps: they point into the turn space of the
  // fold being dropped, and the next send's stamp counts from 0 in a new one.
  return { messages: keepsFold ? messages : history, keepsFold };
}

/** What {@link stallProbeDecision} knows of the turn it probes for (guuey#2858); each absent field reads as before. */
export interface StallProbeTurn {
  /** The send's idempotency key, which the read plane serves on its user row. */
  clientMessageId?: string;
  /** The history read stopped at its page cap (`HistoryLoadResult.truncated`). */
  truncated?: boolean;
  /** The order the read walked (`HistoryLoadResult.order`): a truncated `"desc"` read still holds the newest row. */
  order?: "desc" | "asc";
  /**
   * The local transcript the probe compares against, this send's own row
   * included. A truncated keyed read needs it to place the window history
   * covers; without it such a read is not adopted.
   */
  localRows?: readonly AgentMessage[];
}

/**
 * guuey#2858: a history read holds the conversation's NEWEST row. A whole read
 * holds every row; a truncated newest-first read (`order: "desc"`) left out the
 * oldest. A truncated ascending read (a read plane that predates the order, or
 * a loader that does not say) left out the newest, so a turn at its end may be
 * missing its last rows.
 */
function historyHoldsNewest(read: { truncated?: boolean; order?: "desc" | "asc" }): boolean {
  return read.order === "desc" || read.truncated !== true;
}

/**
 * guuey#2858: on a truncated keyed read, the user-count rule over the window
 * history covers. Every keyed local user row (a live send, a failed one the
 * read plane never stored, or a row an earlier read seeded) must be in history
 * by its key, or sit before history's oldest keyed user row in the local
 * transcript (the read left it out with the other old rows). A local row
 * inside the window that history does not hold is a send that was never
 * stored, and adopting would drop it. When history's oldest key is not in the
 * local transcript, the window cannot be placed, and every keyed local row
 * must be in history.
 */
function localSendsInWindowStored(history: readonly AgentMessage[], local: readonly AgentMessage[]): boolean {
  const stored = new Set<string>();
  let oldestKey: string | undefined;
  for (const m of history) {
    if (m.role !== "user" || m.clientMessageId === undefined) continue;
    oldestKey ??= m.clientMessageId;
    stored.add(m.clientMessageId);
  }
  const windowStart = Math.max(0, local.findIndex((m) => m.role === "user" && m.clientMessageId === oldestKey));
  return local.every(
    (m, i) => i < windowStart || m.role !== "user" || m.clientMessageId === undefined || stored.has(m.clientMessageId),
  );
}

/** A history read that holds a transcript (not `gone`). */
type HistoryTranscript = Extract<HistoryLoadResult, { messages: AgentMessage[] }>;

/** The guuey#192 stall watchdog's resolved tuning (see {@link stallProbeDecision}). */
export const STALL_RECOVERY_DEFAULTS = {
  windowMs: 25_000,
  probeAttempts: 4,
  /**
   * guuey#409: the PRE-first-byte watchdog window. The #192 clock arms only
   * on the first chunk (so a silent cold start never trips it) — which left
   * a turn that never receives ANY byte with no watchdog at all: the
   * eternal-"Thinking…" face of the 2026-08-22 invoke-rail turn death.
   * Deliberately much longer than `windowMs`: the transport's cold-start
   * retries legitimately spend up to ~90s before the first byte.
   */
  preFirstByteWindowMs: 120_000,
} as const;

/**
 * The rows without a failed send's own row (guuey#2608): the user row keyed
 * `clientMessageId` and the empty reply placeholder pushed right after it. A
 * failed send produced no agent turn, so nothing else belongs to it.
 */
function withoutFailedRow(rows: readonly AgentMessage[], clientMessageId: string): AgentMessage[] {
  const at = rows.findIndex((m) => m.role === "user" && m.clientMessageId === clientMessageId);
  if (at < 0) return rows.slice();
  const next = rows[at + 1];
  const span = next !== undefined && next.role === "assistant" && next.text === "" ? 2 : 1;
  return [...rows.slice(0, at), ...rows.slice(at + span)];
}

/** Resolve after `ms`, or at once when `signal` aborts (the wait never outlives the turn). */
function delayUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveStallRecovery(
  option: false | StallRecoveryOptions | undefined,
): { windowMs: number; probeAttempts: number; preFirstByteWindowMs: number } | null {
  if (option === false) return null;
  return {
    windowMs: option?.windowMs ?? STALL_RECOVERY_DEFAULTS.windowMs,
    probeAttempts: option?.probeAttempts ?? STALL_RECOVERY_DEFAULTS.probeAttempts,
    preFirstByteWindowMs:
      option?.preFirstByteWindowMs ?? STALL_RECOVERY_DEFAULTS.preFirstByteWindowMs,
  };
}

/**
 * Pure decision seam for the guuey#192 stall probe: does a freshly-loaded
 * transcript already contain THIS turn's finished reply?
 *
 * `adopt` requires BOTH signals, because each alone lies in a real case:
 *
 *  - **user-count**: history must hold at least as many user turns as the
 *    local transcript (which includes the just-sent optimistic one). Without
 *    it, a thread whose PREVIOUS turn ended in a completed assistant reply
 *    would adopt that OLD transcript and silently drop the in-flight turn.
 *  - **finished tail**: history's last message must be a non-empty assistant
 *    reply. Without it, a history read that caught the persisted user row
 *    before the assistant row would adopt a reply-less transcript.
 *
 * KNOWN LIMIT (documented, accepted): the runtime persists a turn's rows at
 * completion — the guuey#192 evidence (a reload mid-stall renders the FULL
 * reply) is only possible under that model. The read plane DOES project each
 * row's `clientMessageId` (the user row carries the invoke body's key, and the
 * turn's agent and card rows carry keys derived from it), but this decision
 * does not read it: a key says which turn a row belongs to, never whether that
 * turn's reply is finished. If persistence ever becomes progressive (partial
 * assistant rows), this heuristic needs the read plane to grow a
 * turn-completion marker — do not "fix" it client-side by text comparison,
 * which cannot distinguish a partial row from a finished one.
 *
 * guuey#2858: a history read can stop at its page cap (`truncated`), and then
 * it does not hold every row, so the user-count rule cannot hold as written.
 * `turn` carries the send's `clientMessageId`: where history's user rows carry
 * keys, the turn is the row with that key and the rows after it up to the next
 * user row, and it is finished when the last of them is a non-empty reply.
 *
 *  - A whole keyed read must ALSO pass the user-count rule (fewer user rows
 *    than the local transcript means a local send was never stored, as the
 *    `guuey dev` server does for a failed run, and adopting would drop it).
 *  - A truncated keyed read passes the same rule over the window it covers
 *    (`turn.localRows`, see {@link localSendsInWindowStored}).
 *  - A read that may have left out the newest rows (a truncated ascending
 *    read, {@link historyHoldsNewest}) cannot say a turn at its end is
 *    finished, so such a turn is in flight.
 *  - A keyless history is read by position, which needs the newest row: the
 *    rules above run only when the read holds it. A truncated ascending
 *    keyless read is in flight (pending), never adopted.
 */
export function stallProbeDecision(
  history: AgentMessage[],
  localUserCount: number,
  turn: StallProbeTurn = {},
): "adopt" | "in-flight" {
  let historyUserCount = 0;
  for (const m of history) if (m.role === "user") historyUserCount += 1;
  const holdsNewest = historyHoldsNewest(turn);
  // guuey#2858: a history that serves keys finds THIS turn by its key, so a
  // read that stopped at its page cap (and so holds fewer user turns than the
  // local transcript) can still be adopted. The count rule holds as well: over
  // the whole conversation on a whole read, over the window the read covers on
  // a truncated one. A local send history should hold and does not was never
  // stored, and adopting would drop it from the transcript.
  const key = turn.clientMessageId;
  if (key !== undefined && history.some((m) => m.role === "user" && m.clientMessageId !== undefined)) {
    if (turn.truncated !== true) {
      if (historyUserCount < localUserCount) return "in-flight";
    } else if (turn.localRows === undefined || !localSendsInWindowStored(history, turn.localRows)) {
      return "in-flight";
    }
    let at = -1;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const m = history[i];
      if (m !== undefined && m.role === "user" && m.clientMessageId === key) {
        at = i;
        break;
      }
    }
    if (at === -1) return "in-flight";
    let end = history.length;
    for (let i = at + 1; i < history.length; i += 1) {
      if (history[i]?.role === "user") {
        end = i;
        break;
      }
    }
    // A turn that runs to the end of a read that left out the newest rows may
    // have more rows past the cut: its last row read is not its last row.
    if (end === history.length && !holdsNewest) return "in-flight";
    const tail = end - 1 > at ? history[end - 1] : undefined;
    return tail === undefined || tail.role === "user" || tail.text.trim() === "" ? "in-flight" : "adopt";
  }
  // A keyless history is read by position, which needs the newest row: a
  // truncated ascending read left it out and cannot say whether this turn is
  // in it, so the turn stays pending.
  if (!holdsNewest) return "in-flight";
  if (historyUserCount < localUserCount) return "in-flight";
  const last = history[history.length - 1];
  // A notice tail is a finished turn too: the runtime persists a turn's rows
  // at completion, and a failed turn ends on its reader-line notice.
  if (!last || last.role === "user" || last.text.trim() === "") return "in-flight";
  return "adopt";
}

export function useAgentInvoke(opts: UseAgentInvokeOptions): UseAgentInvokeReturn {
  const { endpointUrl, appId } = opts;
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  // Per-turn lifecycle (guuey#91) — derived purely from the frames below; see
  // the `AgentInvokeStatus` doc for the state meanings. `activeTool` carries
  // the wire tool name only while status is 'using-tool'.
  const [status, setStatus] = useState<AgentInvokeStatus>("ready");
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The pod's wire code for whatever put `error` there, when the failure
  // carried one (see the return-type contract). Moves in lockstep with
  // `error` — every set/clear of one touches the other.
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  // The agent ended this conversation (see the return-type contract). The ref
  // mirrors it for `send`, which must not depend on it (stable identity).
  const [threadClosed, setThreadClosedState] = useState<ThreadClosed | null>(null);
  const threadClosedRef = useRef<ThreadClosed | null>(null);
  const setThreadClosed = useCallback((next: ThreadClosed | null) => {
    threadClosedRef.current = next;
    setThreadClosedState(next);
  }, []);
  // Opt-in block-preserving transcript. `reduceResult` follows the
  // null-until-first-valid-AgEvent contract documented on the return type: it
  // starts null and only becomes non-null once the per-conversation reducer
  // folds a valid AgEvent (so it stays null forever in bypass mode).
  const [reduceResult, setReduceResult] = useState<AgReduceResult | null>(null);
  // Persisted generative-UI cards rehydrated from history (see return-type
  // contract). Independent of the live `reduceResult` fold — populated only
  // when a card-carrying history load seeds the transcript.
  const [historyCards, setHistoryCards] = useState<HistoryCard[]>([]);
  // guuey#2858: the history in view stopped at its page cap (see return-type contract).
  const [historyTruncated, setHistoryTruncated] = useState(false);
  // The pod's latest cross-app profile LINK invite on this conversation (T3's
  // `profile-link-needed` SSE event), or null. Cleared on app switch / reset /
  // explicit dismiss. (Consent is NOT hook state: it rides the AgJSON fold as
  // a paused turn — `reduceResult` — and is answered through
  // `createHitlAnswerRelay`, guuey#207.)
  const [profileLinkRequest, setProfileLinkRequest] = useState<ProfileLinkRequest | null>(null);
  // The last turn's ending posture + the optimistic-send ledger — the
  // transcript renderer's inputs (guuey#135 wave 3b; see the return-type
  // contract for each). `aborted` is USER abort only — the #192 watchdog's
  // internal stream abort never sets it.
  const [aborted, setAborted] = useState(false);
  const [adopted, setAdopted] = useState(false);
  const [sendStates, setSendStates] = useState<Readonly<Record<string, "sending" | "failed">>>({});
  // guuey#2608: `send` reads the ledger at call time (a Retry names the failed
  // row it replaces) without depending on it — the render-time mirror idiom.
  const sendStatesRef = useRef(sendStates);
  sendStatesRef.current = sendStates;
  // guuey#2549: the input kinds the latest session frame offered (null before
  // any admitted turn of this app). A hint only; the runtime judges each turn.
  const [acceptedInputKinds, setAcceptedInputKindsState] = useState<readonly InputKind[] | null>(null);
  const setAcceptedInputKinds = useCallback((next: readonly InputKind[] | null): void => {
    // Keep the array identity while the offer is unchanged, so a host effect
    // keyed on it runs only when the offer moves.
    setAcceptedInputKindsState((prev) =>
      prev !== null && next !== null && prev.length === next.length && prev.every((k, i) => k === next[i]) ? prev : next,
    );
  }, []);

  const abortRef = useRef<AbortController | null>(null);
  // Mirror the latest threadId + adapters into refs so `send` reads fresh
  // values without depending on them (keeps the callback identity stable and
  // sidesteps the async-hydration race).
  const threadIdRef = useRef<string | null>(null);
  const adaptersRef = useRef<AgentInvokeAdapters>(opts.adapters);
  adaptersRef.current = opts.adapters;
  // The stall probe (guuey#192) needs the committed transcript's user-turn
  // count long after `send`'s closures captured state — same render-time
  // mirror idiom as `adaptersRef`.
  const messagesRef = useRef<AgentMessage[]>(messages);
  messagesRef.current = messages;
  const stallRecoveryRef = useRef(opts.stallRecovery);
  stallRecoveryRef.current = opts.stallRecovery;
  // The per-conversation AgJSON fold (only built when `preserveBlocks`).
  // Lazily (re)created on the first valid AgEvent after a fresh start / reset,
  // so an off run never constructs one and a bypass run never allocates.
  // The core Reducer carries `_meta` onto tool-result blocks as of
  // `@silverprotocol/core` 0.4.1 (workspace#9), so BOTH generative-UI channels
  // (MCP-Apps `_meta.ui`, ggui's render bootstrap) survive the fold natively —
  // the old guuey-side `BlockFold` carriage wrapper is deleted.
  const reducerRef = useRef<Reducer | null>(null);
  const preserveBlocksRef = useRef<boolean>(opts.preserveBlocks ?? false);
  preserveBlocksRef.current = opts.preserveBlocks ?? false;
  // The in-flight threadId hydration for the current appId. `send` awaits it
  // so a fast first send replays the persisted thread instead of minting a
  // new (orphan) one — critical on async stores (AsyncStorage).
  const hydrationRef = useRef<Promise<void> | null>(null);

  // Hydrate the persisted threadId on mount / app change. Switching apps
  // starts a FRESH session: reset everything first so one agent's thread +
  // transcript never leaks into another (the hook is shared + appId-keyed,
  // and a consumer may swap appId in place without remounting). Tolerates a
  // sync (localStorage) or async (AsyncStorage) store.
  useEffect(() => {
    abortRef.current?.abort();
    threadIdRef.current = null;
    setThreadId(null);
    setThreadClosed(null);
    setMessages([]);
    setError(null);
    setErrorCode(null);
    setStatus("ready");
    setActiveTool(null);
    // Fresh conversation → drop the old fold; the reducer is rebuilt lazily on
    // the next valid AgEvent. Persisted cards are re-seeded below from history.
    reducerRef.current = null;
    setReduceResult(null);
    setHistoryCards([]);
    setHistoryTruncated(false);
    // A prior app's link invite must never leak into the new conversation.
    setProfileLinkRequest(null);
    setAborted(false);
    setAdopted(false);
    setSendStates({});
    // Another app is another agent: its offer is unknown until its first turn.
    setAcceptedInputKinds(null);

    let cancelled = false;
    const key = threadStorageKey(appId);
    const hydration = Promise.resolve(adaptersRef.current.storage.load(key))
      .then((id) => {
        if (!cancelled && id && !threadIdRef.current) {
          threadIdRef.current = id;
          setThreadId(id);
        }
      })
      .catch(() => {
        // Storage unavailable (private mode / keychain error) — no persisted
        // thread; the session simply starts fresh.
      });
    // `hydrationRef` (which `send` awaits) resolves at threadId-load time —
    // history rehydration below is a SEPARATE, un-awaited continuation so a
    // slow history endpoint never gates the user's first send.
    hydrationRef.current = hydration;

    void hydration.then(async () => {
      // Best-effort transcript rehydration: only runs when a persisted
      // threadId was actually found and a history adapter was supplied.
      // Never throws — a failed/missing history load simply leaves the
      // chat empty and the user starts fresh.
      const tid = threadIdRef.current;
      const history = adaptersRef.current.history;
      if (cancelled || !tid || !history) return;
      let result: HistoryLoadResult;
      try {
        result = await history.load(tid);
      } catch (err) {
        // guuey#413 fail-LOUD carve-out from the best-effort rule: an
        // UNAUTHORIZED read on a RESUMED threadId means a transcript the
        // user expects exists and cannot be shown — silently booting a
        // fresh-looking empty chat hid the identity-drift outage for
        // exactly the accounts holding old threads. Auth refusal surfaces
        // as an error item; every other failure (offline, transient)
        // keeps the best-effort swallow — chat continues without history.
        if (!cancelled && err instanceof HistoryUnauthorizedError) {
          // Same guard as the `gone` arm below: clear + fresh (functional)
          // + the notice (loud). Same concurrency guard — never clobber a
          // threadId a mid-flight send just established.
          if (threadIdRef.current === tid) {
            threadIdRef.current = null;
            setThreadId(null);
            void adaptersRef.current.storage.save(threadStorageKey(appId), "");
          }
          setError(
            "Couldn't restore your previous conversation — started a new one. (This session was not authorized to read the old thread.)",
          );
          setErrorCode(CLIENT_ERROR_CODES.THREAD_HISTORY_UNAVAILABLE);
        }
        return;
      }
      if (cancelled) return;
      if ("gone" in result) {
        // Ordering intent: only clear if no concurrent send() has since
        // established a fresh threadId (a session event mutates
        // `threadIdRef` + saves it). Clearing/overwriting storage here after
        // that would clobber a freshly-valid id with '' on async stores.
        if (threadIdRef.current !== tid) return;
        threadIdRef.current = null;
        setThreadId(null);
        void adaptersRef.current.storage.save(threadStorageKey(appId), "");
        // guuey#413: the hydration guard's LOUD half. `gone` covers 403 as
        // well as 404 (history.ts) — an owner-mismatch refusal on a drifted
        // identity flowed through THIS arm as a silent fresh-looking boot,
        // which is the exact outage face this guard exists to kill. The
        // fresh mint stays (functional); the notice makes it honest. Loud
        // AND functional, never one without the other.
        setError(
          "Couldn't restore your previous conversation — started a new one.",
        );
        setErrorCode(CLIENT_ERROR_CODES.THREAD_HISTORY_UNAVAILABLE);
        return;
      }
      // Single decision authority: `applyHistoryResult` runs INSIDE the
      // functional update against the live `prev`, so a mid-flight send()'s
      // optimistic messages always beat late-arriving history.
      setMessages((prev) => {
        const application = applyHistoryResult(result, prev);
        return application.kind === "seed" ? application.messages : prev;
      });
      // Surface any persisted cards the loader opted to include (independent of
      // the text seed decision — cards are their own render lane, never
      // optimistically added by send(), so there is nothing to clobber). Empty
      // when the adapter is text-only (no `cards` key on the result).
      if ("cards" in result && result.cards && result.cards.length > 0) {
        setHistoryCards(result.cards);
      }
      // guuey#2858: the read stopped at its page cap and left the OLDEST rows
      // out; the renderer says earlier messages are not shown. A truncated
      // ascending read left the newest out, and that line would be false.
      setHistoryTruncated(result.truncated === true && result.order === "desc");
      // The agent ended this conversation before the reload: say so, unless a
      // send since then has already moved this hook to another thread.
      if (result.closed !== undefined && threadIdRef.current === tid) {
        setThreadClosed(result.closed);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    // Start a genuinely fresh conversation: forget the durable thread so the
    // next send() mints a new one (not append to the old), clear the
    // persisted key so a reload doesn't rehydrate the old transcript, and
    // wipe the visible state.
    threadIdRef.current = null;
    setThreadId(null);
    setThreadClosed(null);
    void adaptersRef.current.storage.save(threadStorageKey(appId), "");
    setMessages([]);
    setError(null);
    setErrorCode(null);
    setStatus("ready");
    setActiveTool(null);
    // Re-create the reducer for the new conversation (rebuilt lazily on the
    // next valid AgEvent) and clear the exposed fold + any rehydrated cards.
    reducerRef.current = null;
    setReduceResult(null);
    setHistoryCards([]);
    setHistoryTruncated(false);
    setProfileLinkRequest(null);
    setAborted(false);
    setAdopted(false);
    setSendStates({});
  }, [appId]);

  const clearProfileLinkRequest = useCallback(() => {
    setProfileLinkRequest(null);
  }, []);

  // guuey#524: `send` is memoized on [endpointUrl, appId, status, signal] —
  // options read inside it are otherwise frozen at memo time. pageContext's
  // whole contract is read-at-SEND-time freshness (SPA route changes must
  // ride the next turn), so it goes through a live ref, the same discipline
  // as every live-read value in the kit layer.
  const pageContextRef = useRef(opts.pageContext);
  pageContextRef.current = opts.pageContext;
  // guuey#566: same live-ref discipline — a surface's mode can change
  // mid-session (a guest signs in and the host flips rep → agent); the
  // NEXT turn carries the new mode.
  const modeRef = useRef(opts.mode);
  modeRef.current = opts.mode;

  const send = useCallback(
    async (input: string, sendOpts?: SendOptions) => {
      // An already-aborted external signal refuses the send outright —
      // before the optimistic transcript push, so nothing is left to undo.
      // guuey#2031: a host that named this turn beforehand (a drawn card
      // tap) must not read a refused send as sent. The id never reached the
      // agent: the R0 failed state, with no row pushed for it. A hook-minted
      // id has no holder, so a plain refused send writes nothing.
      const markRefused = (): void => {
        const refusedId = sendOpts?.clientMessageId;
        if (refusedId !== undefined && refusedId !== "") {
          setSendStates((prev) => (prev[refusedId] === "failed" ? prev : { ...prev, [refusedId]: "failed" }));
        }
      };
      // guuey#2549: a turn without words names where its content rides; blank
      // text beside a kind is sent as "" (the runtime's own rule is exactly an
      // empty input). The runtime judges whether its agent takes the turn.
      const inputKind = sendOpts?.inputKind !== undefined && !input.trim() ? sendOpts.inputKind : undefined;
      const turnInput = inputKind !== undefined ? "" : input;
      if (!endpointUrl || (inputKind === undefined && !input.trim()) || status !== "ready" || opts.signal?.aborted) {
        markRefused();
        return;
      }
      // guuey#2293: the turn's images are judged HERE, the one send path,
      // before the optimistic row: a list the V1 rules refuse is never sent,
      // and the reason is the turn's error.
      const attachmentsVerdict = validateImageAttachments(sendOpts?.attachments ?? []);
      if (!attachmentsVerdict.ok) {
        setError(describeImageAttachmentRefusal(attachmentsVerdict.refusal));
        setErrorCode(CLIENT_ERROR_CODES.ATTACHMENTS_INVALID);
        markRefused();
        return;
      }
      const attachments = attachmentsVerdict.attachments;
      setError(null);
      setErrorCode(null);
      setAborted(false);
      setAdopted(false);
      setStatus("connecting");
      // ONE id for the whole turn: the optimistic user entry, the send-state
      // ledger, and the invoke body all carry it — the R0 lifecycle join. A
      // host that already draws the turn (a pending card tap, guuey#2031)
      // hands in the id it minted with `newClientMessageId`.
      const clientMessageId =
        sendOpts?.clientMessageId !== undefined && sendOpts.clientMessageId !== ""
          ? sendOpts.clientMessageId
          : adaptersRef.current.generateId();
      // guuey#2031: the writer contract runs HERE, the one send path, so the
      // optimistic row and the body carry the same list or neither does.
      const tapLabels = sendOpts?.tapLabels !== undefined ? writeTapLabels(sendOpts.tapLabels) : undefined;
      /** Move this turn's ledger entry; `null` removes it (absent = sent). */
      const markSend = (state: "sending" | "failed" | null): void => {
        setSendStates((prev) => {
          if (state === null) {
            if (!(clientMessageId in prev)) return prev;
            const next: Record<string, "sending" | "failed"> = { ...prev };
            delete next[clientMessageId];
            return next;
          }
          if (prev[clientMessageId] === state) return prev;
          return { ...prev, [clientMessageId]: state };
        });
      };
      markSend("sending");
      let admitted = false;
      // guuey#1333: stamp how many agent turns had arrived before this row.
      // Read from the reducer rather than counting our own appends — the
      // fold is the same thing the planner groups its sources from, so the
      // two sides count the same events. A turn with no user row of its own
      // (a welcome card, or a chip click drained by `ggui_consume`) is
      // counted here exactly as the planner will count it.
      const precedingTurnCount = reducerRef.current?.result().turns.length ?? 0;
      const ownRow: AgentMessage = {
        role: "user",
        text: turnInput,
        clientMessageId,
        precedingTurnCount,
        ...(tapLabels !== undefined ? { tapLabels } : {}),
        ...(inputKind !== undefined ? { inputKind } : {}),
      };
      // guuey#2608: a Retry of a send that never reached the agent takes its
      // row's place. The failed row (and its empty reply placeholder) leaves
      // with its ledger entry, so the turn is drawn once, not beside its old
      // "Couldn't send" row. A row that is not marked failed reached the
      // agent and stays.
      const replaced = sendOpts?.replaces;
      const replacing =
        replaced !== undefined && replaced !== clientMessageId && sendStatesRef.current[replaced] === "failed";
      if (replacing) {
        setSendStates((prev) => {
          if (!(replaced in prev)) return prev;
          const next: Record<string, "sending" | "failed"> = { ...prev };
          delete next[replaced];
          return next;
        });
      }
      setMessages((prev) => [
        ...(replacing ? withoutFailedRow(prev, replaced) : prev),
        ownRow,
        { role: "assistant", text: "" },
      ]);
      /**
       * The rows this send's history decisions compare against: the last
       * render's, with this send's own row even when no render has drawn it
       * yet (React does not promise one before the stream ends).
       */
      const localRows = (): readonly AgentMessage[] => {
        const rows = messagesRef.current;
        return rows.some((m) => m.role === "user" && m.clientMessageId === clientMessageId) ? rows : [...rows, ownRow];
      };

      const controller = new AbortController();
      abortRef.current = controller;
      // Compose the host's external abort authority (opts.signal) with the
      // per-turn controller: an external abort stops this turn exactly as
      // `abort()` would. Listener removed in `finally` — the signal outlives
      // the turn, the subscription must not.
      const externalSignal = opts.signal;
      const onExternalAbort = (): void => controller.abort();
      externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
      const adapters = adaptersRef.current;
      let assistantText = "";
      const renderAssistant = (text: string) => {
        assistantText = text;
        setMessages((prev) => {
          const next = prev.slice();
          // The trailing entry is the assistant bubble we just pushed.
          next[next.length - 1] = { role: "assistant", text };
          return next;
        });
      };

      // ── guuey#192 stall watchdog ─────────────────────────────────────
      // A half-dead connection (TCP alive, zero bytes, no error, no `done`)
      // never resolves the read below, so a parallel clock watches byte
      // activity: armed by the FIRST chunk (so a silent cold start never
      // trips it), reset by every chunk, and on expiry it probes history
      // WITHOUT touching the stream — killing a live-but-quiet stream on a
      // timer would trade a frozen cursor for a lost turn. Only two things
      // end the turn early: adoption (history already holds the finished
      // reply — the reload the user would have done, minus the reload) and
      // the bounded give-up (STREAM_STALLED after `probeAttempts` fruitless
      // probes with still-zero bytes).
      const stall = resolveStallRecovery(stallRecoveryRef.current);
      let turnEnded = false;
      let probeInFlight = false;
      // Whether THIS turn's stream carried its `done`, and an in-band error frame.
      let sawDone = false;
      let sawErrorFrame = false;
      let fruitlessProbes = 0;
      let activityCount = 0;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const clearStallTimer = (): void => {
        if (stallTimer !== null) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
      };
      const armStallTimer = (windowMs?: number): void => {
        if (!stall || turnEnded || controller.signal.aborted) return;
        clearStallTimer();
        stallTimer = setTimeout(() => {
          void onStallWindow();
        }, windowMs ?? stall.windowMs);
      };
      const endTurnWith = (apply: () => void): void => {
        turnEnded = true;
        clearStallTimer();
        apply();
        // Unwinds the suspended read; the catch sees `aborted` and stays
        // silent, so whatever `apply` decided IS the turn's outcome.
        controller.abort();
      };
      /** A history read that already holds THIS turn's finished reply (see {@link stallProbeDecision}). */
      const holdsFinishedReply = (result: HistoryLoadResult | null): result is HistoryTranscript => {
        if (!result || "gone" in result) return false;
        const local = localRows();
        let localUserCount = 0;
        for (const m of local) if (m.role === "user") localUserCount += 1;
        return (
          stallProbeDecision(result.messages, localUserCount, {
            clientMessageId,
            truncated: result.truncated === true,
            ...(result.order !== undefined ? { order: result.order } : {}),
            localRows: local,
          }) === "adopt"
        );
      };
      /**
       * Adopt the persisted turn: the transcript IS history's (each live
       * send keeping its turn stamp, or the fold dropped when history cannot
       * be tied to every live send, see {@link adoptedTranscript}), and the
       * renderer is told.
       */
      const adoptFrom = (adoptedResult: HistoryTranscript): void => {
        const adoption = adoptedTranscript(adoptedResult.messages, localRows());
        if (!adoption.keepsFold) {
          // The next valid AgEvent starts a new fold, and the next send's
          // stamp counts from it.
          reducerRef.current = null;
          setReduceResult(null);
        }
        setMessages(adoption.messages);
        // History holds this send, so it is sent (absent = sent), even when the
        // stall watchdog adopts it before its first byte.
        markSend(null);
        // History is the authority that a send was stored: every send whose
        // key its rows hold is sent too, including one marked failed because
        // its transport threw before admission although the pod stored it
        // (left failed, its Retry would send it twice).
        const stored = new Set<string>();
        for (const m of adoption.messages) {
          if (m.role === "user" && m.clientMessageId !== undefined) stored.add(m.clientMessageId);
        }
        setSendStates((prev) => {
          const held = Object.keys(prev).filter((key) => stored.has(key));
          if (held.length === 0) return prev;
          const next: Record<string, "sending" | "failed"> = { ...prev };
          for (const key of held) delete next[key];
          return next;
        });
        if (adoptedResult.cards && adoptedResult.cards.length > 0) {
          setHistoryCards(adoptedResult.cards);
        }
        setHistoryTruncated(adoptedResult.truncated === true && adoptedResult.order === "desc");
        // The renderer's signal: calm renders the adopted turn identically;
        // debug may mark it (guuey#135 3b).
        setAdopted(true);
      };
      const onStallWindow = async (): Promise<void> => {
        if (!stall || turnEnded || controller.signal.aborted || probeInFlight) return;
        const tid = threadIdRef.current;
        const history = adaptersRef.current.history;
        if (tid && history) {
          probeInFlight = true;
          const countAtProbe = activityCount;
          let result: HistoryLoadResult | null = null;
          try {
            result = await history.load(tid);
          } catch {
            result = null; // transient read failure = one fruitless probe
          }
          probeInFlight = false;
          if (turnEnded || controller.signal.aborted) return;
          // Bytes resumed while the probe was in flight: the stream is alive
          // — discard the now-stale read; the chunk observer already reset
          // the count and re-armed the clock.
          if (activityCount !== countAtProbe) return;
          if (holdsFinishedReply(result)) {
            const adoptedResult = result;
            endTurnWith(() => adoptFrom(adoptedResult));
            return;
          }
        }
        // No probe possible (no threadId yet / no history adapter), a failed
        // read, or history says the turn is still in flight — all count the
        // same: one fruitless window.
        fruitlessProbes += 1;
        if (fruitlessProbes >= stall.probeAttempts) {
          endTurnWith(() => {
            setError("The response stream stalled and the finished reply was not found in history.");
            setErrorCode(CLIENT_ERROR_CODES.STREAM_STALLED);
          });
          return;
        }
        armStallTimer();
      };
      const transport = stall
        ? withActivityObserver(adapters.transport, () => {
            activityCount += 1;
            fruitlessProbes = 0;
            armStallTimer();
          })
        : adapters.transport;

      try {
        // Wait for the persisted threadId to load before deciding whether to
        // replay it — otherwise a fast first send mints a new orphan thread and
        // clobbers the stored id. `hydrationRef` never rejects (it self-catches).
        // Inside the try: an abort during this wait unwinds through `finally`
        // like any pre-admission abort (the external listener comes off, the
        // empty reply bubble goes, the "sending" entry clears, the abort is
        // surfaced), never leaving the send half-written.
        if (hydrationRef.current) {
          await hydrationRef.current;
        }
        if (controller.signal.aborted) return;
        // The agent ended the current conversation: this send starts a new
        // one. The closed thread's id is dropped (here and in storage), so the
        // pod mints a fresh thread and the `session` frame names it.
        if (threadClosedRef.current !== null) {
          threadIdRef.current = null;
          setThreadId(null);
          setThreadClosed(null);
          void adapters.storage.save(threadStorageKey(appId), "");
        }
        // guuey#409: arm BEFORE the first byte — a turn that never receives
        // any chunk (rail death upstream of the pod, or an in-pod pre-spawn
        // hang) otherwise shows "Thinking…" forever with no error item. The
        // long window keeps silent cold starts un-tripped; expiry runs the
        // SAME probe-then-adopt-or-STREAM_STALLED machinery as mid-stream
        // stalls — one face fix for both mechanisms.
        armStallTimer(stall?.preFirstByteWindowMs);
        const invokeUrl = toInvokeUrl(endpointUrl);
        // The advertised AgJSON client capabilities (spec §3, guuey#207): an
        // explicit option wins; else a block-preserving consumer advertises
        // the hitl grant-mode card it can render, and a text-only one nothing.
        const capabilities =
          opts.capabilities ??
          (preserveBlocksRef.current ? DEFAULT_BLOCK_PRESERVING_CAPABILITIES : undefined);
        // The one wire shape, built by the pure builder so it has a name, a
        // test and a fixture (guuey#1213 — the rolling-release rule). The
        // live refs are read HERE, at send time: an SPA route change or a
        // mode change rides the NEXT turn, never a stale memo.
        const body = buildInvokeBody({
          input: turnInput,
          threadId: threadIdRef.current,
          clientMessageId,
          ...(capabilities !== undefined ? { capabilities } : {}),
          ...(pageContextRef.current !== undefined ? { pageContext: pageContextRef.current } : {}),
          ...(modeRef.current !== undefined ? { mode: modeRef.current } : {}),
          ...(tapLabels !== undefined ? { tapLabels } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(inputKind !== undefined ? { inputKind } : {}),
        });

        // The wire walk lives in `invokeTurn` (the pure per-turn generator —
        // its docblock owns the switch semantics); this hook only maps each
        // semantic event onto React state.
        for await (const ev of invokeTurn(
          { url: invokeUrl, body, signal: controller.signal },
          transport,
        )) {
          if (ev.kind === "session") {
            // The pod is awake and the turn is admitted — 'connecting' ends
            // here, and so does the R0 "sending" state (absent = sent).
            admitted = true;
            markSend(null);
            setStatus("thinking");
            setAcceptedInputKinds(ev.acceptedInputKinds);
            if (ev.threadId) {
              threadIdRef.current = ev.threadId;
              setThreadId(ev.threadId);
              void adapters.storage.save(threadStorageKey(appId), ev.threadId);
            }
            // guuey#2293: a runtime that predates attachments parses the
            // images and ignores them, and would answer the words alone. Only
            // an acknowledgement of every image lets the turn run; without it
            // the stream is cut here, before any reply, which also stops the
            // run on the runtime side.
            if (attachments.length > 0 && ev.attachmentsAccepted !== attachments.length) {
              endTurnWith(() => {
                setError("This agent's runtime did not accept the attached images, so the message was stopped before the agent answered.");
                setErrorCode(CLIENT_ERROR_CODES.ATTACHMENTS_UNSUPPORTED);
              });
              break;
            }
          } else if (ev.kind === "message") {
            // Absent status/activeTool mean "no change" — never touched, so
            // an unknown frame type leaves both standing (guuey#91 rule).
            if (ev.status !== undefined) setStatus(ev.status);
            if (ev.activeTool !== undefined) setActiveTool(ev.activeTool);
            renderAssistant(ev.assistantText);
            // Additively fold the frame's AgEvents into the AgJSON reducer
            // when opted in. The text surface above is untouched; only VALID
            // AgEvents advance the reducer (bypass frames carry [] and leave
            // `reduceResult` null — see the return-type contract).
            if (preserveBlocksRef.current && ev.agEvents.length > 0) {
              if (!reducerRef.current) reducerRef.current = new Reducer();
              for (const agEvent of ev.agEvents) reducerRef.current.push(agEvent);
              setReduceResult(reducerRef.current.result());
            }
          } else if (ev.kind === "error") {
            // In-band failure frame — the code moves in lockstep with the
            // message (an event without one carries null rather than leaving
            // a previous turn's code standing).
            sawErrorFrame = true;
            setError(ev.message);
            setErrorCode(ev.code);
            if (ev.threadClosed !== undefined) setThreadClosed(ev.threadClosed);
          } else if (ev.kind === "profile-link") {
            setProfileLinkRequest(ev.request);
          } else if (ev.kind === "done") {
            // The spec'd end of the invoke (AgJSON §8.0): the stream closes after it.
            sawDone = true;
            if (ev.threadClosed !== undefined) setThreadClosed(ev.threadClosed);
          }
        }
        // ── A stream that CLOSED without `done` ─────────────────────────
        // The pod sends `done` on every path where the client is still
        // connected, so a clean close without it means the connection was
        // cut (a proxy, a pod restart). Not a quiet end: the #192 machinery
        // decides. History already holding the finished reply is adopted (the
        // reply landed, the connection didn't). The pod may persist it only
        // seconds after the cut, so a first read that misses gets ONE bounded
        // re-read after the watchdog's window before the turn fails with
        // STREAM_TRUNCATED; reporting a finished turn as cut would invite a
        // duplicate ask. A failure the pod already voiced in-band keeps its
        // own words and code, with no probe. `turnEnded` is set only when the
        // verdict lands, so a user abort during the probe stays a user abort.
        if (!sawDone && !sawErrorFrame && !turnEnded && !controller.signal.aborted) {
          clearStallTimer();
          probeInFlight = true;
          const tid = threadIdRef.current;
          const history = adaptersRef.current.history;
          const readHistory = async (): Promise<HistoryLoadResult | null> => {
            if (!tid || !history) return null;
            try {
              return await history.load(tid);
            } catch {
              return null; // a failed read finds no reply, like the stall probe's
            }
          };
          let result = await readHistory();
          if (!holdsFinishedReply(result) && tid && history && !controller.signal.aborted) {
            await delayUnlessAborted(stall?.windowMs ?? STALL_RECOVERY_DEFAULTS.windowMs, controller.signal);
            if (!controller.signal.aborted) result = await readHistory();
          }
          probeInFlight = false;
          if (!controller.signal.aborted) {
            if (holdsFinishedReply(result)) {
              const adoptedResult = result;
              endTurnWith(() => adoptFrom(adoptedResult));
            } else {
              endTurnWith(() => {
                setError("The response stream ended before the reply finished, and the finished reply was not found in history.");
                setErrorCode(CLIENT_ERROR_CODES.STREAM_TRUNCATED);
              });
            }
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : "failed to reach agent");
          // Pre-stream refusals arrive as a thrown AgentResponseError carrying
          // the pod's structured code (a transport-level saturation retry has
          // already happened and failed by the time one surfaces here). Any
          // other throw — a network drop, a host-adapter failure — has no wire
          // code, so the field stays null beside the message.
          // guuey#2549: a runtime that does not take this turn without words
          // refuses it here, before anything is stored. It is read as its own
          // code (the reader is told to add words) and the offer is cleared; a
          // refusal of anything else keeps the runtime's code.
          const inputKindRefused =
            inputKind !== undefined &&
            e instanceof AgentResponseError &&
            e.status === 400 &&
            isInputKindRefusal(e.message);
          if (inputKindRefused) {
            setErrorCode(CLIENT_ERROR_CODES.INPUT_KIND_NOT_ADVERTISED);
            setAcceptedInputKinds([]);
          } else {
            setErrorCode(e instanceof AgentResponseError ? (e.code ?? null) : null);
          }
          // A failure BEFORE admission means the message never reached the
          // agent — the R0 failed-to-send state. Post-admission failures
          // leave the entry removed (the send itself succeeded).
          if (!admitted) markSend("failed");
        }
      } finally {
        // The turn is over however it ended — no probe may fire after this,
        // and the pending timer must not leak past the turn. `turnEnded`
        // already true here ⟺ the #192 watchdog ended the turn (adoption or
        // stall give-up) — its internal `controller.abort()` must not read
        // as a USER abort below.
        const endedByWatchdog = turnEnded;
        turnEnded = true;
        clearStallTimer();
        externalSignal?.removeEventListener("abort", onExternalAbort);
        setStatus("ready");
        setActiveTool(null);
        abortRef.current = null;
        // A turn aborted before any assistant text streamed leaves an empty
        // placeholder bubble — drop it so a stopped turn doesn't linger as a
        // blank assistant message.
        if (controller.signal.aborted && assistantText === "") {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            return last && last.role === "assistant" && last.text === ""
              ? prev.slice(0, -1)
              : prev;
          });
        }
        if (controller.signal.aborted && !endedByWatchdog) {
          // USER abort (abort() or the external signal): surface it, and a
          // pre-admission cancel clears the "sending" entry — a turn the
          // user stopped is not a failed send.
          setAborted(true);
          if (!admitted) markSend(null);
        }
      }
    },
    [endpointUrl, appId, status, opts.signal],
  );

  const newClientMessageId = useCallback((): string => adaptersRef.current.generateId(), []);

  return {
    messages,
    send,
    newClientMessageId,
    status,
    activeTool,
    error,
    errorCode,
    threadClosed,
    threadId,
    abort,
    reset,
    reduceResult,
    historyCards,
    historyTruncated,
    profileLinkRequest,
    clearProfileLinkRequest,
    aborted,
    adopted,
    sendStates,
    acceptedInputKinds,
  };
}
