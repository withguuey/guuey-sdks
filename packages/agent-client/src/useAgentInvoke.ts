/**
 * useAgentInvoke — the base-platform chat client.
 *
 * Speaks the nocode-runtime pod's Bedrock-style SSE contract (NOT the parked
 * ggui generative-UI protocol that `@ggui-ai/react`'s useInvoke targets):
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
import { parseConsentRequest, parseSseEvents, reduceAssistantText, stringField } from "./sse";
import { ingestMessageFrame } from "./blocks";
import type {
  AgentInvokeAdapters,
  AgentMessage,
  HistoryCard,
  HistoryLoadResult,
  ProfileConsentRequest,
  UseAgentInvokeOptions,
  UseAgentInvokeReturn,
} from "./types";

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
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const abortRef = useRef<AbortController | null>(null);
  // Mirror the latest threadId + adapters into refs so `send` reads fresh
  // values without depending on them (keeps the callback identity stable and
  // sidesteps the async-hydration race).
  const threadIdRef = useRef<string | null>(null);
  const adaptersRef = useRef<AgentInvokeAdapters>(opts.adapters);
  adaptersRef.current = opts.adapters;
  // The per-conversation AgJSON reducer (only built when `preserveBlocks`).
  // Lazily (re)created on the first valid AgEvent after a fresh start / reset,
  // so an off run never constructs one and a bypass run never allocates.
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
    setIsStreaming(false);
    // Fresh conversation → drop the old fold; the reducer is rebuilt lazily on
    // the next valid AgEvent. Persisted cards are re-seeded below from history.
    reducerRef.current = null;
    setReduceResult(null);
    setHistoryCards([]);
    // A prior app's consent ask must never leak into the new conversation.
    setProfileConsentRequest(null);

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
    setIsStreaming(false);
    // Re-create the reducer for the new conversation (rebuilt lazily on the
    // next valid AgEvent) and clear the exposed fold + any rehydrated cards.
    reducerRef.current = null;
    setReduceResult(null);
    setHistoryCards([]);
    setProfileConsentRequest(null);
  }, [appId]);

  const clearProfileConsentRequest = useCallback(() => {
    setProfileConsentRequest(null);
  }, []);

  const send = useCallback(
    async (input: string) => {
      if (!endpointUrl || !input.trim() || isStreaming) return;
      setError(null);
      setIsStreaming(true);
      setMessages((prev) => [...prev, { role: "user", text: input }, { role: "assistant", text: "" }]);

      const controller = new AbortController();
      abortRef.current = controller;
      const adapters = adaptersRef.current;
      // Wait for the persisted threadId to load before deciding whether to
      // replay it — otherwise a fast first send mints a new orphan thread and
      // clobbers the stored id. `hydrationRef` never rejects (it self-catches).
      if (hydrationRef.current) {
        await hydrationRef.current;
      }
      if (controller.signal.aborted) {
        setIsStreaming(false);
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
        // The endpointUrl may be a pod base (`https://host`) or the full
        // invoke URL the deploy-controller records (`https://host/agent/invoke`).
        // Normalize to exactly one `/agent/invoke`.
        const base = endpointUrl.replace(/\/+$/, "");
        const invokeUrl = base.endsWith("/agent/invoke") ? base : `${base}/agent/invoke`;
        const body = {
          input,
          ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
          clientMessageId: adapters.generateId(),
        };

        let buffer = "";
        for await (const chunk of adapters.transport({ url: invokeUrl, body, signal: controller.signal })) {
          buffer += chunk;
          const { events, rest } = parseSseEvents(buffer);
          buffer = rest;
          for (const ev of events) {
            if (ev.event === "session") {
              const tid = stringField(ev.data, "threadId");
              if (tid) {
                threadIdRef.current = tid;
                setThreadId(tid);
                void adapters.storage.save(threadStorageKey(appId), tid);
              }
            } else if (ev.event === "message") {
              renderAssistant(reduceAssistantText(assistantText, ev.data));
              // Additively fold the SAME frame into the AgJSON reducer when
              // opted in. The text surface above is untouched; only VALID
              // AgEvents advance the reducer (bypass frames ingest to [] and
              // leave `reduceResult` null — see the return-type contract).
              if (preserveBlocksRef.current) {
                const agEvents = ingestMessageFrame(ev.data);
                if (agEvents.length > 0) {
                  if (!reducerRef.current) reducerRef.current = new Reducer();
                  for (const agEvent of agEvents) reducerRef.current.push(agEvent);
                  setReduceResult(reducerRef.current.result());
                }
              }
            } else if (ev.event === "error") {
              setError(stringField(ev.data, "message") ?? "agent error");
            } else if (ev.event === "profile-consent-needed") {
              // Cross-app profile consent ask (T6). Only a well-formed payload
              // updates state; a malformed one is dropped, leaving any prior
              // valid request untouched (never clobbered to null).
              const parsed = parseConsentRequest(ev.data);
              if (parsed) setProfileConsentRequest(parsed);
            }
            // `done` needs no handling — the stream closes after it. Any other
            // (unknown) event falls through silently — there is no default
            // branch, so a consumer that never renders a field is unaffected.
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : "failed to reach agent");
        }
      } finally {
        setIsStreaming(false);
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
    [endpointUrl, appId, isStreaming],
  );

  return {
    messages,
    send,
    isStreaming,
    error,
    threadId,
    abort,
    reset,
    reduceResult,
    historyCards,
    profileConsentRequest,
    clearProfileConsentRequest,
  };
}
