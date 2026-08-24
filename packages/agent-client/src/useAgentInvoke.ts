/**
 * useAgentInvoke — the base-platform chat client.
 *
 * Speaks the nocode-runtime pod's Bedrock-style SSE contract (NOT the parked
 * ggui generative-UI protocol that `@ggui-ai/mcp-apps-react`'s useInvoke targets):
 *
 *   POST {endpointUrl}/agent/invoke
 *     body: { input, threadId?, clientMessageId, capabilities? }
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
import { AgentResponseError } from "./errors.js";
import { withActivityObserver } from "./transport.js";
import { CLIENT_ERROR_CODES } from "./error-codes.js";
import { HistoryUnauthorizedError } from "./history.js";
import type {
  AgentInvokeAdapters,
  AgentInvokeStatus,
  AgentMessage,
  HistoryCard,
  HistoryLoadResult,
  ProfileLinkRequest,
  StallRecoveryOptions,
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
 * reply) is only possible under that model, and the read plane carries no
 * per-row clientMessageId to match against. If persistence ever becomes
 * progressive (partial assistant rows), this heuristic needs the read plane
 * to grow a turn-completion marker — do not "fix" it client-side by text
 * comparison, which cannot distinguish a partial row from a finished one.
 */
export function stallProbeDecision(
  history: AgentMessage[],
  localUserCount: number,
): "adopt" | "in-flight" {
  let historyUserCount = 0;
  for (const m of history) if (m.role === "user") historyUserCount += 1;
  if (historyUserCount < localUserCount) return "in-flight";
  const last = history[history.length - 1];
  if (!last || last.role !== "assistant" || last.text.trim() === "") return "in-flight";
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
  // Opt-in block-preserving transcript. `reduceResult` follows the
  // null-until-first-valid-AgEvent contract documented on the return type: it
  // starts null and only becomes non-null once the per-conversation reducer
  // folds a valid AgEvent (so it stays null forever in bypass mode).
  const [reduceResult, setReduceResult] = useState<AgReduceResult | null>(null);
  // Persisted generative-UI cards rehydrated from history (see return-type
  // contract). Independent of the live `reduceResult` fold — populated only
  // when a card-carrying history load seeds the transcript.
  const [historyCards, setHistoryCards] = useState<HistoryCard[]>([]);
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
    // A prior app's link invite must never leak into the new conversation.
    setProfileLinkRequest(null);
    setAborted(false);
    setAdopted(false);
    setSendStates({});

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
    setProfileLinkRequest(null);
    setAborted(false);
    setAdopted(false);
    setSendStates({});
  }, [appId]);

  const clearProfileLinkRequest = useCallback(() => {
    setProfileLinkRequest(null);
  }, []);

  const send = useCallback(
    async (input: string) => {
      // An already-aborted external signal refuses the send outright —
      // before the optimistic transcript push, so nothing is left to undo.
      if (!endpointUrl || !input.trim() || status !== "ready" || opts.signal?.aborted) return;
      setError(null);
      setErrorCode(null);
      setAborted(false);
      setAdopted(false);
      setStatus("connecting");
      // ONE id for the whole turn: the optimistic user entry, the send-state
      // ledger, and the invoke body all carry it — the R0 lifecycle join.
      const clientMessageId = adaptersRef.current.generateId();
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
      setMessages((prev) => [
        ...prev,
        { role: "user", text: input, clientMessageId },
        { role: "assistant", text: "" },
      ]);

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
      // Wait for the persisted threadId to load before deciding whether to
      // replay it — otherwise a fast first send mints a new orphan thread and
      // clobbers the stored id. `hydrationRef` never rejects (it self-catches).
      if (hydrationRef.current) {
        await hydrationRef.current;
      }
      if (controller.signal.aborted) {
        setStatus("ready");
        abortRef.current = null;
        return;
      }
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
      // guuey#409: arm BEFORE the first byte — a turn that never receives
      // any chunk (rail death upstream of the pod, or an in-pod pre-spawn
      // hang) otherwise shows "Thinking…" forever with no error item. The
      // long window keeps silent cold starts un-tripped; expiry runs the
      // SAME probe-then-adopt-or-STREAM_STALLED machinery as mid-stream
      // stalls — one face fix for both mechanisms.
      armStallTimer(stall?.preFirstByteWindowMs);
      const endTurnWith = (apply: () => void): void => {
        turnEnded = true;
        clearStallTimer();
        apply();
        // Unwinds the suspended read; the catch sees `aborted` and stays
        // silent, so whatever `apply` decided IS the turn's outcome.
        controller.abort();
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
          if (result && !("gone" in result)) {
            let localUserCount = 0;
            for (const m of messagesRef.current) if (m.role === "user") localUserCount += 1;
            if (stallProbeDecision(result.messages, localUserCount) === "adopt") {
              const adoptedResult = result;
              endTurnWith(() => {
                setMessages(adoptedResult.messages);
                if ("cards" in adoptedResult && adoptedResult.cards && adoptedResult.cards.length > 0) {
                  setHistoryCards(adoptedResult.cards);
                }
                // The renderer's #192 signal: calm renders the adopted turn
                // identically; debug may mark it (guuey#135 3b).
                setAdopted(true);
              });
              return;
            }
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
        const invokeUrl = toInvokeUrl(endpointUrl);
        // The advertised AgJSON client capabilities (spec §3, guuey#207): an
        // explicit option wins; else a block-preserving consumer advertises
        // the hitl grant-mode card it can render, and a text-only one nothing.
        const capabilities =
          opts.capabilities ??
          (preserveBlocksRef.current ? DEFAULT_BLOCK_PRESERVING_CAPABILITIES : undefined);
        const body = {
          input,
          ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
          clientMessageId,
          ...(capabilities !== undefined ? { capabilities } : {}),
        };

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
            if (ev.threadId) {
              threadIdRef.current = ev.threadId;
              setThreadId(ev.threadId);
              void adapters.storage.save(threadStorageKey(appId), ev.threadId);
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
            setError(ev.message);
            setErrorCode(ev.code);
          } else if (ev.kind === "profile-link") {
            setProfileLinkRequest(ev.request);
          }
          // `done` needs no handling here — the stream closes after it.
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : "failed to reach agent");
          // Pre-stream refusals arrive as a thrown AgentResponseError carrying
          // the pod's structured code (a transport-level saturation retry has
          // already happened and failed by the time one surfaces here). Any
          // other throw — a network drop, a host-adapter failure — has no wire
          // code, so the field stays null beside the message.
          setErrorCode(e instanceof AgentResponseError ? (e.code ?? null) : null);
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

  return {
    messages,
    send,
    status,
    activeTool,
    error,
    errorCode,
    threadId,
    abort,
    reset,
    reduceResult,
    historyCards,
    profileLinkRequest,
    clearProfileLinkRequest,
    aborted,
    adopted,
    sendStates,
  };
}
