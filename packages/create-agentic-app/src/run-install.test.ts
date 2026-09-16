/**
 * guuey#1441 — `runInstall` must install on a machine WITHOUT corepack.
 *
 * The founder's own `npx @guuey/create-agentic-app@latest` printed
 * `Warning: "corepack pnpm install" failed to run automatically`, because the
 * only path we shipped was `corepack pnpm` and corepack is absent on Node 25
 * and on Homebrew's node. His words: "my env does not have corepack. other
 * people will have the same issue."
 *
 * These cases drive the REAL `execFile` through a stubbed `PATH` rather than a
 * mocked module, so they test what the user's shell would actually resolve —
 * the same technique the repo's shell tests use for `aws` and `kubectl`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall, SCAFFOLD_PNPM } from './scaffold.js';

let work: string;
let bin: string;
let project: string;
const realPath = process.env.PATH;

/** A stub executable that records its argv and exits 0. */
function stub(name: string, marker: string): void {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\nexit 0\n`);
  chmodSync(file, 0o755);
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'guuey-1441-'));
  bin = join(work, 'bin');
  project = join(work, 'project');
  mkdirSync(bin);
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), '{"name":"probe","private":true}\n');
  process.env.PATH = bin; // ONLY the stubs are reachable
});

afterEach(() => {
  process.env.PATH = realPath;
  rmSync(work, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runInstall (guuey#1441)', () => {
  it('uses pnpm when it is on PATH, and does not reach for npx', async () => {
    const pnpmMarker = join(work, 'pnpm.args');
    const npxMarker = join(work, 'npx.args');
    stub('pnpm', pnpmMarker);
    stub('npx', npxMarker);
    await runInstall(project);
    expect(existsSync(pnpmMarker)).toBe(true);
    expect(readFileSync(pnpmMarker, 'utf8').trim()).toBe('install');
    expect(existsSync(npxMarker)).toBe(false);
  });

  it('falls back to npx pnpm@<pinned> when pnpm is absent — the founder’s machine', async () => {
    const npxMarker = join(work, 'npx.args');
    stub('npx', npxMarker);
    await runInstall(project);
    expect(readFileSync(npxMarker, 'utf8').split('\n').filter(Boolean)).toEqual(['--yes', SCAFFOLD_PNPM, 'install']);
  });

  it('with neither, warns with the manual step and NEVER says corepack', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runInstall(project)).resolves.toBeUndefined();
    const text = err.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('pnpm install');
    expect(text).toContain(project);
    expect(text).not.toContain('corepack');
  });
});
