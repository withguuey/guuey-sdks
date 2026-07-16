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
}
