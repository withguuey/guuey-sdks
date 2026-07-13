/**
 * De-advertised (unshipped) command gates — launch-map M1 item 7.
 *
 * These commands stay registered so invocation never falls through to the
 * unknown-command error, but their cliApi routes are deferred (see the
 * "Deferred to follow-up slices" block in cliApi handler.ts). Each must
 * fail fast with a one-line roadmap notice on stderr and exit 1 — before
 * touching auth, config, or the network. When a route ships and its
 * `notYetAvailable` gate is removed, delete the matching case here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { byokSet, byokList, byokRemove } from './byok.js';
import { domainsAdd, domainsList, domainsVerify, domainsRemove } from './domains.js';
import { stop, start, restart } from './agent-lifecycle.js';
import { slugClaim } from './slug.js';
import { deploymentsRollback, deploymentsLogs } from './deployments.js';
import { agentConfig } from './agent.js';
import { appsRecover } from './apps.js';

/** Thrown by the process.exit mock so execution stops like the real thing. */
class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const gatedCommands: Array<{ name: string; run: () => Promise<void> }> = [
  { name: 'guuey byok set', run: () => byokSet({}) },
  { name: 'guuey byok list', run: () => byokList({}) },
  { name: 'guuey byok remove', run: () => byokRemove({}) },
  { name: 'guuey domains add', run: () => domainsAdd('api.example.com') },
  { name: 'guuey domains list', run: () => domainsList() },
  { name: 'guuey domains verify', run: () => domainsVerify('api.example.com') },
  { name: 'guuey domains remove', run: () => domainsRemove('api.example.com') },
  { name: 'guuey stop', run: () => stop() },
  { name: 'guuey start', run: () => start() },
  { name: 'guuey restart', run: () => restart() },
  { name: 'guuey slug claim', run: () => slugClaim('weather-bot') },
  { name: 'guuey deployments rollback', run: () => deploymentsRollback('3') },
  { name: 'guuey deployments logs', run: () => deploymentsLogs('3', {}) },
  { name: 'guuey agent config', run: () => agentConfig({}) },
  { name: 'guuey apps recover', run: () => appsRecover('app-123', {}) },
];

describe('unshipped command gates', () => {
  let errSpy: MockInstance<typeof console.error>;
  let exitSpy: MockInstance<typeof process.exit>;
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const { name, run } of gatedCommands) {
    it(`${name} prints a roadmap notice to stderr and exits 1 without any network call`, async () => {
      await expect(run()).rejects.toBeInstanceOf(ExitSignal);

      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
      expect(errSpy).toHaveBeenCalledTimes(1);
      const message = String(errSpy.mock.calls[0]?.[0]);
      expect(message).toContain(`${name} isn't available yet`);
      expect(message).toContain('roadmap');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
});
