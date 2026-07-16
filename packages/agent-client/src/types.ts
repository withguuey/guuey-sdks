/**
 * Public types for the base-platform chat client.
 *
 * The hook's behaviour is platform-agnostic; its three host couplings —
 * thread-id storage, client-message-id generation, and the network transport
 * (which also carries anonymous identity) — are INJECTED by the consumer via
 * {@link AgentInvokeAdapters}. Web (Studio) passes localStorage / crypto /
 * credentialed-cookie fetch; React-Native (Portal) passes AsyncStorage /
 * getRandomValues / header-identity SSE fetch. This mirrors the ggui
 * `MessageStorageAdapter` injection pattern.
 */

import type { AgReduceResult } from "@silverprotocol/core";

/** A flat chat turn as rendered by the consumer UI. */
export interface AgentMessage {
  role: "user" | "assistant";
  text: string;
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
 * the hook never sees cookies or bearer tokens.
 */
export type InvokeTransport = (req: InvokeRequest) => AsyncIterable<string>;

/** The persisted transcript for a thread, or a signal that it no longer exists. */
export type HistoryLoadResult = { messages: AgentMessage[] } | { gone: true };

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

export interface UseAgentInvokeReturn {
  messages: AgentMessage[];
  send: (input: string) => Promise<void>;
  isStreaming: boolean;
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
   * it (Task 4).
   */
  reduceResult: AgReduceResult | null;
}
