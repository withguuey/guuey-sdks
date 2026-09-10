// guuey#1191 — the scaffold-smoke install tolerates a TRANSIENT registry state
// and nothing else. On 2026-09-10 (guuey#1179) the gate went red on
// ERR_PNPM_NO_MATCHING_VERSION for a version npm published 45 s after the
// install ran (an upstream lockstep-publish ordering race). scaffold-smoke is
// the PUBLISH gate (release.yml "Scaffold smoke"), so a registry hiccup must
// not refuse a correct cohort — while template breakage must stay red at
// once. Only the classes below retry (30 s, then 60 s); anything else throws
// on the first failure. Pure: the runner and the sleep are injected so the
// policy is unit-tested without a registry.

export const TRANSIENT_REGISTRY =
  /ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|\b50[23]\b/;

export const RETRY_WAITS_MS = [30_000, 60_000];

/** The first transient class named in a failed install's stderr, or null. */
export function transientClassOf(stderr) {
  const m = TRANSIENT_REGISTRY.exec(stderr);
  return m ? m[0] : null;
}

/**
 * Runs `run()` (the install); on a thrown error whose `.stderr` names a
 * transient class, waits RETRY_WAITS_MS[attempt] via `sleep(ms)` and runs
 * again — at most RETRY_WAITS_MS.length retries. Any other error, or the
 * retries exhausted, rethrows the last error. `log(line)` receives one
 * receipt line per retry so the run's log says why it waited.
 */
export function installWithRetry({ run, sleep, log = () => {} }) {
  for (let attempt = 0; ; attempt++) {
    try {
      run();
      return { attempts: attempt + 1 };
    } catch (err) {
      const stderr = typeof err?.stderr === 'string' ? err.stderr : String(err?.stderr ?? '');
      const cls = transientClassOf(stderr);
      if (cls === null || attempt >= RETRY_WAITS_MS.length) throw err;
      const wait = RETRY_WAITS_MS[attempt];
      log(`scaffold-smoke: transient registry error (${cls}) — retry ${attempt + 1}/${RETRY_WAITS_MS.length} in ${wait / 1000}s`);
      sleep(wait);
    }
  }
}
