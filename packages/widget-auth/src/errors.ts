/**
 * The error taxonomy for `@guuey/widget-auth`.
 *
 * Every failure is one of these, and every one of them is a subclass of
 * {@link WidgetAuthError} — so a caller that only wants "did minting fail?" needs
 * one `catch` clause, while a caller that wants to react differently to a bad
 * secret than to a transient outage can switch on the class.
 *
 * ## Two invariants this file exists to hold
 *
 * **1. A failure is never a token.** Every path here throws. There is no
 * "degraded" return value, no empty-string token, no partially-populated result:
 * a token handed to a browser is a bearer credential, and one minted from a
 * misread 500 response would be a credential nobody issued.
 *
 * **2. The app secret never reaches an error.** It is a server-side credential
 * whose entire value is that it exists in exactly one place, and an exception is
 * the most likely way for it to escape into a log aggregator. Errors therefore
 * carry only a status, a retryability flag and a message — and any message
 * sourced from outside this package (the service's response, a transport
 * error's text) is passed through {@link redactSecret} first, so the property
 * holds structurally rather than by trusting the other end.
 *
 * `cause` is attached with the `Error` options form deliberately: that makes it
 * non-enumerable, so a structured logger serializing the error cannot drag a
 * transport error's request dump — headers included — into the log line.
 *
 * **The honest bound on that claim.** It covers what this package constructs:
 * the message, the stack, and `JSON.stringify`. It does NOT cover
 * `console.error(err)`, which in Node prints the cause chain through
 * `util.inspect` and reaches the non-enumerable `cause` — so a `fetch`
 * implementation that puts the secret in its OWN error's message escapes
 * redaction by that path. Closing it means wrapping the cause in a redacted
 * copy, which costs the caller the original error object (`cause.code`,
 * `instanceof`); that trade is worth making deliberately rather than as a side
 * effect, so it is documented here and in the README instead of half-done.
 */

/** What a caller may do about a failure, without parsing messages. */
export abstract class WidgetAuthError extends Error {
  /**
   * The HTTP status the token service returned, or `undefined` when the request
   * never got that far (bad configuration, a transport failure).
   */
  readonly status: number | undefined;

  /**
   * Whether retrying the SAME call with backoff could plausibly succeed.
   *
   * `false` for anything the caller must change first — a wrong secret, an app
   * that is not wired to its issuer, a malformed request. Retrying those just
   * burns the shared rate-limit bucket.
   */
  readonly retryable: boolean;

  protected constructor(
    message: string,
    retryable: boolean,
    status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.retryable = retryable;
    this.status = status;
  }
}

/**
 * The call was wrong before it was ever sent — a missing or malformed `appId`,
 * `appSecret`, `apiBaseUrl`, `userId`, or a `ttlSeconds` outside `1..3600`.
 *
 * Thrown before any network call, so a configuration mistake costs nothing and
 * cannot be mistaken for a service outage.
 */
export class WidgetAuthConfigError extends WidgetAuthError {
  constructor(message: string) {
    super(message, false);
  }
}

/**
 * HTTP 401 — the app secret was not accepted.
 *
 * **Deliberately indistinguishable**: a wrong secret, a revoked key and an app
 * that was never enrolled all produce this one error, because the `appId` is
 * caller-supplied and anything finer would turn the route into an oracle for
 * which apps exist. So "which of the three is it?" is a question this error
 * cannot answer by design — check the secret first, then the key's status with
 * `guuey widget keys`.
 */
export class WidgetAuthCredentialError extends WidgetAuthError {
  constructor(message: string, status: number) {
    super(message, false, status);
  }
}

/**
 * HTTP 409 — the secret was accepted, but the app is not wired to its own widget
 * issuer, so a token minted here would be rejected by the app that received it.
 *
 * The message names the command that repairs it. A correctly-onboarded app never
 * reaches this: `guuey widget keys create --audience` wires the binding in the
 * same ceremony that mints the secret.
 */
export class WidgetAuthAppNotConfiguredError extends WidgetAuthError {
  constructor(message: string, status: number) {
    super(message, false, status);
  }
}

/**
 * HTTP 400 — the token service rejected the request body.
 *
 * This package validates every field the service validates, so in normal use
 * this is unreachable; seeing it means either a version skew between this
 * package and the deployed service, or a bug here. Either way it is not
 * something a retry fixes.
 */
export class WidgetAuthRequestError extends WidgetAuthError {
  constructor(message: string, status: number) {
    super(message, false, status);
  }
}

/**
 * The service failed, or answered with something this package cannot use — a
 * 5xx, an unexpected status, a body that is not JSON, or a 200 whose shape is
 * not a minted token.
 *
 * `retryable` is `true` only for 5xx. A 200 with an unusable body is NOT
 * retryable: the request succeeded and the answer was wrong, which a retry
 * reproduces.
 */
export class WidgetAuthServiceError extends WidgetAuthError {
  constructor(
    message: string,
    status: number | undefined,
    retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, retryable, status, options);
  }
}

/**
 * The request never reached the token service — DNS, TCP, TLS, a timeout, or an
 * aborted `AbortSignal`.
 *
 * The underlying error is attached as `cause` (non-enumerable, so it does not
 * land in a serialized log line) and its text is redacted into the message.
 */
export class WidgetAuthNetworkError extends WidgetAuthError {
  constructor(message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message, options?.retryable ?? true, undefined, options);
  }
}

/**
 * Was this transport failure the CALLER cancelling the request?
 *
 * A caller-initiated abort is the one transport failure that must not be
 * `retryable`: the integrator asked for this mint to stop, and a retry loop
 * keyed on `retryable` would re-issue the very call they abandoned — spending
 * a mint (and a rate-limit slot) against their own intent. Everything else
 * here — DNS, TCP, TLS, a timeout — genuinely may succeed on a second try.
 *
 * Detected structurally rather than by message text: the DOM standard's
 * `AbortError` name is what `fetch` rejects with on `signal.abort()`, and
 * undici/Node use the same name.
 */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Replace every occurrence of the app secret with `[redacted]`.
 *
 * Applied to every string that enters an error message from outside this
 * package. The token service never echoes the secret and a transport error
 * usually does not either — but "usually" is not a security property, and
 * `fetch` implementations that quote the failing request with its headers do
 * exist. One cheap pass makes the guarantee structural.
 *
 * A short or empty secret is ignored rather than replaced: redacting a 1-char
 * string would corrupt the message without protecting anything, and only a
 * well-formed secret is long enough to be worth hiding.
 */
export function redactSecret(text: string, secret: string): string {
  if (secret.length < 8) return text;
  return text.split(secret).join('[redacted]');
}
