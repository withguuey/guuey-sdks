/**
 * useAgentInvoke — the base-platform chat client.
 *
 * Speaks the nocode-runtime pod's Bedrock-style SSE contract (NOT the parked
 * ggui generative-UI protocol that `@ggui-ai/mcp-apps-react`'s useInvoke targets):
 *
 *   POST {endpointUrl}/agent/invoke
 *     body: { input, threadId?, clientMessageId }
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
import { Reducer, type AgReduceResult } from "@silverprotocol/core";
import { invokeTurn, toInvokeUrl } from "./invoke-turn.js";
import { AgentResponseError } from "./errors.js";
import type {
  AgentInvokeAdapters,
  AgentInvokeStatus,
  AgentMessage,
  HistoryCard,
  HistoryLoadResult,
  ProfileConsentRequest,
  ProfileLinkRequest,
  UseAgentInvokeOptions,
  UseAgentInvokeReturn,
} from "./types.js";

function threadStorageKey(appId: string | undefined): string {
  return `guuey:thread:${appId ?? "default"}`;
}

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
  // The pod's latest cross-app profile consent ask on this conversation (T6's
  // `profile-consent-needed` SSE event), or null. Cleared on app switch /
  // reset / explicit dismiss. Consumers with no consent UI just ignore it.
  const [profileConsentRequest, setProfileConsentRequest] = useState<ProfileConsentRequest | null>(null);
  // The pod's latest cross-app profile LINK invite on this conversation (T3's
  // `profile-link-needed` SSE event), or null. Cleared on app switch / reset /
  // explicit dismiss, same lifecycle as `profileConsentRequest` — the two are
  // independent (an unlinked-invite vs an already-linked consent ask).
  const [profileLinkRequest, setProfileLinkRequest] = useState<ProfileLinkRequest | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // Mirror the latest threadId + adapters into refs so `send` reads fresh
  // values without depending on them (keeps the callback identity stable and
  // sidesteps the async-hydration race).
  const threadIdRef = useRef<string | null>(null);
  const adaptersRef = useRef<AgentInvokeAdapters>(opts.adapters);
  adaptersRef.current = opts.adapters;
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
    // A prior app's consent ask must never leak into the new conversation.
    setProfileConsentRequest(null);
    setProfileLinkRequest(null);

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
      } catch {
        return; // best-effort: offline / transient — chat continues without history
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
    setProfileConsentRequest(null);
    setProfileLinkRequest(null);
  }, [appId]);

  const clearProfileConsentRequest = useCallback(() => {
    setProfileConsentRequest(null);
  }, []);

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
      setStatus("connecting");
      setMessages((prev) => [...prev, { role: "user", text: input }, { role: "assistant", text: "" }]);

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

      try {
        const invokeUrl = toInvokeUrl(endpointUrl);
        const body = {
          input,
          ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
          clientMessageId: adapters.generateId(),
        };

        // The wire walk lives in `invokeTurn` (the pure per-turn generator —
        // its docblock owns the switch semantics); this hook only maps each
        // semantic event onto React state.
        for await (const ev of invokeTurn(
          { url: invokeUrl, body, signal: controller.signal },
          adapters.transport,
        )) {
          if (ev.kind === "session") {
            // The pod is awake and the turn is admitted — 'connecting' ends
            // here.
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
          } else if (ev.kind === "profile-consent") {
            setProfileConsentRequest(ev.request);
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
        }
      } finally {
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
    profileConsentRequest,
    clearProfileConsentRequest,
    profileLinkRequest,
    clearProfileLinkRequest,
  };
}
