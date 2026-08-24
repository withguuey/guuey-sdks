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
import type { AgHitlAnswer } from "@silverprotocol/core";
import type { AgentInvokeAdapters, InvokeTransport, ThreadIdStore } from "./types.js";
import { fetchThreadHistory, HistoryUnauthorizedError } from "./history.js";
import {
fetchStreamTransport, sendableGuestSecret, GUEST_HEADER } from "./transport.js";
import type { SaturationRetryOptions } from "./saturation-retry.js";
import { toInvokeUrl } from "./invoke-turn.js";

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

export interface CreateWebAdaptersOptions {
  /**
   * Public read-plane base (ending in `/v1`) for transcript history. When
   * omitted, no history adapter is installed and reloads start empty.
   */
  apiBaseUrl?: string;
  /**
   * Total send attempts on a saturated pod (guuey#406) — forwarded to
   * {@link SaturationRetryOptions.attempts}. End-user surfaces facing
   * capacity-1 pods (demo fixtures, xs plans) budget higher than the
   * 2-attempt default and pair it with {@link onSaturationWait} so the
   * wait is a visible busy state.
   */
  saturationAttempts?: number;
  /** Forwarded to {@link SaturationRetryOptions.onSaturationWait}. */
  onSaturationWait?: SaturationRetryOptions["onSaturationWait"];
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
    // Both candidates go to the transport; it owns the precedence (and the
    // never-two-carriers rule) so there is exactly one place that decides.
    // The bearer goes through as the PROVIDER, not a pre-resolved value:
    // the transport re-asks it per attempt, so a cold-start retry after a
    // backoff wait re-reads a fresh token instead of replaying one that may
    // have expired during the wait (the same reason Portal's RN transport
    // resolves inside its generator).
    yield* fetchStreamTransport(req, null, getGuestSecret ? getGuestSecret() : null, {
      getBearer: getAccessToken,
      ...(opts.saturationAttempts !== undefined ? { attempts: opts.saturationAttempts } : {}),
      ...(opts.onSaturationWait !== undefined
        ? { onSaturationWait: opts.onSaturationWait }
        : {}),
    });
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
  /**
   * The pod base (or full invoke URL — same normalization as the invoke
   * transport). When set, the reader tries the POD door first
   * (`GET <base>/agent/ui-resource`, guuey#209 C1): the pod is the only
   * party that can vouch for a locator whose turn is still streaming —
   * persisted `kind:'card'` rows land at turn COMPLETION, so the platform
   * door 404s mid-turn by construction. Completed turns 404 on the pod
   * (past its grace window) and resolve on the platform door instead: one
   * authority per lifecycle phase, and this reader tries both in that
   * order. Absent → platform door only (pre-#209 behavior) — which means
   * **a card produced mid-turn cannot resolve until its turn completes**:
   * under a producer that inlines no mount material (any plain-locator MCP
   * server, ggui's read-plane-only posture) every fresh card renders
   * "expired" until reload. A live surface that holds an invoke endpoint
   * MUST pass it here; omitting it is only correct for a pure history
   * viewer with no pod (SelfHostedThreadViewer). The reader warns once at
   * construction when a platform door is configured without a pod door,
   * because the failure it prevents is silent by nature (guuey#209 /
   * ggui cac966a2d — both first external embeds shipped without it).
   */
  endpointUrl?: string | null;
  /** Signed-in bearer — wins over the guest secret (same rule as the transport). */
  getAccessToken?: (opts?: { forceRefresh?: boolean }) => Promise<string | null>;
  /** Caller-owned anonymous guest secret (widget / guest chat). */
  guestSecret?: string | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Warn once per module load — the misconfiguration is per-surface, not per-read. */
let readerEndpointWarned = false;
/** @internal test seam — the once-flag is module state; suites reset it between cases. */
export function __resetReaderEndpointWarning(): void {
  readerEndpointWarned = false;
}

/** `<pod base>/agent/ui-resource` from whatever endpoint shape the surface holds. */
function toUiResourceUrl(endpointUrl: string): string {
  return toInvokeUrl(endpointUrl).replace(/\/agent\/invoke$/, "/agent/ui-resource");
}

/** `<pod base>/agent/ui-action` — the live ACTION door (guuey#222), the read door's twin. */
function toUiActionUrl(endpointUrl: string): string {
  return toInvokeUrl(endpointUrl).replace(/\/agent\/invoke$/, "/agent/ui-action");
}

/** Warn once per module load — sibling of the reader's flag; per-surface, not per-click. */
let relayEndpointWarned = false;
/** @internal test seam — the once-flag is module state; suites reset it between cases. */
export function __resetRelayEndpointWarning(): void {
  relayEndpointWarned = false;
}

/**
 * Build a `UiResourceReader` over guuey's authenticated resources/read
 * doors — the pod door for LIVE turns (guuey#209 C1:
 * `GET <pod>/agent/ui-resource?uri=…`, when {@link CreateUiResourceReaderOptions.endpointUrl}
 * is set) and the platform proxy for persisted locators (guuey#122 Gap 1:
 * `GET /v1/threads/:threadId/ui-resource?uri=…`). Both doors answer the
 * same body and speak the same identity (bearer wins, guest header
 * otherwise — the pod's `resolveIdentity` and the proxy's identity chain
 * accept the identical carriers), so one parse serves both.
 *
 * This is `@guuey/mcp-apps-host`'s `createMcpUiResourceReader` assembly over
 * a guuey-platform transport (guuey#127) — channel resolution and payload
 * narrowing live in the host package; only the transport is guuey-shaped.
 * The doors own EVERYTHING trust-shaped: caller identity (the same three
 * families as the history read), tenancy (the pod's live-card ledger; the
 * proxy's thread-ownership + locator-to-thread scope guard), and the
 * per-user federation mint. This transport only carries the surface's
 * existing credential and maps EVERY non-OK — 401/403/404/502 alike — to
 * "try the next door", and a miss on the last door to `undefined`: deny is
 * byte-identical to a miss, and a miss renders the host's placeholder,
 * never an error surface.
 */
export function createUiResourceReader(
  options: CreateUiResourceReaderOptions,
): (
  resourceUri: string,
  hints?: { origin?: "live" | "history" },
) => Promise<ResolvedViewMount | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // A platform door without a pod door is almost always a live surface
  // that forgot `endpointUrl` — its cards would die silently for the whole
  // mid-turn window. `null` is the explicit "I am a history-only viewer,
  // there is no pod" opt-out; `undefined` is the forgotten case.
  if (options.endpointUrl === undefined && !readerEndpointWarned) {
    readerEndpointWarned = true;
    console.warn(
      "createUiResourceReader: no `endpointUrl` — cards produced mid-turn cannot resolve until the turn completes (the pod door is the only authority while a turn streams). Pass the surface's invoke endpoint, or `endpointUrl: null` to declare a history-only viewer.",
    );
  }

  /** One door: fetch + the history adapter's 401-forceRefresh recovery + parse. */
  const readDoor = async (requestUrl: string): Promise<McpResourceReadResult | undefined> => {
    // Exactly ONE identity carrier per read, the invoke transport's rule
    // (`streamInvokeOnce`): bearer → guest header → else cookie credentials,
    // which round-trip the HttpOnly `guuey_guest` cookie the pod mints for
    // anonymous browser callers. Without the third arm a cookie-mode guest
    // sent an identity-less read and every locator rendered as expired
    // (guuey#221). Never two at once: a request carrying either header does
    // NOT also send cookies.
    const headers: Record<string, string> = {};
    const init: RequestInit = { headers };
    const token = options.getAccessToken ? await options.getAccessToken() : null;
    const guest = sendableGuestSecret(options.guestSecret);
    if (token) {
      headers["authorization"] = `Bearer ${token}`;
    } else if (guest) {
      headers[GUEST_HEADER] = guest;
    } else {
      init.credentials = "include";
    }
    let res: Response;
    try {
      res = await fetchImpl(requestUrl, init);
    } catch {
      return undefined; // transport failure == miss (the next door may still answer)
    }
    // One forceRefresh retry on 401 with a bearer in play — the same
    // expired-but-refreshable recovery the history adapter performs;
    // without it a stale token degrades to a permanent placeholder. The
    // retry carries the fresh bearer and nothing else (same one-carrier rule).
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
    let body: { uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown; _meta?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return undefined;
    }
    // Both doors pass the blob arm through (a blob-only resource is not
    // silently a miss — the route contract); mirror that here.
    if (typeof body.uri !== "string") return undefined;
    if (typeof body.text !== "string" && typeof body.blob !== "string") return undefined;
    return {
      uri: body.uri,
      ...(typeof body.mimeType === "string" ? { mimeType: body.mimeType } : {}),
      ...(typeof body.text === "string" ? { text: body.text } : {}),
      ...(typeof body.blob === "string" ? { blob: body.blob } : {}),
      // guuey#312: forward the entry's `_meta` untouched — the per-resource
      // CSP declaration (`_meta.ui.csp`) is narrowed by the assembly's
      // schema-validated door (`declaredResourceCsp`), never here. Routes
      // that don't forward `_meta` yet simply leave it absent (undeclared —
      // the secure default); this client is ready the day they do.
      ...(body._meta !== undefined ? { _meta: body._meta } : {}),
    };
  };

  const podUrl = options.endpointUrl ? toUiResourceUrl(options.endpointUrl) : null;
  const readResource = async (
    resourceUri: string,
    hints?: { origin?: "live" | "history" },
  ): Promise<McpResourceReadResult | undefined> => {
    const query = `?uri=${encodeURIComponent(resourceUri)}`;
    // guuey#421: a PERSISTED card's locator skips the pod door — pods serve
    // live turns only and 404 such reads by construction; the old
    // pod-first-always order fired a 404 pair on every old-conversation
    // load (noise that read as breakage in every capture).
    if (podUrl !== null && hints?.origin !== "history") {
      const live = await readDoor(`${podUrl}${query}`);
      if (live !== undefined) return live;
    }
    return readDoor(
      `${options.apiBaseUrl}/threads/${encodeURIComponent(options.threadId)}/ui-resource${query}`,
    );
  };
  return createMcpUiResourceReader({ readResource });
}

/** Options for {@link createUiActionRelay} — same credential surface as the reader. */
export interface CreateUiActionRelayOptions {
  /** The guuey public API base (`…/v1`). */
  apiBaseUrl: string;
  /** The thread whose persisted cards this relay may act for. */
  threadId: string;
  /**
   * The surface's invoke endpoint (pod base URL or full `/agent/invoke`
   * URL). When set, actions POST to the POD's live door first
   * (`POST <pod>/agent/ui-action`, guuey#222) — the only authority that
   * can relay a click for a card whose turn is still streaming (persisted
   * `kind:'card'` rows land at turn COMPLETION, so the platform door 404s
   * mid-turn by construction). A pod 404 (not live, or past the ledger's
   * grace window) falls through to the platform door; every other pod
   * answer is terminal for the same reason it would be on the platform
   * door. Absent → platform door only (pre-#222 behavior): **a click on a
   * card produced mid-turn cannot reach the agent until its turn
   * completes** — the exact "no moment where a click both resolves AND
   * finds a live consumer" defect. A live surface MUST pass it; omitting it
   * is only correct for a pure history viewer with no pod. The relay warns
   * once at construction when a platform door is configured without a pod
   * door (same guardrail as {@link createUiResourceReader}).
   */
  endpointUrl?: string | null;
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
  // A platform door without a pod door is almost always a live surface
  // that forgot `endpointUrl` — its cards' clicks would go nowhere for the
  // whole mid-turn window (guuey#222). `null` is the explicit "history-only
  // viewer, there is no pod" opt-out; `undefined` is the forgotten case.
  if (options.endpointUrl === undefined && !relayEndpointWarned) {
    relayEndpointWarned = true;
    console.warn(
      "createUiActionRelay: no `endpointUrl` — a click on a card produced mid-turn cannot reach the agent until the turn completes (the pod door is the only authority while a turn streams; post-turn clicks reach the platform door). Pass the surface's invoke endpoint, or `endpointUrl: null` to declare a history-only viewer.",
    );
  }

  /**
   * One door: POST + the reader's 401-forceRefresh recovery. Returns the
   * parsed result on 2xx, `"miss"` on 404 (the pod's "not live / not yours /
   * past grace" — deny==miss, so the NEXT door may still answer), and
   * `undefined` for every other failure (terminal: the host relay answers
   * in-band as an `isError` result, never a thrown error into the sandbox
   * bridge). A pod 502 UPSTREAM_UNAVAILABLE is a real failure, not a miss —
   * the persisted door cannot relay a mid-turn click either, so falling
   * through would only trade one honest error for a misleading 404.
   */
  const postDoor = async (
    requestUrl: string,
    body: string,
  ): Promise<{ kind: "result"; value: unknown } | "miss" | undefined> => {
    // Exactly ONE identity carrier per call — the reader's rule verbatim:
    // bearer → guest header → else cookie credentials (the HttpOnly
    // `guuey_guest` cookie the pod mints for anonymous browser callers).
    // Without the third arm a cookie-mode guest POSTed identity-less and
    // every click failed auth (the guuey#221 class, on the relay). A JSON
    // POST is always preflighted, so unlike the reader's GET this arm can
    // never be a CORS "simple request" — which is fine because both doors
    // answer a credentialed preflight: the pod echoes origin +
    // `Access-Control-Allow-Credentials` on OPTIONS and every status, and
    // the platform door's own OPTIONS branch does the same (guuey#224).
    const headers: Record<string, string> = { "content-type": "application/json" };
    const init: RequestInit = { method: "POST", headers, body };
    const token = options.getAccessToken ? await options.getAccessToken() : null;
    const guest = sendableGuestSecret(options.guestSecret);
    if (token) {
      headers["authorization"] = `Bearer ${token}`;
    } else if (guest) {
      headers[GUEST_HEADER] = guest;
    } else {
      init.credentials = "include";
    }
    let res: Response;
    try {
      res = await fetchImpl(requestUrl, init);
    } catch {
      return undefined; // transport failure — the host relay answers in-band
    }
    // One forceRefresh retry on 401 with a bearer in play — the same
    // expired-but-refreshable recovery the reader performs. The retry
    // carries the fresh bearer and nothing else (same one-carrier rule).
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
    if (res.status === 404) return "miss";
    if (!res.ok) return undefined;
    try {
      return { kind: "result", value: (await res.json()) as unknown };
    } catch {
      return undefined;
    }
  };

  const podUrl = options.endpointUrl ? toUiActionUrl(options.endpointUrl) : null;
  const callTool = async (
    uri: string,
    name: string,
    args: McpToolStructuredContent | undefined,
  ): Promise<unknown> => {
    // The kit sends only what the click carries; the pod overwrites any
    // sessionId/appId from the authorized locator + its own binding.
    const body = JSON.stringify({ uri, name, ...(args !== undefined ? { arguments: args } : {}) });
    if (podUrl !== null) {
      const live = await postDoor(podUrl, body);
      if (live === undefined) return undefined; // terminal on the pod — no fall-through
      if (live !== "miss") return live.value;
      // 404 → not live here (completed turn past grace, or never live):
      // the persisted door owns it.
    }
    const persisted = await postDoor(
      `${options.apiBaseUrl}/threads/${encodeURIComponent(options.threadId)}/ui-action`,
      body,
    );
    return persisted === undefined || persisted === "miss" ? undefined : persisted.value;
  };
  return createMcpUiActionRelay({ callTool });
}

/** `<pod base>/agent/hitl-answer` — the AgJSON HITL answer door (guuey#207). */
function toHitlAnswerUrl(endpointUrl: string): string {
  return toInvokeUrl(endpointUrl).replace(/\/agent\/invoke$/, "/agent/hitl-answer");
}

/** Options for {@link createHitlAnswerRelay} — the same credential surface as the card relays. */
export interface CreateHitlAnswerRelayOptions {
  /** The surface's invoke endpoint (pod base URL or full `/agent/invoke` URL) — the answer door lives on the pod. */
  endpointUrl: string;
  /** Signed-in bearer — wins over the guest secret (same rule as the transport). */
  getAccessToken?: (opts?: { forceRefresh?: boolean }) => Promise<string | null>;
  /** Caller-owned anonymous guest secret (widget / guest chat). */
  guestSecret?: string | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * The pod's answer to a delivered {@link AgHitlAnswer}. `ok` carries the
 * body the door returns (`askId`, echoed `status`, and — for a recorded
 * consent — the grant `mode` written); every non-2xx collapses to the pod's
 * `{ code, message }` envelope (the same vocabulary as `AGENT_ERROR_CODES`,
 * e.g. `NOT_FOUND` for an ask this pod did not mint, `INVALID_REQUEST` for a
 * spec-invalid answer) with the HTTP status; a transport failure is
 * `status: 0` with a null code.
 */
export type HitlAnswerRelayResult =
  | { ok: true; body: { askId: string; status: AgHitlAnswer["status"]; mode?: string } }
  | { ok: false; status: number; code: string | null; message: string };

/**
 * Build the client→pod channel for AgJSON HITL answers (guuey#207): `POST
 * <pod>/agent/hitl-answer` with the spec {@link AgHitlAnswer} the kit's
 * `answerHitlPrompt` constructed (already validated against the ask's
 * persisted declaration). The pod owns EVERYTHING trust-shaped — caller
 * identity (the same three families as the invoke), which ask it minted,
 * the thread a `once` grant binds to, the access level written — this
 * transport only carries the surface's existing credential under the
 * one-carrier rule (bearer → guest header → cookie), with the card relays'
 * single 401 forceRefresh retry.
 *
 * Today the only producer is the pod's cross-app profile consent ask (the
 * three-mode grant), whose answer resolves into the caller's own
 * `ProfileGrant` row; the channel is generic by construction — any future
 * `hitl.ask` the runtime emits is answered through this same door.
 */
export function createHitlAnswerRelay(
  options: CreateHitlAnswerRelayOptions,
): (answer: AgHitlAnswer) => Promise<HitlAnswerRelayResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = toHitlAnswerUrl(options.endpointUrl);
  return async (answer) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const body = JSON.stringify(answer);
    const init: RequestInit = { method: "POST", headers, body };
    const token = options.getAccessToken ? await options.getAccessToken() : null;
    const guest = sendableGuestSecret(options.guestSecret);
    if (token) {
      headers["authorization"] = `Bearer ${token}`;
    } else if (guest) {
      headers[GUEST_HEADER] = guest;
    } else {
      init.credentials = "include";
    }
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      return { ok: false, status: 0, code: null, message: err instanceof Error ? err.message : String(err) };
    }
    if (res.status === 401 && options.getAccessToken) {
      const fresh = await options.getAccessToken({ forceRefresh: true }).catch(() => null);
      if (fresh) {
        try {
          res = await fetchImpl(url, {
            method: "POST",
            headers: { ...headers, authorization: `Bearer ${fresh}` },
            body,
          });
        } catch (err) {
          return { ok: false, status: 0, code: null, message: err instanceof Error ? err.message : String(err) };
        }
      }
    }
    let parsed: unknown = undefined;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    if (res.ok) {
      const b = (parsed ?? {}) as { askId?: unknown; status?: unknown; mode?: unknown };
      return {
        ok: true,
        body: {
          askId: typeof b.askId === "string" ? b.askId : answer.askId,
          status: b.status === "resolved" || b.status === "declined" || b.status === "cancelled" ? b.status : answer.status,
          ...(typeof b.mode === "string" ? { mode: b.mode } : {}),
        },
      };
    }
    const env = (parsed ?? {}) as { code?: unknown; message?: unknown };
    return {
      ok: false,
      status: res.status,
      code: typeof env.code === "string" ? env.code : null,
      message: typeof env.message === "string" ? env.message : `hitl-answer failed (${res.status})`,
    };
  };
}
