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
