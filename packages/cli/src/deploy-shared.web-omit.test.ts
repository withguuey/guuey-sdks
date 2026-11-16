import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanup,
  copyStagingTree,
  isStagingExcluded,
  localWebAppEntries,
  packSource,
  workingTreeTarSourceArgs,
} from './deploy-shared.js';

// This file spawns the real tar for the packSource case, so it carries its own budget (guuey#867).
const TAR_BUDGET_MS = 30_000;

/**
 * guuey#3504 (N3): a code deploy leaves out the scaffold's LOCAL web app — a top-level `web/` that the project's own
 * pnpm workspace lists, with its own package.json, that guuey.json does not point into — and nothing else.
 */
describe('localWebAppEntries (guuey#3504)', () => {
  let cwd: string;

  /** The create-agentic-app shape: root + mcps/* + web, as pnpm-workspace.yaml lists them. */
  function scaffold(workspaceYaml = 'packages:\n  - "mcps/*"\n  - "web"\n'): void {
    writeFileSync(join(cwd, 'pnpm-workspace.yaml'), workspaceYaml);
    mkdirSync(join(cwd, 'web', 'src'), { recursive: true });
    writeFileSync(join(cwd, 'web', 'package.json'), '{"name":"@agentic-app-template/web"}');
    mkdirSync(join(cwd, 'mcps', 'todo'), { recursive: true });
    writeFileSync(join(cwd, 'mcps', 'todo', 'package.json'), '{"name":"todo"}');
  }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'guuey-web-omit-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('the scaffold shape: web is left out', () => {
    scaffold();
    expect(localWebAppEntries(cwd, ['guuey.worker.js', './mcps/todo'])).toEqual(['web']);
  });

  it('accepts the ./web spelling of the member', () => {
    scaffold('packages:\n  - ./web\n');
    expect(localWebAppEntries(cwd, ['worker.js'])).toEqual(['web']);
  });

  it('keeps web when there is no pnpm workspace', () => {
    mkdirSync(join(cwd, 'web'));
    writeFileSync(join(cwd, 'web', 'package.json'), '{}');
    expect(localWebAppEntries(cwd, [])).toEqual([]);
  });

  it('keeps web when the workspace does not list it', () => {
    scaffold('packages:\n  - "mcps/*"\n');
    expect(localWebAppEntries(cwd, [])).toEqual([]);
  });

  it('keeps web when the workspace file names no packages list', () => {
    scaffold('allowBuilds:\n  esbuild: true\n');
    expect(localWebAppEntries(cwd, [])).toEqual([]);
  });

  it('keeps web when web/ has no package.json (a plain folder the builder owns)', () => {
    scaffold();
    rmSync(join(cwd, 'web', 'package.json'));
    expect(localWebAppEntries(cwd, [])).toEqual([]);
  });

  it.each([
    ['the worker', ['web/worker.js']],
    ['the agent entry, ./ spelling', ['./web/agent.js']],
    ['an MCP server source', ['guuey.worker.js', './web/mcp']],
    ['the folder itself', ['web']],
  ])('keeps web when guuey.json points into it: %s', (_label, referenced) => {
    scaffold();
    expect(localWebAppEntries(cwd, referenced)).toEqual([]);
  });

  it('a path that only starts with the letters web is not inside web/', () => {
    scaffold();
    expect(localWebAppEntries(cwd, ['webhooks/handler.js'])).toEqual(['web']);
  });
});

// The packSource case spawns the real tar, so the whole describe carries the budget (guuey#867's guard reads it here).
describe('omitTopLevel reaches both working-tree packing paths at the ROOT only (guuey#3504)', { timeout: TAR_BUDGET_MS }, () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'guuey-web-omit-pack-'));
    mkdirSync(join(cwd, 'web'));
    mkdirSync(join(cwd, 'vendor', 'dep', 'web'), { recursive: true });
    writeFileSync(join(cwd, 'web', 'package.json'), '{}');
    writeFileSync(join(cwd, 'vendor', 'dep', 'web', 'keep.js'), '');
    writeFileSync(join(cwd, 'package.json'), '{"name":"app"}');
    writeFileSync(join(cwd, 'guuey.worker.js'), '');
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('the tar sources leave out ./web and keep everything else', () => {
    const sources = workingTreeTarSourceArgs(cwd, ['web']);
    expect(sources).not.toContain('./web');
    expect(sources).toContain('./vendor');
    expect(sources).toContain('./guuey.worker.js');
    expect(workingTreeTarSourceArgs(cwd)).toContain('./web');
  });

  it.each([
    ['web', true],
    [['vendor', 'dep', 'web'].join(sep), false],
    [['web', 'package.json'].join(sep), false],
  ])('the staging filter: %j -> %s (its parent decides for anything below)', (rel, excluded) => {
    expect(isStagingExcluded(rel, ['web'])).toBe(excluded);
    expect(isStagingExcluded(rel)).toBe(false);
  });

  it('the staging copy leaves out the root web/ and keeps a nested one', () => {
    const staging = mkdtempSync(join(tmpdir(), 'guuey-web-omit-staging-'));
    try {
      copyStagingTree(cwd, staging, ['web']);
      expect(existsSync(join(staging, 'web'))).toBe(false);
      expect(existsSync(join(staging, 'vendor', 'dep', 'web', 'keep.js'))).toBe(true);
      expect(existsSync(join(staging, 'guuey.worker.js'))).toBe(true);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('packSource with the real tar: the root web/ is not in the tarball, a nested web/ is', () => {
    const { tarballPath } = packSource({ buildId: 'webomit', cwd, includeWorkingTree: true, omitTopLevel: ['web'] });
    try {
      const listed = execFileSync('tar', ['tzf', tarballPath], { encoding: 'utf8' })
        .split('\n')
        .map((l) => l.replace(/\/$/, ''))
        .filter(Boolean);
      expect(listed.some((l) => l === './web' || l.startsWith('./web/'))).toBe(false);
      expect(listed).toContain('./vendor/dep/web/keep.js');
      expect(listed).toContain('./guuey.worker.js');
    } finally {
      cleanup(tarballPath);
    }
  });

  it('refuses omitTopLevel on the git-archive path (committed files ship as they are)', () => {
    expect(() => packSource({ buildId: 'webomit2', cwd, omitTopLevel: ['web'] })).toThrow(
      'packSource: omitTopLevel needs includeWorkingTree',
    );
  });
});
