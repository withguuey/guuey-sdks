/**
 * Public types for the base-platform chat client.
 *
 * The hook's behaviour is platform-agnostic; its three host couplings —
 * thread-id storage, client-message-id generation, and the network transport
 * (which also carries anonymous identity) — are INJECTED by the consumer via
 * {@link AgentInvokeAdapters}. Web (Studio) passes localStorage / crypto /
 * credentialed-cookie fetch; React-Native (Portal) passes AsyncStorage /
 * getRandomValues / header-identity SSE fetch. Anonymous identity is per-host,
 * not per-platform: a web host with no usable cookie jar (an embedded
 * third-party iframe) carries its own guest secret in a header too — see
 * `createWebAdapters`'s `getGuestSecret`. This mirrors the ggui
 * `MessageStorageAdapter` injection pattern.
 */

import type { AgReduceResult, JsonValue } from "@silverprotocol/core";

/** A flat chat turn as rendered by the consumer UI. */
export interface AgentMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * A cross-app profile consent request surfaced mid-stream by the pod's
 * `profile-consent-needed` SSE event (nocode-runtime T6). Emitted when the
 * agent declares a profile intent the caller has NOT yet granted for this app,
 * so the consumer UI can prompt the user to authorize `read` or `read-write`
 * access. `requested` mirrors the pod's `ProfileAccess` posture verbatim; the
 * literal union is inlined rather than imported to keep this client SDK free of
 * any backend-package dependency.
 */
export interface ProfileConsentRequest {
  appId: string;
  requested: "read" | "read-write";
}

/**
 * A cross-app profile LINK invite surfaced mid-stream by the pod's
 * `profile-link-needed` SSE event (nocode-runtime linkcoh T3). Emitted when an
 * unlinked byo end-user's declared profile posture booted, inviting them to
 * link their guuey account (via the named `/link` ceremony) so they earn the
 * guuey-wide cross-app profile. `requested` mirrors the pod's `ProfileAccess`
 * posture verbatim (the builder's declared access, not a live ask) — the
 * literal union is inlined rather than imported, same rationale as
 * {@link ProfileConsentRequest}.
 */
export interface ProfileLinkRequest {
  appId: string;
  requested: "read" | "read-write";
}

/**
 * A persisted generative-UI card rehydrated from thread history — the verbatim
 * `AgArtifact` snapshot the pod stored on a `kind: "card"` row, tagged with its
 * transcript position. A block-preserving renderer interleaves these with
 * {@link AgentMessage}s (and the live {@link UseAgentInvokeReturn.reduceResult}
 * fold) by ascending `seq`. `cardSnapshot` is forwarded opaquely from the read
 * plane — the SDK does not re-parse it into AgEvents.
 */
export interface HistoryCard {
  seq: number;
  at: string;
  cardSnapshot: JsonValue;
}

/**
 * Persists the durable `threadId` per app so a reload continues the same
 * conversation. `load` may be sync (localStorage) or async (AsyncStorage).
 */
export interface ThreadIdStore {
  load(key: string): string | null | Promise<string | null>;
  save(key: string, threadId: string): void | Promise<void>;
}

/** Generates a fresh client-message id (idempotency key for B1 dedup). */
export type GenerateId = () => string;

/** One invoke request handed to the transport. */
export interface InvokeRequest {
  /** Fully-resolved POST target (already normalised to end in `/agent/invoke`). */
  url: string;
  /** JSON request body: `{ input, threadId?, clientMessageId }`. */
  body: unknown;
  /** Aborts the in-flight stream. */
  signal: AbortSignal;
}

/**
 * Opens an invoke request and yields decoded UTF-8 text chunks of the SSE
 * stream (the hook accumulates + parses frames itself). MUST throw on a
 * non-OK response or network failure. Owns headers + identity entirely, so
 * the hook never sees cookies, bearer tokens, or guest secrets.
 */
export type InvokeTransport = (req: InvokeRequest) => AsyncIterable<string>;

/**
 * The persisted transcript for a thread, or a signal that it no longer exists.
 *
 * `cards` is populated ONLY when the loader opts in (see
 * `fetchThreadHistory`'s `includeCards`); the default text-only mapping omits
 * it so existing text-only consumers (portal-native) are unaffected. When
 * present it carries the thread's persisted {@link HistoryCard}s for a
 * block-preserving renderer to interleave by `seq`.
 */
export type HistoryLoadResult =
  | { messages: AgentMessage[]; cards?: HistoryCard[] }
  | { gone: true };

/**
 * Optional seam for rehydrating a chat transcript from a server-side read
 * after the persisted `threadId` hydrates (see `useAgentInvoke`'s mount
 * effect). Best-effort: a rejected `load` is logged and skipped, never
 * blocks chat.
 */
export interface AgentInvokeHistoryAdapter {
  /** Fetch the persisted transcript for a thread. `gone` = 403/404 (stale local id). */
  load(threadId: string): Promise<HistoryLoadResult>;
}

/** The host couplings the hook needs, injected by the consumer. */
export interface AgentInvokeAdapters {
  storage: ThreadIdStore;
  generateId: GenerateId;
  transport: InvokeTransport;
  /** Optional: rehydrate the transcript for a hydrated threadId. See {@link AgentInvokeHistoryAdapter}. */
  history?: AgentInvokeHistoryAdapter;
}

export interface UseAgentInvokeOptions {
  /** Pod base URL (with or without a trailing `/agent/invoke`). Chat is disabled when null. */
  endpointUrl: string | null;
  /** Owning app id — namespaces the persisted threadId. */
  appId?: string;
  /** Platform host couplings (storage / crypto / transport). */
  adapters: AgentInvokeAdapters;
  /**
   * Opt-in: ALSO fold the full AgJSON (silver-mode) stream into a
   * block-preserving transcript exposed as {@link UseAgentInvokeReturn.reduceResult},
   * alongside the always-on flat text surface. Off by default; when off the
   * reducer is never constructed and the text behaviour is byte-identical.
   */
  preserveBlocks?: boolean;
}

/**
 * The per-turn lifecycle (guuey#91), derived ENTIRELY from frames the pod
 * already emits — no protocol addition:
 *
 *  - `ready`      — no turn in flight (initial, after `done`/failure/abort).
 *  - `connecting` — `send()` fired, no `session` frame yet. With
 *    scale-to-zero pods this phase can span a cold start, so hosts typically
 *    swap to "waking your agent" copy after a few seconds.
 *  - `thinking`   — the pod is awake and the turn is running, but no text is
 *    flowing and no tool is announced (between `session` and the first
 *    content, and between a `tool.done` and whatever follows it).
 *  - `using-tool` — a `tool.start` frame arrived; {@link UseAgentInvokeReturn.activeTool}
 *    carries the wire tool name until the matching `tool.done`.
 *  - `responding` — assistant text is arriving (`text.start`/`text.delta`
 *    silver frames, or bypass text/assistant frames).
 *
 * Failure keeps its own channel ({@link UseAgentInvokeReturn.error}) — there
 * is deliberately no `error` status: after any terminal outcome the status
 * returns to `ready` so the composer re-enables.
 */
export type AgentInvokeStatus = "ready" | "connecting" | "thinking" | "using-tool" | "responding";

export interface UseAgentInvokeReturn {
  messages: AgentMessage[];
  send: (input: string) => Promise<void>;
  /** The per-turn lifecycle — see {@link AgentInvokeStatus}. Anything other
   *  than `ready` means a turn is in flight (the old `isStreaming === true`). */
  status: AgentInvokeStatus;
  /** The active tool's wire name while `status === 'using-tool'`, else null. */
  activeTool: string | null;
  error: string | null;
  threadId: string | null;
  /** Abort the in-flight turn (the stream stops; partial text is kept). */
  abort: () => void;
  reset: () => void;
  /**
   * The folded AgJSON transcript, or `null`.
   *
   * Contract — **null-until-first-valid-AgEvent** (the documented choice for
   * the ambiguous "which protocol?" case; see {@link UseAgentInvokeOptions.preserveBlocks}):
   *
   *  - `null` whenever `preserveBlocks` is off (the reducer is never built);
   *  - when `preserveBlocks` is on, `null` UNTIL the per-conversation `Reducer`
   *    has folded at least one VALID AgEvent, then the reducer's live
   *    `result()` snapshot (a fresh object on each fold, so it re-renders).
   *
   * The hook cannot know a priori whether the pod is in silver or bypass mode.
   * In **bypass mode** the `message` frames are SDKMessage shapes that never
   * validate as AgEvents, so nothing folds and `reduceResult` stays `null` for
   * the whole conversation — the reducer only makes sense for silver AgJSON
   * frames. `reset()` returns it to `null`. History rehydrate does NOT populate
   * it — persisted cards surface via {@link historyCards} instead (Task 4), so
   * a snapshot never has to be lied back into the live reducer.
   */
  reduceResult: AgReduceResult | null;
  /**
   * Persisted generative-UI cards rehydrated from thread history, ascending by
   * `seq`. Empty (`[]`) unless the injected history adapter opted into cards
   * (`fetchThreadHistory({ includeCards: true })`) AND the rehydrate seeded a
   * transcript. Independent of {@link reduceResult}: `reduceResult` is the
   * LIVE turn's fold, `historyCards` is the persisted PRIOR turns' cards — a
   * block-preserving renderer interleaves both (and {@link messages}) by `seq`.
   * `reset()` clears it back to `[]`.
   */
  historyCards: HistoryCard[];
  /**
   * The latest cross-app profile consent request the pod asked for on THIS
   * conversation, or `null`. Set from a well-formed `profile-consent-needed`
   * SSE event (see {@link ProfileConsentRequest}); malformed payloads are
   * dropped and leave the field untouched. `reset()` and an app switch clear
   * it back to `null`. Consumers that never render a consent prompt (e.g.
   * Studio) simply ignore this field.
   */
  profileConsentRequest: ProfileConsentRequest | null;
  /** Dismiss the pending {@link profileConsentRequest} (back to `null`). */
  clearProfileConsentRequest: () => void;
  /**
   * The latest cross-app profile LINK invite the pod asked for on THIS
   * conversation, or `null`. Set from a well-formed `profile-link-needed`
   * SSE event (see {@link ProfileLinkRequest}); malformed payloads are
   * dropped and leave the field untouched. `reset()` and an app switch clear
   * it back to `null`. Consumers that never render a link prompt simply
   * ignore this field. Distinct from {@link profileConsentRequest}: this one
   * invites an UNLINKED byo user to link their account; consent asks an
   * already-linked user to grant an app read/read-write access.
   */
  profileLinkRequest: ProfileLinkRequest | null;
  /** Dismiss the pending {@link profileLinkRequest} (back to `null`). */
  clearProfileLinkRequest: () => void;
}
