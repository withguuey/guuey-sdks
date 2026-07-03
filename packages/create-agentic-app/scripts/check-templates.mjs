#!/usr/bin/env node
/**
 * Publish guard for `dist/templates/**`.
 *
 * Walks every assembled template file and fails the build (nonzero exit) if
 * any of the following leaked through `build-templates.mjs`:
 *
 *   - `@guuey-private` (closed-source scope; must never ship in a public
 *     template a stranger's `npx create-agentic-app` downloads)
 *   - `workspace:` (pnpm workspace protocol; meaningless outside this repo)
 *   - `MODEL_PLACEHOLDER` (unstamped model — build-templates.mjs missed it)
 *   - an absolute `/workspaces/` path (this sandbox's path, baked in by
 *     accident)
 *   - a `file:` dependency (points at a path on the build machine, not a
 *     resolvable package for the scaffolded consumer)
 *
 * Also fails if any assembled `package.json` names an internal
 * `@guuey/*` / `@silverprotocol/*` dependency that isn't in
 * `templates-src/versions.json` — that dep would ship unpinned (or, if
 * `build-templates.mjs` did stamp it, `versions.json` is out of date with
 * what the templates actually need).
 *
 * Violations print as `<file>:<line>: <message>`; the process exits 1 if
 * any were found, 0 otherwise.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const distTemplatesDir = join(packageRoot, 'dist', 'templates');
const versionsPath = join(packageRoot, 'templates-src', 'versions.json');

/** @type {Record<string, string>} */
const versions = JSON.parse(readFileSync(versionsPath, 'utf8'));

const BANNED_SUBSTRINGS = [
  { needle: '@guuey-private', message: 'references the closed-source @guuey-private scope' },
  { needle: 'workspace:', message: 'uses the pnpm workspace: protocol, meaningless outside this monorepo' },
  { needle: 'MODEL_PLACEHOLDER', message: 'unstamped model placeholder' },
  { needle: '/workspaces/', message: 'bakes in an absolute sandbox path' },
  { needle: 'file:', message: 'uses a file: dependency pointing at the build machine' },
];

function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        files.push(full);
      }
    }
  }
  return files;
}

/** NUL-byte-in-first-8KB heuristic: same sniff scaffold.ts uses for copy. */
function isProbablyText(buf) {
  const window = buf.subarray(0, 8192);
  return !window.includes(0);
}

/** @type {{ file: string, line: number, message: string }[]} */
const violations = [];

function checkBannedSubstrings(file, relPath, content) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { needle, message } of BANNED_SUBSTRINGS) {
      if (line.includes(needle)) {
        violations.push({ file: relPath, line: i + 1, message: `${message} ("${needle}")` });
      }
    }
  }
}

function checkPackageJsonPins(file, relPath, content) {
  if (!file.endsWith('package.json')) return;
  let pkg;
  try {
    pkg = JSON.parse(content);
  } catch {
    violations.push({ file: relPath, line: 1, message: 'not valid JSON' });
    return;
  }
  const lines = content.split('\n');
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (!name.startsWith('@guuey/') && !name.startsWith('@silverprotocol/')) continue;
      if (Object.prototype.hasOwnProperty.call(versions, name)) continue;
      const lineIndex = lines.findIndex((l) => l.includes(`"${name}"`));
      violations.push({
        file: relPath,
        line: lineIndex >= 0 ? lineIndex + 1 : 1,
        message: `internal dependency "${name}" is missing from templates-src/versions.json`,
      });
    }
  }
}

for (const file of walkFiles(distTemplatesDir)) {
  const relPath = relative(packageRoot, file);
  const buf = readFileSync(file);
  if (!isProbablyText(buf)) continue;
  const content = buf.toString('utf8');
  checkBannedSubstrings(file, relPath, content);
  checkPackageJsonPins(file, relPath, content);
}

if (violations.length > 0) {
  console.error(`check-templates: ${violations.length} violation(s) found in dist/templates:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}: ${v.message}`);
  }
  process.exit(1);
}

console.log('check-templates: dist/templates is publish-clean.');
