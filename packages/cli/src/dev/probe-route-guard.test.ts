/**
 * guuey#770 grep-guard: the hosted pod serves ONE probe-shaped route,
 * `/readyz` (guuey#758 deleted `/healthz`), and the local `guuey dev` server,
 * the scaffold and the e2e wait-fors follow it. A `/healthz` string
 * reappearing in any of those three trees is the local/hosted route drift
 * this row closed, so it fails here — before a builder finds it by poking a
 * route the platform does not serve.
 *
 * Scans the source trees as TEXT (like `cli-help-copy.test.ts`), rooted at
 * the monorepo root — asserted, so a moved package fails loudly rather than
 * scanning nothing.
 *
 * What counts: a `/healthz` on a CODE line — a route served, a URL fetched,
 * a string pinned. A comment-only line (`//`, `*`, `/*`, `#`) saying the
 * route is gone is the opposite of drift and is skipped. The ONE code line
 * allowed to name it is the dev server's own 404 pin, marked inline with
 * `probe-route-guard: allow` so the exemption is visible where it is used.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

/** Trees that must carry no `/healthz`. */
const GUARDED_TREES = ['oss/packages/cli/src', 'oss/packages/create-agentic-app', 'e2e'];

/** Build / run artifacts and vendored trees — never source. */
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  '.turbo',
  'test-results',
  'playwright-report',
  'blob-report',
  '.auth',
  '.cache',
]);

/**
 * Build outputs skipped by PATH, not by directory name — `templates/` is
 * create-agentic-app's BUILT tree (`templates-src/` is its source), but the
 * package also carries a SOURCE `src/__fixtures__/templates`, which a
 * name-only skip would silently stop scanning.
 */
const SKIPPED_PATHS = new Set(['oss/packages/create-agentic-app/templates']);

/** Binary-ish extensions — no route strings live there. */
const SKIPPED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz',
  '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.mov', '.webm', '.wasm',
]);

/** This file names the banned string on purpose. */
const SELF = resolve(__dirname, 'probe-route-guard.test.ts');

const ALLOW_MARKER = 'probe-route-guard: allow';
/** A line that is only a comment — JS/TS line + block comment shapes, shell/yaml `#`. */
const COMMENT_ONLY_LINE = /^\s*(\/\/|\/\*|\*|#)/;

function isGuardedHit(line: string): boolean {
  if (!line.includes('/healthz')) return false;
  if (line.includes(ALLOW_MARKER)) return false;
  return !COMMENT_ONLY_LINE.test(line);
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      if (SKIPPED_PATHS.has(relative(REPO_ROOT, path))) continue;
      yield* walk(path);
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf('.');
    if (dot !== -1 && SKIPPED_EXTS.has(entry.name.slice(dot).toLowerCase())) continue;
    yield path;
  }
}

describe('probe route guard (guuey#770) — no /healthz under the local-dev trees', () => {
  it('is rooted at the monorepo root', () => {
    expect(existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true);
    for (const tree of GUARDED_TREES) {
      expect(statSync(join(REPO_ROOT, tree)).isDirectory()).toBe(true);
    }
  });

  it.each(GUARDED_TREES)('%s carries no "/healthz"', (tree) => {
    const hits: string[] = [];
    for (const file of walk(join(REPO_ROOT, tree))) {
      if (file === SELF) continue;
      const text = readFileSync(file, 'utf8');
      if (!text.includes('/healthz')) continue;
      text.split('\n').forEach((line, i) => {
        if (isGuardedHit(line)) hits.push(`${relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits, `the hosted pod serves /readyz only (guuey#758) — local must match (guuey#770):\n${hits.join('\n')}`).toEqual([]);
  });
});
