// Secret redaction for the dev-env e2e script (`../dev-env-e2e.mjs`).
//
// Root-cause fix for the reviewer-reproduced PAT leak: `run()`'s rejection
// message used to embed raw argv (`${cmd} ${args.join(" ")} exited N`), and
// the login step passes the PAT as a literal argument — so an
// invalid/expired real PAT printed verbatim in the final "FAILED:" stderr
// line (e.g. in CI logs). Instead of patching that one call site, run()
// now scrubs EVERY constructed error message AND every echoed output chunk
// through `redactSecrets`, with the secret list collected centrally by
// `collectSecretsFromEnv` — so no future call site can leak a secret via
// argv echoes or error text either.
//
// Pure + dependency-free so vitest can unit-test it directly
// (`./redact.test.mjs`) even though the consumer is a plain .mjs script.

/** Env-var name suffixes whose values are treated as secrets. */
const SECRET_ENV_SUFFIX = /(_PAT|_TOKEN|_KEY|_SECRET|_PASSWORD)$/;

/**
 * Minimum secret length to redact. Guards against a degenerate env value
 * (e.g. `SOME_KEY=1`) turning the redactor into a text shredder that
 * replaces every "1" in the output.
 */
const MIN_SECRET_LENGTH = 6;

/**
 * Collect secret values from an env object: every var whose NAME ends in
 * a {@link SECRET_ENV_SUFFIX} suffix and whose value is long enough to be
 * a real credential. Longest-first so overlapping secrets redact cleanly.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string[]} [extra] additional literal secrets to include
 * @returns {string[]}
 */
export function collectSecretsFromEnv(env, extra = []) {
  const secrets = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_ENV_SUFFIX.test(name)) continue;
    if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
      secrets.add(value);
    }
  }
  for (const value of extra) {
    if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
      secrets.add(value);
    }
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

/**
 * Replace every occurrence of every secret in `text` with `***`.
 * Plain string splitting (no RegExp) — secrets are opaque credentials and
 * must never be interpreted as patterns.
 *
 * @param {string} text
 * @param {readonly string[]} secrets
 * @returns {string}
 */
export function redactSecrets(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("***");
  }
  return out;
}
