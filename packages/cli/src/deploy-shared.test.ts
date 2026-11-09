import { execSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanup,
  copyStagingTree,
  isServingBuild,
  isStagingExcluded,
  newestBuild,
  packageManagerSpawn,
  packSource,
  parseApiError,
} from './deploy-shared.js';

/** List every path inside a gzip tarball (relative, `./`-stripped). */
function tarballContents(tarballPath: string): string[] {
  return execSync(`tar -tzf "${tarballPath}"`, { encoding: 'utf-8' })
    .split('\n')
    .map((line) => line.trim().replace(/^\.\//, ''))
    .filter((line) => line.length > 0);
}

describe('packSource', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pack-source-test-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('includeWorkingTree: true (the code-orchestrated agent leg)', () => {
    it('ships the working tree (including gitignored build output like guuey.worker.js), and NEVER a .env* secret file', () => {
      // The built worker artifact — gitignored in real scaffolds, so a
      // `git archive` tarball would never contain it; the working-tree tar
      // must.
      writeFileSync(join(dir, 'guuey.worker.js'), 'console.log("worker");\n');
      writeFileSync(join(dir, 'src.ts'), 'export const x = 1;\n');

      // SECURITY-CRITICAL fixtures: none of these may ever reach the tarball.
      writeFileSync(join(dir, '.env.local'), 'ANTHROPIC_API_KEY=sk-should-not-leak\n');
      writeFileSync(join(dir, '.env.production'), 'SECRET=also-should-not-leak\n');
      writeFileSync(join(dir, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_should-not-leak\n');
      mkdirSync(join(dir, 'node_modules', 'somedep'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'somedep', 'index.js'), '');
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'dist', 'bundle.js'), '');
      mkdirSync(join(dir, '.guuey-dev'), { recursive: true });
      writeFileSync(join(dir, '.guuey-dev', 'session.json'), '{}');
      writeFileSync(join(dir, 'tsconfig.tsbuildinfo'), '{}');

      const { tarballPath } = packSource({ buildId: 'wt-test', cwd: dir, includeWorkingTree: true });
      const contents = tarballContents(tarballPath);
      cleanup(tarballPath);

      expect(contents).toContain('guuey.worker.js');
      expect(contents).toContain('src.ts');
      expect(contents).toContain('package.json');

      expect(contents).not.toContain('.env.local');
      expect(contents).not.toContain('.env.production');
      expect(contents).not.toContain('.npmrc');
      expect(contents.some((p) => p.startsWith('node_modules/'))).toBe(false);
      expect(contents.some((p) => p.startsWith('dist/'))).toBe(false);
      expect(contents.some((p) => p.startsWith('.guuey-dev/'))).toBe(false);
      expect(contents).not.toContain('tsconfig.tsbuildinfo');
    });

    it('strips the project-root dist/ but RETAINS a nested dist/ inside a vendored dependency', () => {
      // Regression test: a bare `tar --exclude=dist` matches at ANY depth on
      // both GNU tar and BSD/libarchive tar, so a vendored dependency's own
      // build output (e.g. `vendor/some-dep/dist/`) was being silently
      // stripped from the uploaded tarball — the dependency then fails to
      // load in the pod with no error at deploy time. The exclude must only
      // ever remove the PROJECT's own root dist/ (rebuilt in-image).
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'dist', 'bundle.js'), 'root build output\n');
      mkdirSync(join(dir, 'vendor', 'some-dep', 'dist'), { recursive: true });
      writeFileSync(join(dir, 'vendor', 'some-dep', 'dist', 'index.js'), 'vendored build output\n');

      const { tarballPath } = packSource({ buildId: 'nested-dist-test', cwd: dir, includeWorkingTree: true });
      const contents = tarballContents(tarballPath);
      cleanup(tarballPath);

      expect(contents.some((p) => p === 'dist/bundle.js' || p.startsWith('dist/'))).toBe(false);
      expect(contents).toContain('vendor/some-dep/dist/index.js');
    });
  });

  describe('includeWorkingTree omitted (default false — the pre-existing committed-files-only path)', () => {
    it('git-archives HEAD (committed files only), naturally excluding an untracked .env.local', () => {
      writeFileSync(join(dir, 'Dockerfile'), 'FROM node:20-slim\n');
      execSync('git init -q', { cwd: dir });
      execSync('git -c user.email=test@test.com -c user.name=test add -A', { cwd: dir });
      execSync('git -c user.email=test@test.com -c user.name=test commit -q -m init', { cwd: dir });
      // Untracked — never committed, so `git archive HEAD` can't ship it either way.
      writeFileSync(join(dir, '.env.local'), 'SECRET=leak\n');

      const { tarballPath } = packSource({ buildId: 'git-archive-test', cwd: dir });
      const contents = tarballContents(tarballPath);
      cleanup(tarballPath);

      expect(contents).toContain('Dockerfile');
      expect(contents).not.toContain('.env.local');
    });
  });
});

describe('parseApiError', () => {
  it('reads the real httpError nested {error:{code,message}} shape, prefixing the code', () => {
    expect(
      parseApiError({ error: { code: 'ValidationError', message: 'bad input' } }, 'fallback'),
    ).toBe('[ValidationError] bad input');
  });

  it('names the scaling 409 codes so the message is self-diagnosing', () => {
    // The two codes `guuey deploy --max-pods` / `guuey agent config
    // --max-pods` can 409 with. Without the prefix both read as generic
    // prose and neither is greppable in a support thread.
    expect(
      parseApiError(
        { error: { code: 'AGENT_MAX_PODS', message: "maxPods 5 exceeds this app's ceiling of 3" } },
        'fallback',
      ),
    ).toBe("[AGENT_MAX_PODS] maxPods 5 exceeds this app's ceiling of 3");
    expect(
      parseApiError(
        { error: { code: 'COLOCATED_STATE_UNARMED', message: 'maxPods > 1 requires durable state' } },
        'fallback',
      ),
    ).toBe('[COLOCATED_STATE_UNARMED] maxPods > 1 requires durable state');
  });

  it('omits the prefix when the nested envelope carries no code', () => {
    expect(parseApiError({ error: { message: 'no code here' } }, 'fallback')).toBe('no code here');
  });

  it('reads a flat {error: string} shape (legacy/ad-hoc handlers)', () => {
    expect(parseApiError({ error: 'plain string error' }, 'fallback')).toBe('plain string error');
  });

  it('falls back to a top-level message field when there is no error field', () => {
    expect(parseApiError({ message: 'top-level message' }, 'fallback')).toBe('top-level message');
  });

  it('falls back to the caller-supplied default when the body has neither', () => {
    expect(parseApiError({}, 'HTTP 500')).toBe('HTTP 500');
    expect(parseApiError(null, 'HTTP 500')).toBe('HTTP 500');
    expect(parseApiError(undefined, 'HTTP 500')).toBe('HTTP 500');
  });

  it('prefers the nested error.message over a co-present flat error string', () => {
    // Not a realistic body, but pins the precedence: nested wins.
    expect(
      parseApiError({ error: { message: 'nested wins' } }, 'fallback'),
    ).toBe('nested wins');
  });

  it('ignores an empty nested message and falls through to the default', () => {
    expect(parseApiError({ error: { code: 'X', message: '' } }, 'fallback')).toBe('fallback');
  });
});

// guuey#3283 — the CLI's one definition of "the newest build" and of "serving".
describe('newestBuild / isServingBuild (guuey#3283)', () => {
  const rows = [
    { buildNumber: 4, status: 'superseded', agentMode: 'nocode' },
    { buildNumber: 7, status: 'building', agentMode: 'code' },
    { buildNumber: 2, status: 'live', agentMode: 'nocode' },
    { buildNumber: 5, status: 'live', agentMode: 'code' },
  ] as const;

  it('picks the highest buildNumber the predicate keeps, whatever the list order', () => {
    expect(newestBuild(rows, () => true)?.buildNumber).toBe(7);
    expect(newestBuild([...rows].reverse(), () => true)?.buildNumber).toBe(7);
    expect(newestBuild(rows, isServingBuild)?.buildNumber).toBe(5);
    expect(newestBuild(rows, (r) => r.agentMode === 'nocode' && isServingBuild(r))?.buildNumber).toBe(2);
  });

  it('null when nothing is kept', () => {
    expect(newestBuild([], () => true)).toBeNull();
    expect(newestBuild(rows, (r) => r.buildNumber > 100)).toBeNull();
  });

  it('serving is live only: in-flight and terminal rows are not', () => {
    expect(isServingBuild({ status: 'live' })).toBe(true);
    for (const status of ['queued', 'building', 'deploying', 'superseded', 'undeploying', 'undeployed', 'failed']) {
      expect(isServingBuild({ status })).toBe(false);
    }
  });
});

// guuey#3285 — the workspace-deps staging path runs on Windows: pnpm/npm through cmd.exe as one quoted
// command line, and a Node copy in place of rsync.
describe('packageManagerSpawn (guuey#3285)', () => {
  const staging = 'C:\\Users\\Jo Doe\\AppData\\Local\\Temp\\ggui-deploy-staging-b1';

  it('posix: the executable and its argv, no shell', () => {
    expect(packageManagerSpawn('pnpm', ['pack', '--pack-destination', '/tmp/s'], 'darwin')).toEqual({
      file: 'pnpm',
      args: ['pack', '--pack-destination', '/tmp/s'],
      shell: false,
    });
  });

  it('win32 pnpm pack: one command line through the shell, the staging path quoted', () => {
    expect(packageManagerSpawn('pnpm', ['pack', '--pack-destination', staging], 'win32')).toEqual({
      file: `pnpm pack --pack-destination "${staging}"`,
      args: [],
      shell: true,
    });
  });

  it('win32 npm lockfile: plain flags stay bare', () => {
    expect(
      packageManagerSpawn('npm', ['install', '--package-lock-only', '--ignore-scripts', '--legacy-peer-deps'], 'win32'),
    ).toEqual({
      file: 'npm install --package-lock-only --ignore-scripts --legacy-peer-deps',
      args: [],
      shell: true,
    });
  });

  it('win32: an argument cmd.exe would expand or split is refused, never passed', () => {
    for (const bad of ['C:\\%TEMP%\\s', 'C:\\a"b', 'a\nb']) {
      expect(() => packageManagerSpawn('pnpm', ['pack', '--pack-destination', bad], 'win32')).toThrow(/through cmd\.exe/);
    }
  });
});

describe('isStagingExcluded (guuey#3285): the excludes rsync carried', () => {
  it.each([
    ['node_modules', true],
    [['packages', 'a', 'node_modules'].join(sep), true],
    ['dist', true],
    [['vendor', 'dep', 'dist'].join(sep), false],
    ['.git', true],
    ['.env', true],
    [['config', '.env.local'].join(sep), true],
    ['.guuey-dev', true],
    ['.ggui', true],
    ['.guuey', true],
    [['src', 'tsconfig.tsbuildinfo'].join(sep), true],
    ['src', false],
    ['package.json', false],
    ['', false],
  ])('%j → %s', (rel, excluded) => {
    expect(isStagingExcluded(rel)).toBe(excluded);
  });
});

describe('copyStagingTree (guuey#3285)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guuey-staging-copy-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('copies the project minus the excludes, keeps symlinks as links, and keeps what staging already holds', () => {
    const src = join(root, 'app');
    const staging = join(root, 'staging');
    for (const dir of ['src', 'dist', 'vendor/dep/dist', 'node_modules/x', 'packages/a/node_modules', '.git', '.ggui']) {
      mkdirSync(join(src, dir), { recursive: true });
    }
    writeFileSync(join(src, 'package.json'), '{}');
    writeFileSync(join(src, 'src', 'index.ts'), 'export {};');
    writeFileSync(join(src, 'dist', 'out.js'), '');
    writeFileSync(join(src, 'vendor', 'dep', 'dist', 'lib.js'), '');
    writeFileSync(join(src, 'node_modules', 'x', 'i.js'), '');
    writeFileSync(join(src, '.env.local'), 'SECRET=1');
    writeFileSync(join(src, 'src', 'a.tsbuildinfo'), '');
    symlinkSync('src/index.ts', join(src, 'entry.ts'));
    mkdirSync(staging);
    writeFileSync(join(staging, 'dep-1.0.0.tgz'), '');

    copyStagingTree(src, staging);

    for (const kept of ['package.json', 'src/index.ts', 'vendor/dep/dist/lib.js', 'dep-1.0.0.tgz']) {
      expect(existsSync(join(staging, kept)), kept).toBe(true);
    }
    for (const gone of ['dist', 'node_modules', 'packages/a/node_modules', '.git', '.ggui', '.env.local', 'src/a.tsbuildinfo']) {
      expect(existsSync(join(staging, gone)), gone).toBe(false);
    }
    expect(lstatSync(join(staging, 'entry.ts')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(staging, 'entry.ts'))).toBe('src/index.ts');
  });
});
