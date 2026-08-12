/**
 * Error types the transports throw and the hook branches on.
 *
 * Its own module (rather than living in `./web-adapters.ts`) so `useAgentInvoke`
 * — which must stay platform-agnostic — can `instanceof`-narrow a caught error
 * without pulling the web adapter bundle (`fetch`, the history reader,
 * `@guuey/mcp-apps-host`) into a React-Native build.
 */

/**
 * Thrown when the pod returns a non-2xx status on `/agent/invoke` (before any
 * SSE stream opens). Carries the pod's structured `{ code, message }` when
 * present — e.g. a `QUOTA_EXCEEDED` 429 whose message ("…reached its plan
 * generation limit…") the chat UI should surface — falling back to the bare
 * status for non-JSON failures. See `AGENT_ERROR_CODES` for the vocabulary.
 */
export class AgentResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /**
     * The response's `Retry-After` hint in whole seconds, when it sent a
     * parseable one. The pod attaches it to its two 503 refusals
     * (`POD_SATURATED`, `DRAINING`) and exposes the header across origins via
     * `Access-Control-Expose-Headers`, so a browser client can actually read
     * it. `undefined` when the header was absent, malformed, or in the
     * HTTP-date form the pod never emits.
     */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AgentResponseError";
  }
}
