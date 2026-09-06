import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WORKING_TREE_TAR_EXCLUDE_ARGV, tarWorkingTree, workingTreeTarSourceArgs } from './deploy-shared.js';

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
