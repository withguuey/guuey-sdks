/**
 * Web (browser / Next.js) host adapters for {@link useAgentInvoke}.
 *
 * Studio builds its bundle via {@link createWebAdapters}. The implementations
 * touch `window.localStorage`, `crypto`, and `fetch` only inside their
 * functions — never at module load — so this file is import-safe under SSR
 * (the functions guard on `typeof window`).
 */
import {
  createMcpUiActionRelay,
  createMcpUiResourceReader,
  type McpResourceReadResult,
  type McpToolCallResult,
  type McpToolStructuredContent,
  type ResolvedViewMount,
  type UiActionRequest,
} from "@guuey/mcp-apps-host";
import type {
  AgentInvokeAdapters,
  InvokeRequest,
  InvokeTransport,
  ThreadIdStore,
} from "./types";
import { fetchThreadHistory, HistoryUnauthorizedError } from "./history";

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
 * Header carrying a caller-owned anonymous guest secret. A LOCAL MIRROR of the
 * two server-side constants — the pod's `GUEST_HEADER_NAME`
 * (`backend/services/nocode-runtime/src/identity.ts`) and the read plane's
 * `GUEST_HEADER` (`backend/amplify/functions/publicApi/identity.ts`) — because
 * this is a published npm package and cannot take a `@guuey-private` dep (same
 * arrangement as `@guuey/host`'s mirrored fs-contract constants). The string is
 * a wire contract: both planes already advertise it in
 * `Access-Control-Allow-Headers`, so changing it is a breaking protocol change,
 * not a rename.
 */
const GUEST_HEADER = "x-guuey-guest";

/**
 * A well-formed guest secret: exactly 32 bytes as 64 LOWERCASE hex chars —
 * the shape `crypto.getRandomValues` + hex-encoding mints.
 *
 * Deliberately stricter than the server's `/^[a-f0-9]{64}$/i` (pod
 * `identity.ts`, publicApi `identity.ts`): both sides lowercase before
 * hashing, so an uppercase secret would in fact be accepted, but the only
 * supported mint path emits lowercase and a non-canonical value means the
 * caller's storage is not what this adapter expects. Anything that fails is
 * IGNORED — the request falls through to cookie mode rather than sending a
 * secret the two identity planes might key differently.
 */
const GUEST_SECRET_RE = /^[0-9a-f]{64}$/;

/**
 * Narrow a caller-supplied guest secret to a value that is safe to put on the
 * wire, or `null`. The single gate for the header: every write of
 * {@link GUEST_HEADER} in this module goes through it, so a malformed secret
 * can never reach a request. The value is never logged (here or anywhere on
 * this path) — it IS the anonymous identity, so a leak is an impersonation.
 */
function sendableGuestSecret(secret: string | null | undefined): string | null {
  return typeof secret === "string" && GUEST_SECRET_RE.test(secret) ? secret : null;
}

/**
 * Web SSE transport. Exactly ONE identity carrier per request, in order:
 *
 *  1. `accessToken` → `Authorization: Bearer` — the pod identifies the caller
 *     by their verified access token (the same identity the history read
 *     plane uses, so persisted threads round-trip on reload).
 *  2. a well-formed `guestSecret` → `x-guuey-guest` — the caller owns and
 *     persists its own anonymous secret. The path for hosts with no usable
 *     cookie jar: React-Native, and the embedded widget, whose third-party
 *     iframe cannot rely on the pod's cookie surviving browser partitioning.
 *     The pod never mints a cookie for a header client.
 *  3. neither → `credentials: "include"`, which round-trips the HttpOnly
 *     `guuey_guest` cookie the pod mints for anonymous browser callers.
 *
 * Never two at once: a bearer wins over a guest secret, and a request that
 * carries either header does NOT also send cookie credentials.
 *
 * Reads the body via `ReadableStream.getReader()` (browser).
 */
export async function* fetchStreamTransport(
  req: InvokeRequest,
  accessToken?: string | null,
  guestSecret?: string | null,
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
  const guest = sendableGuestSecret(guestSecret);
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  } else if (guest) {
    headers[GUEST_HEADER] = guest;
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
   * a token, identity falls to {@link getGuestSecret} (if supplied) and then
   * to the guest cookie.
   *
   * Called with `{ forceRefresh: true }` exactly once: when the history read
   * gets a 401 on a token this resolver already returned (a token cached
   * before the mount-time history read fired can be stale by the time it
   * runs — the same window the send path's own 401-retry closes). A resolver
   * that caches (Amplify's `fetchAuthSession` does, and so does the widget's
   * `createHostTokenProvider`) MUST bypass that cache for a forced call and
   * obtain a genuinely fresh token — returning the SAME stale value would
   * make the retry indistinguishable from not retrying at all. A resolver
   * with nothing fresher to offer returns `null`, and the read surfaces the
   * ORIGINAL 401 rather than replaying the value that just failed.
   */
  getAccessToken?: (opts?: { forceRefresh?: boolean }) => Promise<string | null>;
  /**
   * Resolve the caller's own persisted anonymous guest secret (64 lowercase
   * hex chars), or `null` when there is none. Supply this on hosts whose
   * cookie jar can't carry the pod's HttpOnly `guuey_guest` — notably the
   * embedded widget, a third-party iframe whose cookies browsers partition
   * or block outright.
   *
   * With a secret, BOTH the chat transport and the history read send
   * `x-guuey-guest`, so an anonymous transcript replays on reload the same
   * way a signed-in one does — the read plane identifies a guest by that
   * header (it cannot see the HttpOnly cookie, which is why a cookie-only
   * caller still gets no history).
   *
   * Called once per request, so a rotated secret takes effect immediately.
   * A value that isn't 64 lowercase hex is ignored (never sent) and the
   * request falls through to cookie mode.
   *
   * **Supply at most ONE identity resolver per mode.** Anonymous hosts pass
   * this one; identified hosts pass {@link getAccessToken} and surface a token
   * failure rather than continuing. Passing BOTH is a hazard, not a fallback
   * chain: `getAccessToken` resolving `null` is indistinguishable here from
   * "signed out on purpose", so a merely *expired or unavailable* token
   * silently downgrades the caller to the anonymous identity. The request then
   * SUCCEEDS — the pod accepts anonymous invokes unconditionally — but the
   * turns land in a different thread (the pod forks on an owner mismatch
   * rather than appending), unreachable from the identified session, which
   * gets its own transcript back minus those turns on the next good load. A
   * 401-then-re-request-token retry loop is exactly this window.
   *
   * MUST be synchronous and MUST NOT throw: a throw propagates and fails the
   * invoke. This is a real hazard for the widget, not a formality —
   * `localStorage` access raises `SecurityError` in a third-party iframe with
   * storage blocked (Safari's default for embedded content), which is normal
   * operation here. A host reading storage owns that handling and MUST return
   * `null` on a blocked read, the way {@link localStorageThreadStore} does for
   * the threadId; `null` degrades to cookie mode, whereas a throw takes the
   * chat down. Deliberately NOT caught at this seam: catching a host-supplied
   * callback would also swallow ordinary host bugs into a silent anonymous
   * downgrade — the same failure this docblock warns about above.
   */
  getGuestSecret?: () => string | null;
}

/**
 * Build the web host-adapter bundle for {@link useAgentInvoke}. Pass an
 * access-token resolver and/or a guest-secret resolver (plus the read-plane
 * base) to give the chat transport an identity the read plane can also see,
 * which is what enables transcript restore on reload; omit both for a
 * cookie-only, history-less bundle.
 */
export function createWebAdapters(
  opts: CreateWebAdaptersOptions = {},
): AgentInvokeAdapters {
  const { apiBaseUrl, getAccessToken, getGuestSecret } = opts;

  const transport: InvokeTransport = async function* (req) {
    const token = getAccessToken ? await getAccessToken() : null;
    // Both candidates go to the transport; it owns the precedence (and the
    // never-two-carriers rule) so there is exactly one place that decides.
    yield* fetchStreamTransport(req, token, getGuestSecret ? getGuestSecret() : null);
  };

  const adapters: AgentInvokeAdapters = {
    storage: localStorageThreadStore,
    generateId: webGenerateId,
    transport,
  };

  // History needs an identity the READ plane can resolve: a Bearer or the
  // `x-guuey-guest` header. Either resolver can supply one, so either one
  // installs the adapter; a cookie-only caller is unidentifiable there and
  // gets no adapter at all.
  if (apiBaseUrl && (getAccessToken || getGuestSecret)) {
    adapters.history = {
      load: async (threadId) => {
        // Same precedence, and the same one-carrier rule, as the transport:
        // a bearer wins over the guest header, and the two never combine.
        if (getAccessToken) {
          const token = await getAccessToken();
          if (token) {
            try {
              return await fetchThreadHistory({
                baseUrl: apiBaseUrl,
                threadId,
                includeCards: true,
                requestInit: { headers: { Authorization: `Bearer ${token}` } },
              });
            } catch (err) {
              if (!(err instanceof HistoryUnauthorizedError)) throw err;
              // The one retry the send path already gets on a 401
              // (`withIdentifiedToken`): this read runs from a mount effect,
              // before the send path has asked anyone for anything, so a
              // token cached earlier can be the exact stale value that just
              // failed. `forceRefresh` is the signal that asks past whatever
              // cache the resolver keeps instead of returning that same dead
              // value.
              const fresh = await getAccessToken({ forceRefresh: true });
              if (!fresh) throw err; // nothing fresher to retry with — the ORIGINAL 401 is the honest cause
              return fetchThreadHistory({
                baseUrl: apiBaseUrl,
                threadId,
                includeCards: true,
                requestInit: { headers: { Authorization: `Bearer ${fresh}` } },
              });
            }
          }
        }
        const guest = sendableGuestSecret(getGuestSecret?.());
        if (guest) {
          return fetchThreadHistory({
            baseUrl: apiBaseUrl,
            threadId,
            includeCards: true,
            requestInit: { headers: { [GUEST_HEADER]: guest } },
          });
        }
        // No readable identity → leave the chat empty (skip) rather than
        // `gone`, which would clear the persisted threadId.
        return { messages: [] };
      },
    };
  }

  return adapters;
}

/** Options for {@link createUiResourceReader} — same credential surface as the history adapter. */
export interface CreateUiResourceReaderOptions {
  /** The guuey public API base (`…/v1`). */
  apiBaseUrl: string;
  /** The thread whose persisted locators this reader may resolve. */
  threadId: string;
  /** Signed-in bearer — wins over the guest secret (same rule as the transport). */
  getAccessToken?: (opts?: { forceRefresh?: boolean }) => Promise<string | null>;
  /** Caller-owned anonymous guest secret (widget / guest chat). */
  guestSecret?: string | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Build a `UiResourceReader` over guuey's authenticated resources/read proxy
 * (guuey#122 Gap 1: `GET /v1/threads/:threadId/ui-resource?uri=…`).
 *
 * This is `@guuey/mcp-apps-host`'s `createMcpUiResourceReader` assembly over
 * a guuey-platform transport (guuey#127) — channel resolution and payload
 * narrowing live in the host package; only the transport is guuey-shaped.
 * The proxy owns EVERYTHING trust-shaped: caller identity (the same three
 * families as the history read), thread ownership, the locator-to-thread
 * scope guard, and the per-user federation mint. This transport only carries
 * the surface's existing credential and maps EVERY non-OK — 401/403/404/502
 * alike — to `undefined`: deny is byte-identical to a miss, and a miss
 * renders the host's placeholder, never an error surface.
 */
export function createUiResourceReader(
  options: CreateUiResourceReaderOptions,
): (resourceUri: string) => Promise<ResolvedViewMount | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const readResource = async (resourceUri: string): Promise<McpResourceReadResult | undefined> => {
    const headers: Record<string, string> = {};
    const token = options.getAccessToken ? await options.getAccessToken() : null;
    const guest = sendableGuestSecret(options.guestSecret);
    if (token) {
      headers["authorization"] = `Bearer ${token}`;
    } else if (guest) {
      headers[GUEST_HEADER] = guest;
    }
    const requestUrl = `${options.apiBaseUrl}/threads/${encodeURIComponent(options.threadId)}/ui-resource?uri=${encodeURIComponent(resourceUri)}`;
    let res: Response;
    try {
      res = await fetchImpl(requestUrl, { headers });
    } catch {
      return undefined; // transport failure == miss == placeholder
    }
    // One forceRefresh retry on 401 with a bearer in play — the same
    // expired-but-refreshable recovery the history adapter performs;
    // without it a stale token degrades to a permanent placeholder.
    if (res.status === 401 && options.getAccessToken) {
      const fresh = await options.getAccessToken({ forceRefresh: true }).catch(() => null);
      if (fresh) {
        try {
          res = await fetchImpl(requestUrl, {
            headers: { ...headers, authorization: `Bearer ${fresh}` },
          });
        } catch {
          return undefined;
        }
      }
    }
    if (!res.ok) return undefined;
    let body: { uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return undefined;
    }
    // The proxy passes the blob arm through (a blob-only resource is not
    // silently a miss — its route contract); mirror that here.
    if (typeof body.uri !== "string") return undefined;
    if (typeof body.text !== "string" && typeof body.blob !== "string") return undefined;
    return {
      uri: body.uri,
      ...(typeof body.mimeType === "string" ? { mimeType: body.mimeType } : {}),
      ...(typeof body.text === "string" ? { text: body.text } : {}),
      ...(typeof body.blob === "string" ? { blob: body.blob } : {}),
    };
  };
  return createMcpUiResourceReader({ readResource });
}

/** Options for {@link createUiActionRelay} — same credential surface as the reader. */
export interface CreateUiActionRelayOptions {
  /** The guuey public API base (`…/v1`). */
  apiBaseUrl: string;
  /** The thread whose persisted cards this relay may act for. */
  threadId: string;
  /** Signed-in bearer — wins over the guest secret (same rule as the transport). */
  getAccessToken?: (opts?: { forceRefresh?: boolean }) => Promise<string | null>;
  /** Caller-owned anonymous guest secret (widget / guest chat). */
  guestSecret?: string | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Build the card action relay over guuey's authenticated `tools/call` proxy
 * (guuey#158: `POST /v1/threads/:threadId/ui-action`) — the mirror of
 * {@link createUiResourceReader}. Allowlisting, arm narrowing, and the
 * never-reject contract live in `@guuey/mcp-apps-host`'s
 * `createMcpUiActionRelay`; only the transport is guuey-shaped. The proxy
 * owns EVERYTHING trust-shaped (identity, thread ownership, the
 * locator-to-thread guard, its own server-side allowlist, the per-user
 * federation mint) — and every non-OK here collapses to `undefined`, which
 * the host relay answers in-band as an `isError` result, never a thrown
 * error into the sandbox bridge.
 */
export function createUiActionRelay(
  options: CreateUiActionRelayOptions,
): (request: UiActionRequest) => Promise<McpToolCallResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const callTool = async (
    uri: string,
    name: string,
    args: McpToolStructuredContent | undefined,
  ): Promise<unknown> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = options.getAccessToken ? await options.getAccessToken() : null;
    const guest = sendableGuestSecret(options.guestSecret);
    if (token) {
      headers["authorization"] = `Bearer ${token}`;
    } else if (guest) {
      headers[GUEST_HEADER] = guest;
    }
    const requestUrl = `${options.apiBaseUrl}/threads/${encodeURIComponent(options.threadId)}/ui-action`;
    const body = JSON.stringify({ uri, name, ...(args !== undefined ? { arguments: args } : {}) });
    let res: Response;
    try {
      res = await fetchImpl(requestUrl, { method: "POST", headers, body });
    } catch {
      return undefined; // transport failure — the host relay answers in-band
    }
    // One forceRefresh retry on 401 with a bearer in play — the same
    // expired-but-refreshable recovery the reader performs.
    if (res.status === 401 && options.getAccessToken) {
      const fresh = await options.getAccessToken({ forceRefresh: true }).catch(() => null);
      if (fresh) {
        try {
          res = await fetchImpl(requestUrl, {
            method: "POST",
            headers: { ...headers, authorization: `Bearer ${fresh}` },
            body,
          });
        } catch {
          return undefined;
        }
      }
    }
    if (!res.ok) return undefined;
    try {
      return (await res.json()) as unknown;
    } catch {
      return undefined;
    }
  };
  return createMcpUiActionRelay({ callTool });
}
