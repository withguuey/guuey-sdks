/**
 * guuey#1191 — scaffold-smoke's install retry policy, proven without a
 * registry: only transient registry classes retry (30 s, then 60 s); a
 * template/tooling failure throws at once; the retries are bounded.
 */
import { describe, expect, it } from 'vitest';
import { RETRY_WAITS_MS, TRANSIENT_REGISTRY, installWithRetry, transientClassOf } from './install-retry.mjs';

function failing(stderr) {
  return Object.assign(new Error('Command failed: corepack pnpm install'), { stderr });
}

describe('transientClassOf (guuey#1191)', () => {
  it('names the registry-transient classes', () => {
    expect(transientClassOf('ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @jsonjoy.com/fs-node-utils@4.72.2')).toBe('ERR_PNPM_NO_MATCHING_VERSION');
    expect(transientClassOf('ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/x: 503')).toBe('ERR_PNPM_META_FETCH_FAIL');
    expect(transientClassOf('request failed, reason: connect ECONNREFUSED 127.0.0.1:9')).toBe('ECONNREFUSED');
  });
  it('never classifies template or tooling failures as transient', () => {
    for (const s of [
      'ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND  Could not install from "does-not-exist"',
      'ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: esbuild.',
      'TypeError: Cannot read properties of undefined',
      'ELIFECYCLE  Command failed with exit code 1.',
      '',
    ]) {
      expect(transientClassOf(s)).toBeNull();
      expect(TRANSIENT_REGISTRY.test(s)).toBe(false);
    }
  });
});

describe('installWithRetry (guuey#1191)', () => {
  it('a transient failure retries after 30 s, then succeeds — one receipt line', () => {
    let calls = 0;
    const sleeps = [];
    const lines = [];
    const out = installWithRetry({
      run: () => {
        calls++;
        if (calls === 1) throw failing('ERR_PNPM_NO_MATCHING_VERSION  No matching version found for x@1.2.3');
      },
      sleep: (ms) => sleeps.push(ms),
      log: (l) => lines.push(l),
    });
    expect(out).toEqual({ attempts: 2 });
    expect(sleeps).toEqual([30_000]);
    expect(lines).toEqual(['scaffold-smoke: transient registry error (ERR_PNPM_NO_MATCHING_VERSION) — retry 1/2 in 30s']);
  });
  it('retries are bounded: transient three times → 30 s, 60 s, then the last error is thrown', () => {
    let calls = 0;
    const sleeps = [];
    expect(() =>
      installWithRetry({
        run: () => {
          calls++;
          throw failing('connect ECONNREFUSED 127.0.0.1:9');
        },
        sleep: (ms) => sleeps.push(ms),
      }),
    ).toThrow(/Command failed/);
    expect(calls).toBe(RETRY_WAITS_MS.length + 1);
    expect(sleeps).toEqual([30_000, 60_000]);
  });
  it('a non-transient failure throws at once — no sleep, no retry', () => {
    let calls = 0;
    const sleeps = [];
    expect(() =>
      installWithRetry({
        run: () => {
          calls++;
          throw failing('ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: esbuild.');
        },
        sleep: (ms) => sleeps.push(ms),
      }),
    ).toThrow(/Command failed/);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });
});
