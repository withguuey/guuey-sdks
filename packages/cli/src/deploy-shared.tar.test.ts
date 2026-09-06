import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WORKING_TREE_TAR_EXCLUDE_ARGV, cleanup, packSource, tarWorkingTree, workingTreeTarSourceArgs } from './deploy-shared.js';

// guuey#867: this file spawns the real tar — a 2-vCPU runner is not the 5 s
// default; the budget is the file's own, from birth.
const TAR_BUDGET_MS = 30_000;

/**
 * guuey#896 — the working-tree tar is ONE `execFileSync('tar', argv)`: no
 * shell on any OS, entry names bound as argv, the exclude patterns reaching
 * tar unquoted. These run the real `tar` on a temp tree, because the point
 * is what lands in the tarball, not the shape of a string.
 */
describe('tarWorkingTree (guuey#896)', () => {
  let cwd: string;
  let out: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'guuey-896-'));
    out = join(mkdtempSync(join(tmpdir(), 'guuey-896-out-')), 'src.tgz');
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'index.ts'), 'export {};\n');
    // an entry a shell would have needed quoting for — bound argv never sees a shell
    writeFileSync(join(cwd, "it's here; $(touch pwned).txt"), 'x\n');
    mkdirSync(join(cwd, 'dist'));
    writeFileSync(join(cwd, 'dist', 'out.js'), '// root dist: omitted from the sources\n');
    mkdirSync(join(cwd, 'vendor', 'dep', 'dist'), { recursive: true });
    writeFileSync(join(cwd, 'vendor', 'dep', 'dist', 'lib.js'), '// nested dist: kept\n');
    mkdirSync(join(cwd, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', 'x', 'i.js'), '');
    writeFileSync(join(cwd, '.env.local'), 'SECRET=1\n');
    writeFileSync(join(cwd, 'a.tsbuildinfo'), '{}\n');
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(join(out, '..'), { recursive: true, force: true });
  });

  it('the excludes are argv (no quotes for a shell), and the sources are ./<entry> minus the root dist', () => {
    for (const flag of WORKING_TREE_TAR_EXCLUDE_ARGV) {
      expect(flag).toMatch(/^--exclude=[^'" ]+$/);
    }
    expect(WORKING_TREE_TAR_EXCLUDE_ARGV).toContain('--exclude=.env*');
    expect(WORKING_TREE_TAR_EXCLUDE_ARGV).toContain('--exclude=*.tsbuildinfo');
    const sources = workingTreeTarSourceArgs(cwd);
    expect(sources).toContain('./src');
    expect(sources).toContain("./it's here; $(touch pwned).txt");
    expect(sources).toContain('./vendor');
    expect(sources).not.toContain('./dist');
  }, TAR_BUDGET_MS);

  it('packs the tree with the real tar: the odd name lands verbatim, root dist and secrets are out, a nested dist is kept, nothing ran in a shell', () => {
    tarWorkingTree(out, cwd);
    const listed = execFileSync('tar', ['tzf', out], { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.replace(/\/$/, ''))
      .filter(Boolean);
    expect(listed).toContain('./src/index.ts');
    expect(listed).toContain("./it's here; $(touch pwned).txt");
    expect(listed).toContain('./vendor/dep/dist/lib.js');
    expect(listed.some((l) => l.startsWith('./dist'))).toBe(false);
    expect(listed.some((l) => l.includes('node_modules'))).toBe(false);
    expect(listed).not.toContain('./.env.local');
    expect(listed).not.toContain('./a.tsbuildinfo');
    // the shell-injection shape did NOT execute: no `pwned` file appeared
    expect(workingTreeTarSourceArgs(cwd)).not.toContain('./pwned');
  }, TAR_BUDGET_MS);
});

describe('packSource — the git-archive path is argv too (guuey#907)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'guuey-907-'));
    writeFileSync(join(cwd, 'index.js'), 'export {};\n');
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture-907', version: '0.0.1', private: true }));
    // A hermetic repo: no global config (the machine's hooks path / identity
    // must not reach a fixture), and HEAD asserted before any case runs.
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: cwd };
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'pipe', env });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, stdio: 'pipe', env });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('a buildId with a space and $(…) lands as the tarball\'s literal path — git archive received it as one argv, nothing ran', () => {
    // The id is part of `tarballPath`; under a shell string this would have
    // split on the space and expanded the substitution. `touch` never runs.
    // Slash-free on purpose: the id is a path SEGMENT, and a shell would have
    // run `touch pwned` in the child's cwd (the fixture repo).
    const buildId = 'b 1$(touch pwned)';
    const result = packSource({ buildId, cwd });
    try {
      expect(result.tarballPath).toContain(buildId);
      expect(existsSync(result.tarballPath)).toBe(true);
      expect(statSync(result.tarballPath).size).toBeGreaterThan(0);
      expect(result.tarballSize).toBe(statSync(result.tarballPath).size);
      expect(existsSync(join(cwd, 'pwned'))).toBe(false);
      expect(existsSync(join(process.cwd(), 'pwned'))).toBe(false);
      // The archive lists the committed file: it really is a git archive of HEAD.
      const listing = execFileSync('tar', ['tzf', result.tarballPath], { encoding: 'utf-8' });
      expect(listing).toContain('index.js');
    } finally {
      cleanup(result.tarballPath);
    }
  }, TAR_BUDGET_MS);

  it('the working-tree path on the same repo: `.git` is excluded (never a source), the tarball is real', () => {
    const result = packSource({ buildId: 'wt 2$(false)', cwd, includeWorkingTree: true });
    try {
      expect(existsSync(result.tarballPath)).toBe(true);
      const listing = execFileSync('tar', ['tzf', result.tarballPath], { encoding: 'utf-8' });
      expect(listing).toContain('index.js');
      expect(listing).not.toMatch(/\.git\//);
    } finally {
      cleanup(result.tarballPath);
    }
  }, TAR_BUDGET_MS);
});
