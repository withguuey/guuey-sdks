import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, packSource, parseApiError } from './deploy-shared.js';

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
  it('reads the real httpError nested {error:{code,message}} shape', () => {
    expect(
      parseApiError({ error: { code: 'ValidationError', message: 'bad input' } }, 'fallback'),
    ).toBe('bad input');
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
