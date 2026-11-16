import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WORKING_TREE_TAR_EXCLUDE_ARGV,
  cleanup,
  copyStagingTree,
  isPackExcludedName,
  isPackExcludedPath,
  packSource,
  tarWorkingTree,
  workingTreeTarSourceArgs,
} from './deploy-shared.js';

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

/**
 * guuey#3502: ONE never-packed list on the packing paths a code-mode deploy
 * can take. The same fixture tree, with every secret-shaped file COMMITTED,
 * goes through the real tar and the staging copy (which kept `.npmrc` before
 * this list), and each must leave out exactly the same set. A real `git
 * archive HEAD` of the same repo pins that the Dockerfile path is unchanged.
 */
describe('one never-packed list on the code-mode packing paths (guuey#3502)', () => {
  // Paths relative to the project root, with POSIX separators (the archives list them that way).
  const LEFT_OUT = [
    '.env',
    'config/.env.production',
    '.npmrc',
    'packages/a/.npmrc',
    'node_modules/dep/index.js',
    'packages/a/node_modules/dep/index.js',
    '.guuey/state.json',
    '.guuey-dev',
    '.ggui/cache.json',
    'a.tsbuildinfo',
    '.env.example',
    '.netrc',
    'deploy/.pypirc',
    '.aws/credentials',
    'ops/.aws/credentials',
    '.docker/config.json',
    'keys/id_rsa',
    'id_ed25519',
    'id_ecdsa',
  ];
  const KEPT = [
    'index.js',
    'package.json',
    'src/env.ts',
    'src/npmrc-docs.md',
    'Dockerfile',
    // The directory-qualified names leave their neighbours alone, and a public key always ships.
    '.aws/config',
    'credentials',
    '.docker/daemon.json',
    'config.json',
    'keys/id_rsa.pub',
    'id_ed25519.pub',
  ];

  let cwd: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'guuey-3502-'));
    for (const rel of [...LEFT_OUT, ...KEPT]) {
      const abs = join(cwd, ...rel.split('/'));
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, rel === 'package.json' ? JSON.stringify({ name: 'fixture-3502', private: true }) : 'x\n');
    }
    // A hermetic repo, as guuey#907's fixture: no global config, no hooks, HEAD asserted. `-f` commits the
    // secret-shaped files on purpose (the case under test), whatever an ignore file says.
    env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: cwd };
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'pipe', env });
    git('init', '-q');
    git('add', '-f', '.');
    git('commit', '-q', '-m', 'init');
    const committed = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', env }).split('\n');
    for (const rel of LEFT_OUT) expect(committed).toContain(rel);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function listTgz(tarballPath: string): string[] {
    return execFileSync('tar', ['tzf', tarballPath], { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.replace(/^\.\//, '').replace(/\/$/, ''))
      .filter(Boolean);
  }

  function assertSameSet(listed: readonly string[]): void {
    for (const rel of LEFT_OUT) expect(listed, rel).not.toContain(rel);
    for (const rel of KEPT) expect(listed, rel).toContain(rel);
  }

  it('git archive HEAD (a project with its own Dockerfile) is left as it ships: committed files go as they are', () => {
    // That path never feeds a shared-worker package, and a project there may read a committed `.npmrc` in its own
    // build, so the shared list does not apply to it. An UNTRACKED file proves the tarball came from git archive,
    // not from the tar fallback (which applies the list).
    writeFileSync(join(cwd, 'untracked-3502.txt'), 'x\n');
    const result = packSource({ buildId: 'g3502', cwd });
    try {
      const listed = listTgz(result.tarballPath);
      expect(listed, 'the tarball came from git archive, not the tar fallback').not.toContain('untracked-3502.txt');
      expect(listed).toContain('.npmrc');
      expect(listed).toContain('.env');
      for (const rel of KEPT) expect(listed, rel).toContain(rel);
    } finally {
      cleanup(result.tarballPath);
    }
  }, TAR_BUDGET_MS);

  it('the working-tree tar: the same set', () => {
    const result = packSource({ buildId: 't3502', cwd, includeWorkingTree: true });
    try {
      assertSameSet(listTgz(result.tarballPath));
    } finally {
      cleanup(result.tarballPath);
    }
  }, TAR_BUDGET_MS);

  it('the staging copy: the same set', () => {
    const staging = mkdtempSync(join(tmpdir(), 'guuey-3502-staging-'));
    try {
      copyStagingTree(cwd, staging);
      for (const rel of LEFT_OUT) expect(existsSync(join(staging, ...rel.split('/'))), rel).toBe(false);
      for (const rel of KEPT) expect(existsSync(join(staging, ...rel.split('/'))), rel).toBe(true);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }, TAR_BUDGET_MS);

  it('the name test and the tar argv agree on every listed name', () => {
    for (const name of ['.env', '.env.local', '.npmrc', 'node_modules', '.git', '.guuey', '.guuey-dev', '.ggui', 'x.tsbuildinfo']) {
      expect(isPackExcludedName(name), name).toBe(true);
    }
    for (const name of ['env.ts', 'npmrc-docs.md', 'src', 'dist', 'package.json', 'id_rsa.pub', 'credentials']) {
      expect(isPackExcludedName(name), name).toBe(false);
    }
    expect(isPackExcludedPath(['ops', '.aws', 'credentials'])).toBe(true);
    expect(isPackExcludedPath(['.docker', 'config.json'])).toBe(true);
    expect(isPackExcludedPath(['config.json'])).toBe(false);
    expect(isPackExcludedPath([])).toBe(false);
    expect(WORKING_TREE_TAR_EXCLUDE_ARGV).toContain('--exclude=.npmrc');
    expect(WORKING_TREE_TAR_EXCLUDE_ARGV).toContain('--exclude=*/.aws/credentials');
  });
});
