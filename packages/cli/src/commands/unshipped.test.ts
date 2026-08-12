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
import { stop, start, restart } from './agent-lifecycle.js';
import { deploymentsRollback, deploymentsLogs } from './deployments.js';

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
  { name: 'guuey stop', run: () => stop() },
  { name: 'guuey start', run: () => start() },
  { name: 'guuey restart', run: () => restart() },
  { name: 'guuey deployments rollback', run: () => deploymentsRollback('3') },
  { name: 'guuey deployments logs', run: () => deploymentsLogs('3', {}) },
  // `guuey agent config` left this list in guuey#162 (scaling S1-F4): its
  // route (`GET|PATCH /v1/apps/:id/config`) now exists and the command
  // reaches the network. Coverage lives in `agent.test.ts`.
  // `guuey apps recover` left this list in guuey#41, per the "delete the
  // matching case when a route ships" instruction above: its cliApi route
  // (`POST /v1/apps/:id/recover`) now exists, so the command reaches the
  // network like any other. Its coverage moved to `apps.recover.test.ts`.
  // `guuey domains add|list|verify|remove` left the same way in guuey#132
  // slice 1: the `/v1/apps/:id/domains*` routes now exist. Coverage lives
  // in `domains.test.ts`.
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
