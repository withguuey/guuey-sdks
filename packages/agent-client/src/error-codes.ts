/**
 * The pod's error-envelope wire codes, TRANSCRIBED.
 *
 * The source of truth is the runtime's own private module
 * (`backend/services/nocode-runtime/src/error-codes.ts`). This package is
 * published to npm and cannot take a `@guuey-private` dependency, so it keeps
 * its own copy — the same arrangement as {@link GUEST_HEADER} in
 * `./web-adapters.ts` and `@guuey/host`'s mirrored fs-contract constants. The
 * copies are not trusted to prose alone: `agent-client-codes.sync.test.ts` in
 * the runtime package (which can import BOTH) asserts they stay identical, so
 * renaming a code on either side fails that test rather than silently breaking
 * a client branch.
 *
 * WIRE CONTRACT (what these codes appear in):
 *
 *  - a pre-stream refusal — `{ "code": …, "message": … }` with an HTTP status,
 *    parsed into {@link AgentResponseError};
 *  - an in-band failure — `event: error` / `data: { code, message }`, surfaced
 *    as `useAgentInvoke`'s `errorCode`.
 *
 * Both channels carry the SAME vocabulary, which is why one mirror serves them.
 */
export const AGENT_ERROR_CODES = {
  /** No usable identity on a surface that requires one. */
  UNAUTHORIZED: "UNAUTHORIZED",
  /** The invoke body did not parse / validate. */
  INVALID_REQUEST: "INVALID_REQUEST",
  /** The builder turned anonymous access off for this agent. */
  GUEST_ACCESS_DISABLED: "GUEST_ACCESS_DISABLED",
  /**
   * The agent's own definition declares `auth: 'required'` and the caller is
   * anonymous — sign in and retry with a bearer. The snapshot-declared twin of
   * {@link AGENT_ERROR_CODES.GUEST_ACCESS_DISABLED} (the app-record runtime
   * override); either gate can refuse.
   */
  AUTH_REQUIRED: "AUTH_REQUIRED",
  /** The caller (or the app) is out of plan allowance — the upgrade prompt. */
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  /** The app hit its builder-set managed spend cap. */
  MANAGED_SPEND_CAP: "MANAGED_SPEND_CAP",
  /**
   * The pod is at its concurrent-turn cap (scaling S1-F3). A 503 carrying a
   * `Retry-After` hint, and the ONE code {@link fetchStreamTransport} retries
   * by itself — see its docblock for the single-attempt rule.
   */
  POD_SATURATED: "POD_SATURATED",
  /**
   * The pod took SIGTERM and refuses NEW turns while in-flight ones finish.
   * Also a 503 + `Retry-After`, but deliberately NOT auto-retried (the
   * endpoint pull re-routes the next request; retrying into the same pod is
   * the one thing guaranteed not to help).
   */
  DRAINING: "DRAINING",
  /** Refused for this caller — e.g. the link-prompt dismiss route's byo-only rule. */
  FORBIDDEN: "FORBIDDEN",
  /**
   * The consent-answer door's deny==miss (guuey#207): the `AgHitlAnswer` names
   * an ask this pod did not mint (wrong app, a thread the caller does not
   * own, or a pod that takes no profile consent). Never an existence oracle.
   */
  NOT_FOUND: "NOT_FOUND",
  /** The turn ran past the pod's wall-clock budget. */
  TIMEOUT: "TIMEOUT",
  /** A guuey-side dependency failed (not the agent's own code). */
  PLATFORM_ERROR: "PLATFORM_ERROR",
  /** Unclassified pod failure. */
  INTERNAL: "INTERNAL",
} as const;

/** One of the pod's wire codes — see {@link AGENT_ERROR_CODES}. */
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[keyof typeof AGENT_ERROR_CODES];

/**
 * CLIENT-originated failure codes — minted by THIS SDK, never by the pod.
 *
 * Deliberately a SEPARATE constant from {@link AGENT_ERROR_CODES}: that
 * object is a transcribed mirror of the runtime's wire vocabulary, guarded by
 * the runtime-side `agent-client-codes.sync.test.ts` — adding a code the pod
 * never emits there would both break the sync guard and lie about the wire.
 * These codes surface through the SAME `errorCode` channel (it is a plain
 * `string` for exactly this kind of growth), so consumers branch the same
 * way; the split exists so each vocabulary keeps one honest owner.
 */
export const CLIENT_ERROR_CODES = {
  /**
   * The SSE stream went byte-silent mid-turn and bounded history probes never
   * found the finished reply (guuey#192's stall watchdog giving up). The turn
   * is over (`status` returns to `ready`); a retry or a reload may still find
   * the reply if the backend completes later.
   */
  STREAM_STALLED: "STREAM_STALLED",
  /**
   * A RESUMED thread's history read was refused (401 after the one
   * forceRefresh retry) — the persisted threadId exists but the CURRENT
   * identity cannot read it (guuey#413: the identity-drift face; an
   * expired-and-unrefreshable session is the benign sibling). Surfaced
   * LOUDLY instead of the silent fresh-looking boot: the transcript the
   * user expects exists and cannot be shown, which is an ERROR, not an
   * empty chat. Sends still work (the pod may fork a fresh thread) — the
   * error names why the history is missing.
   */
  THREAD_HISTORY_UNAVAILABLE: "THREAD_HISTORY_UNAVAILABLE",
} as const;

/** One of this SDK's client-originated codes — see {@link CLIENT_ERROR_CODES}. */
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[keyof typeof CLIENT_ERROR_CODES];
