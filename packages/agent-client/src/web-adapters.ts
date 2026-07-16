/**
 * Web (browser / Next.js) host adapters for {@link useAgentInvoke}.
 *
 * Studio builds its bundle via {@link createWebAdapters}. The implementations
 * touch `window.localStorage`, `crypto`, and `fetch` only inside their
 * functions — never at module load — so this file is import-safe under SSR
 * (the functions guard on `typeof window`).
 */
import type {
  AgentInvokeAdapters,
  InvokeRequest,
  InvokeTransport,
  ThreadIdStore,
} from "./types";
import { fetchThreadHistory } from "./history";

/**
 * Thrown when the pod returns a non-2xx status on `/agent/invoke` (before any
 * SSE stream opens). Carries the pod's structured `{ code, message }` when
 * present — e.g. a `QUOTA_EXCEEDED` 429 whose message ("…reached its plan
 * generation limit…") the chat UI should surface — falling back to the bare
 * status for non-JSON failures.
 */
export class AgentResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AgentResponseError";
  }
}

/** Persists the threadId in `window.localStorage` (synchronously). */
export const localStorageThreadStore: ThreadIdStore = {
  load(key) {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  save(key, threadId) {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, threadId);
    } catch {
      /* private mode / blocked storage — threadId stays in-memory only */
    }
  },
};

/** Crypto-strong client-message id, with a non-crypto fallback. */
export function webGenerateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `cmid-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Web SSE transport. When `accessToken` is present the pod identifies the
 * caller by their verified Cognito access token (the same identity the
 * history read plane uses, so persisted threads round-trip on reload).
 * Otherwise it falls back to `credentials: "include"`, which round-trips the
 * HttpOnly `guuey_guest` cookie the pod mints for anonymous browser callers.
 * Reads the body via `ReadableStream.getReader()` (browser).
 */
export async function* fetchStreamTransport(
  req: InvokeRequest,
  accessToken?: string | null,
): AsyncGenerator<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  const init: RequestInit = {
    method: "POST",
    signal: req.signal,
    headers,
    body: JSON.stringify(req.body),
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  } else {
    init.credentials = "include";
  }
  const resp = await fetch(req.url, init);
  if (!resp.ok || !resp.body) {
    // Surface a structured pod error ({ code, message }) when present — e.g. a
    // QUOTA_EXCEEDED 429 carries an upgrade message the UI should show. Fall
    // back to the bare status for non-JSON failures.
    const body: unknown = await resp.json().catch(() => null);
    let message = `agent responded ${resp.status}`;
    let code: string | undefined;
    if (body !== null && typeof body === "object") {
      if ("message" in body && typeof body.message === "string" && body.message) {
        message = body.message;
      }
      if ("code" in body && typeof body.code === "string") {
        code = body.code;
      }
    }
    throw new AgentResponseError(message, resp.status, code);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
}

export interface CreateWebAdaptersOptions {
  /**
   * Public read-plane base (ending in `/v1`) for transcript history. When
   * omitted, no history adapter is installed and reloads start empty.
   */
  apiBaseUrl?: string;
  /**
   * Resolve the caller's Cognito access token (fresh), or `null` when signed
   * out. When a token is present the chat transport AND the history read
   * authenticate as that user, so a reload restores the transcript. Without
   * a token the transport falls back to the guest cookie and history is
   * skipped — the read plane can't identify a cookie-only browser caller
   * (it reads the `x-guuey-guest` header or a Bearer, not the HttpOnly
   * guest cookie), so there is no identity to replay.
   */
  getAccessToken?: () => Promise<string | null>;
}

/**
 * Build the web host-adapter bundle for {@link useAgentInvoke}. Pass an
 * access-token resolver (and the read-plane base) to authenticate the chat
 * transport and enable transcript restore on reload; omit them for an
 * anonymous, history-less bundle.
 */
export function createWebAdapters(
  opts: CreateWebAdaptersOptions = {},
): AgentInvokeAdapters {
  const { apiBaseUrl, getAccessToken } = opts;

  const transport: InvokeTransport = async function* (req) {
    const token = getAccessToken ? await getAccessToken() : null;
    yield* fetchStreamTransport(req, token);
  };

  const adapters: AgentInvokeAdapters = {
    storage: localStorageThreadStore,
    generateId: webGenerateId,
    transport,
  };

  if (apiBaseUrl && getAccessToken) {
    adapters.history = {
      load: async (threadId) => {
        const token = await getAccessToken();
        // No readable identity → leave the chat empty (skip) rather than
        // `gone`, which would clear the persisted threadId.
        if (!token) return { messages: [] };
        return fetchThreadHistory({
          baseUrl: apiBaseUrl,
          threadId,
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        });
      },
    };
  }

  return adapters;
}
