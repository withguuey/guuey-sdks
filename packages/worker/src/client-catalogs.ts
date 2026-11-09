/**
 * The rule for an invoke's {@link Invoke.clientCatalogs}: one place, read by
 * `parseControl` before it keeps the field and by a Router before it writes
 * it, so the two can never bound it differently.
 *
 * The ids only gate prompt sections by membership (a renderer asks "does the
 * client draw this catalog?"); none of them is ever written into the prompt.
 * So the bound is about frame size alone, and it keeps every well-formed id
 * rather than refusing the list: a later client that names one more catalog,
 * or one id this rule does not accept, must not cost the turn the catalogs it
 * does draw.
 *
 * It is also a bound on what crosses into the agent slot: the Router applies
 * it as the last write before the slot wire (the runtime's invoke
 * projection), and infra-hardening's projection tests pin it there. So its
 * character class and its cap change only with infra-hardening's agreement.
 *
 * The field it reads is `Invoke.clientCatalogs` (protocol.ts).
 */

/** The most catalog ids one invoke carries; later ones are dropped. */
export const CLIENT_CATALOGS_MAX = 16;
/** The longest catalog id, in characters. */
export const CLIENT_CATALOG_ID_MAX_CHARS = 64;
/** One catalog id: 1 to 64 characters of a URL-safe ASCII class, no whitespace or control characters. */
export const CLIENT_CATALOG_ID_PATTERN = new RegExp(`^[A-Za-z0-9._~:/@+-]{1,${String(CLIENT_CATALOG_ID_MAX_CHARS)}}$`);

/**
 * The well-formed catalog ids in `raw`, in order and without repeats: each a
 * string matching {@link CLIENT_CATALOG_ID_PATTERN}, at most
 * {@link CLIENT_CATALOGS_MAX} of them. A bad entry drops only itself. `undefined` when `raw` is not an array
 * or none survives, so "this client draws no catalog" is always the ABSENT
 * field, never an empty list.
 */
export function parseClientCatalogs(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    if (out.length === CLIENT_CATALOGS_MAX) break;
    if (typeof entry !== "string" || !CLIENT_CATALOG_ID_PATTERN.test(entry) || out.includes(entry)) continue;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}
