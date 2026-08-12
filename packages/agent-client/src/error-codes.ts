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
  /** The turn ran past the pod's wall-clock budget. */
  TIMEOUT: "TIMEOUT",
  /** A guuey-side dependency failed (not the agent's own code). */
  PLATFORM_ERROR: "PLATFORM_ERROR",
  /** Unclassified pod failure. */
  INTERNAL: "INTERNAL",
} as const;

/** One of the pod's wire codes — see {@link AGENT_ERROR_CODES}. */
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[keyof typeof AGENT_ERROR_CODES];
