/**
 * guuey#867 — budget grep-guard for the "5 s on the runner" class.
 *
 * A test that builds a TypeScript program in-process (`ts.createProgram`) or
 * runs tooling through `node:child_process` takes seconds on a laptop and
 * past vitest's 5 s default on a 2-vCPU GitHub runner. It cost the cohort
 * one publish: `@guuey/mcp-apps-host`'s NodeNext probe timed out at the
 * mirror's cohort gate and kept v0.18.0 off npm (run 33966354172); the
 * colocated-dev spawn test flaked the same way (guuey#838). Both fixes were
 * one constant each — a budget the test should have carried from birth.
 *
 * So: every oss/ test file in the class carries an explicit budget — an
 * `it`/`test` third argument (`{ timeout }` or a number / `*_MS` constant), a
 * `describe(..., { timeout })`, `vi.setConfig({ testTimeout })`, or a
 * `testTimeout:` key. A file that only MOCKS `node:child_process` is not in
 * the class (nothing real is spawned).
 *
 * Packaging seam (oss): this walks the monorepo's oss/ tree as TEXT, so it
 * runs only where that tree exists (`describe.skipIf(!inMonorepo)`) — the
 * mirror's publish gate and any consumer's test run see the published cli
 * alone. Guarded in-repo by the `Unit (oss)` CI leg (guuey#864).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const OSS_PACKAGES = join(REPO_ROOT, 'oss', 'packages');
const SELF = resolve(__dirname, 'test-budget-guard.test.ts');

const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.turbo', 'templates', '__fixtures__']);

/**
 * Pre-existing files in the class that carry no budget yet. Each line names
 * a row; a line is DELETED when its file gains a budget — never added to
 * silently. Sub-second git plumbing today, but the rule is the rule.
 */
const KNOWN_UNBUDGETED: ReadonlySet<string> = new Set([
  'cli/src/deploy-shared.test.ts', // execSync git init/add/commit — guuey#867 follow-up
  'cli/src/commands/mcp.test.ts', // execSync git init/add/commit — guuey#867 follow-up
  'create-agentic-app/src/scaffold.test.ts', // execFile git log — guuey#867 follow-up
]);

const IN_CLASS = /ts\.createProgram\(|(?:from|require\()\s*['"](?:node:)?child_process['"]/;
const MOCKS_CHILD_PROCESS = /vi\.mock\(\s*['"](?:node:)?child_process['"]/;
const HAS_BUDGET =
  /(?:\bit|\btest)\([^)]*,\s*\{[^}]*\btimeout\b|,\s*[A-Z][A-Z0-9_]*_MS\s*\)|,\s*\d{4,}\s*\)|describe\([^,]+,\s*\{[^}]*\btimeout\b|vi\.setConfig\(\s*\{[^}]*testTimeout|\btestTimeout\s*:/;

/** The class + budget read, as a pure function so the guard can test itself. */
export function classify(text: string): 'out-of-class' | 'mocked' | 'budgeted' | 'UNBUDGETED' {
  if (!IN_CLASS.test(text)) return 'out-of-class';
  if (!/ts\.createProgram\(/.test(text) && MOCKS_CHILD_PROCESS.test(text)) return 'mocked';
  return HAS_BUDGET.test(text) ? 'budgeted' : 'UNBUDGETED';
}

function* testFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* testFiles(path);
      continue;
    }
    if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) yield path;
  }
}

const inMonorepo = existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml')) && existsSync(OSS_PACKAGES);

describe('the classifier (guuey#867) — red on the class it guards', () => {
  it('flags an in-process TypeScript program without a budget', () => {
    expect(classify(`import ts from "typescript";\nit("x", () => { ts.createProgram([], {}); });`)).toBe('UNBUDGETED');
  });
  it('flags a real spawn without a budget and accepts one with', () => {
    expect(classify(`import { execSync } from "node:child_process";\nit("x", () => { execSync("git init"); });`)).toBe('UNBUDGETED');
    expect(classify(`import { execSync } from "node:child_process";\nconst BUDGET_MS = 30_000;\nit("x", () => { execSync("git init"); }, BUDGET_MS);`)).toBe('budgeted');
    expect(classify(`import { spawn } from "node:child_process";\nit("x", { timeout: 60_000 }, () => { spawn("pnpm"); });`)).toBe('budgeted');
  });
  it('does not flag a file that only mocks child_process, nor one outside the class', () => {
    expect(classify(`vi.mock("node:child_process", () => ({ execFile: vi.fn() }));\nimport { execFile } from "node:child_process";`)).toBe('mocked');
    expect(classify(`import { readFileSync } from "node:fs";\nit("x", () => {});`)).toBe('out-of-class');
  });
});

describe.skipIf(!inMonorepo)('every oss/ test in the class carries a budget (guuey#867)', () => {
  it('walks oss/packages/*/src and finds no unbudgeted file outside the named allowlist', () => {
    const unbudgeted: string[] = [];
    const stale: string[] = [];
    for (const file of testFiles(OSS_PACKAGES)) {
      if (file === SELF) continue;
      const rel = relative(OSS_PACKAGES, file);
      const verdict = classify(readFileSync(file, 'utf8'));
      if (verdict === 'UNBUDGETED' && !KNOWN_UNBUDGETED.has(rel)) unbudgeted.push(rel);
      if (verdict !== 'UNBUDGETED' && KNOWN_UNBUDGETED.has(rel)) stale.push(rel);
    }
    expect(
      unbudgeted,
      `these tests build a TS program or spawn tooling and carry no explicit timeout (vitest's 5 s default reds on a 2-vCPU runner — the v0.18.0 class):\n${unbudgeted.join('\n')}`,
    ).toEqual([]);
    expect(
      stale,
      `these KNOWN_UNBUDGETED rows are stale (the file now carries a budget or left the class) — delete the row:\n${stale.join('\n')}`,
    ).toEqual([]);
  });
});
