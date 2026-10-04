/**
 * Minimal output formatting utilities for CLI commands.
 * Provides consistent table, JSON, success, and error output.
 */

/**
 * Print a formatted ASCII table to stdout.
 *
 * @param rows - Array of objects where each key is a column name
 * @param columns - Optional column order (defaults to keys of first row)
 */
export function table(
  rows: Record<string, unknown>[],
  columns?: string[],
): void {
  if (rows.length === 0) {
    console.log('(no results)');
    return;
  }

  const cols = columns ?? Object.keys(rows[0]!);
  const widths = cols.map((col) =>
    Math.max(
      col.length,
      ...rows.map((r) => String(r[col] ?? '').length),
    ),
  );

  // Header
  const header = cols.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  console.log(header);
  console.log(widths.map((w) => '─'.repeat(w)).join('──'));

  // Rows
  for (const row of rows) {
    const line = cols
      .map((c, i) => String(row[c] ?? '').padEnd(widths[i]!))
      .join('  ');
    console.log(line);
  }
}

/** Print a value as pretty-printed JSON to stdout. */
export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/** Print a success message (prefixed with a check mark) to stdout. */
export function success(msg: string): void {
  console.log(`✓ ${msg}`);
}

/** Print an error message (prefixed with an X mark) to stderr. */
export function error(msg: string): void {
  console.error(`✗ ${msg}`);
}

/**
 * Fail fast for a command whose cliApi routes are still deferred (see the
 * "Deferred to follow-up slices" block in cliApi handler.ts). The command
 * stays registered (no unknown-command noise) but is de-advertised from
 * `guuey --help`; prints a one-line roadmap notice to stderr and exits 1.
 * Delete the call site when the routes ship.
 *
 * Declared `void` (not `never`) on purpose: a `never` return would make TS
 * narrow every statement after the gate to unreachable/`never`, breaking
 * typechecking of the dormant implementations the gates guard.
 */
export function notYetAvailable(message: string): void {
  error(message);
  process.exit(1);
}

/**
 * Render a cliApi error body to a human string. The API's envelope is
 * `{ error: { code, message } }`; older surfaces used `{ error: string }`.
 * Never yields "[object Object]" (the undeploy/delete regression class).
 */
export function apiErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "string" && err.length > 0) return err;
    if (typeof err === "object" && err !== null) {
      const { code, message } = err as { code?: unknown; message?: unknown };
      if (typeof message === "string" && message.length > 0) {
        return typeof code === "string" ? `${code}: ${message}` : message;
      }
    }
  }
  return fallback;
}

/** The error code in cliApi's `{ error: { code, message } }` envelope, if the body carries one. */
export function apiErrorCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== "object" || err === null) return undefined;
  const { code } = err as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

/**
 * A 404 `NOT_FOUND` from an app's door means ONE of two things, and the API
 * deliberately never says which: the app does not exist, or this account is
 * not allowed to do this to it. (Telling them apart would reveal that an app
 * someone cannot use exists.) So the CLI never prints "not found" alone to a
 * teammate who can see the app, and never guesses that a route is missing: it
 * names both possibilities and what to check.
 *
 * `action` completes "not allowed to … it" (e.g. "undeploy", "archive").
 */
export function appNotFoundOrNotAllowed(appId: string, action: string): string {
  return (
    `App ${appId} was not found, or this account is not allowed to ${action} it. ` +
    `Check the app id ("guuey apps list") and which account you are signed in as ("guuey whoami").`
  );
}

/**
 * Render a failed app-scoped call: the uniform 404 gets
 * {@link appNotFoundOrNotAllowed}; every other failure keeps the API's own
 * message ({@link apiErrorMessage}).
 */
export function appApiErrorMessage(
  status: number,
  body: unknown,
  appId: string,
  action: string,
  fallback: string,
): string {
  if (status === 404 && apiErrorCode(body) === "NOT_FOUND") {
    return appNotFoundOrNotAllowed(appId, action);
  }
  return apiErrorMessage(body, fallback);
}
