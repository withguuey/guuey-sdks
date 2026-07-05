#!/usr/bin/env node
/**
 * Assembles `dist/templates/<framework>/**` from `templates-src/`:
 *
 *   1. Recursive copy `templates-src/base/` -> `dist/templates/<fw>/`.
 *   2. Fill `dist/templates/<fw>/mcps/todo/` gaps (currently `tsconfig.json`
 *      + `Dockerfile`) from `templates-src/mcp-base/` — the todo overlay
 *      under `templates-src/base/mcps/todo/` (`package.json` +
 *      `src/server.ts`) already exists at this point and wins; mcp-base only
 *      supplies what the overlay doesn't have.
 *   3. Copy `templates-src/frameworks/<fw>/` over it (overlay wins;
 *      base-only files are left untouched).
 *   4. Rewrite every assembled `package.json`'s `dependencies` /
 *      `devDependencies` entries that appear in `templates-src/versions.json`
 *      to the exact pinned version (no `workspace:*`, no placeholder).
 *   5. Replace `MODEL_PLACEHOLDER` in the assembled `guuey.json` with
 *      `defaultModelFor(<fw>)` from `@guuey/config`.
 *   6. Replace `NAME_PLACEHOLDER` under `mcps/todo/` with the literal `todo`
 *      (the only mcp-base-contributed file that still carries the token
 *      after the overlay wins is the Dockerfile's doc comments).
 *
 * Separately, `templates-src/mcp-base/` is also emitted verbatim (versions
 * stamped, `NAME_PLACEHOLDER` left UNresolved) to `dist/templates/mcp-base/`
 * — this is the shared starter `guuey mcp new` scaffolds from, resolving the
 * name token at scaffold time.
 *
 * `check-templates.mjs` (run right after this in the `build` script) is the
 * publish guard that fails the build if any of the above leaks through.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultModelFor } from '@guuey/config';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const templatesSrcDir = join(packageRoot, 'templates-src');
const baseDir = join(templatesSrcDir, 'base');
const frameworksDir = join(templatesSrcDir, 'frameworks');
const mcpBaseDir = join(templatesSrcDir, 'mcp-base');
const versionsPath = join(templatesSrcDir, 'versions.json');
const distTemplatesDir = join(packageRoot, 'dist', 'templates');

/** @type {Record<string, string>} */
const versions = JSON.parse(readFileSync(versionsPath, 'utf8'));

function listFrameworks() {
  return readdirSync(frameworksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

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

/** Stamp `versions.json`-pinned deps into an assembled `package.json`. */
function stampVersions(pkgJsonPath) {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (Object.prototype.hasOwnProperty.call(versions, name)) {
        deps[name] = versions[name];
      }
    }
  }
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

/** Stamp `defaultModelFor(framework)` into the assembled `guuey.json`. */
function stampModel(guueyJsonPath, framework) {
  const model = defaultModelFor(framework);
  const raw = readFileSync(guueyJsonPath, 'utf8');
  writeFileSync(guueyJsonPath, raw.replaceAll('MODEL_PLACEHOLDER', model), 'utf8');
}

/** Replace a literal `NAME_PLACEHOLDER` token with `name` across every text file under `dir`. */
function stampNamePlaceholder(dir, name) {
  for (const file of walkFiles(dir)) {
    const content = readFileSync(file, 'utf8');
    if (content.includes('NAME_PLACEHOLDER')) {
      writeFileSync(file, content.replaceAll('NAME_PLACEHOLDER', name), 'utf8');
    }
  }
}

function assembleFramework(framework) {
  const outDir = join(distTemplatesDir, framework);
  mkdirSync(outDir, { recursive: true });
  cpSync(baseDir, outDir, { recursive: true });

  // `mcps/todo` = mcp-base + todo overlay. The overlay (base/mcps/todo/) was
  // just copied above and wins; `force: false` makes this second copy only
  // fill in files the overlay doesn't provide (tsconfig.json, Dockerfile).
  const todoDir = join(outDir, 'mcps', 'todo');
  cpSync(mcpBaseDir, todoDir, { recursive: true, force: false });
  stampNamePlaceholder(todoDir, 'todo');

  const overlayDir = join(frameworksDir, framework);
  cpSync(overlayDir, outDir, { recursive: true });

  for (const file of walkFiles(outDir)) {
    if (file.endsWith('package.json')) stampVersions(file);
  }

  const guueyJsonPath = join(outDir, 'guuey.json');
  if (existsSync(guueyJsonPath)) stampModel(guueyJsonPath, framework);
}

/**
 * Emit `templates-src/mcp-base/` verbatim to `dist/templates/mcp-base/` for
 * `guuey mcp new` to scaffold from directly. Dependency versions are
 * stamped like every other template; `NAME_PLACEHOLDER` is deliberately left
 * UNresolved — the mcp scaffolder resolves it to the requested server name
 * at scaffold time (see the Task-7 `scaffoldMcp` helper).
 */
function emitMcpBase() {
  const outDir = join(distTemplatesDir, 'mcp-base');
  mkdirSync(outDir, { recursive: true });
  cpSync(mcpBaseDir, outDir, { recursive: true });

  for (const file of walkFiles(outDir)) {
    if (file.endsWith('package.json')) stampVersions(file);
  }
}

rmSync(distTemplatesDir, { recursive: true, force: true });
mkdirSync(distTemplatesDir, { recursive: true });

const frameworks = listFrameworks();
for (const framework of frameworks) {
  assembleFramework(framework);
}
emitMcpBase();

console.log(`build-templates: assembled ${frameworks.join(', ')}, mcp-base -> ${distTemplatesDir}`);
