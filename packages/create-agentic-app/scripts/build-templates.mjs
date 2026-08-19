#!/usr/bin/env node
/**
 * Assembles `dist/templates/<template>/<framework>/**` from `templates-src/`.
 *
 * Layering, per (template × framework), in order — later layers win:
 *
 *   1. `templates-src/core/`             the agent side shared by every
 *                                        template: mcps/, prompts/, scripts/
 *                                        (dev + bootstrap), guuey.app.json +
 *                                        schema, AGENTS.md, workspace config.
 *   2. `templates-src/mcp-base/`         gap-fill into `mcps/todo/` only
 *                                        (`force:false` — the todo overlay in
 *                                        core wins; mcp-base supplies what the
 *                                        overlay doesn't have), then the name
 *                                        token resolves to `todo`.
 *   3. `templates-src/apps/base/`        the web app every template shares
 *                                        (3 pages + chat on @guuey/chat).
 *   4. `templates-src/apps/<template>/`  for non-base templates: overlay files
 *                                        win; `.overlay-remove` (one
 *                                        project-relative path per line)
 *                                        DELETES superseded base files — a
 *                                        listed path that does not exist fails
 *                                        the build (stale entries are bugs).
 *   5. `templates-src/frameworks/<fw>/`  the framework overlay (root
 *                                        package.json, guuey.json, worker src).
 *   6. Stamps: `versions.json` pins into every package.json;
 *      `MODEL_PLACEHOLDER` -> `defaultModelFor(<fw>)` in guuey.json.
 *
 * Templates are DISCOVERED from `templates-src/apps/*` ('base' must exist);
 * frameworks from `templates-src/frameworks/*`. Separately,
 * `templates-src/mcp-base/` is emitted verbatim (versions stamped,
 * `NAME_PLACEHOLDER` deliberately UNresolved) to `dist/templates/mcp-base/`
 * — the shared starter `guuey mcp new` scaffolds from, resolving the name
 * token at scaffold time.
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
const coreDir = join(templatesSrcDir, 'core');
const appsDir = join(templatesSrcDir, 'apps');
const frameworksDir = join(templatesSrcDir, 'frameworks');
const mcpBaseDir = join(templatesSrcDir, 'mcp-base');
const versionsPath = join(templatesSrcDir, 'versions.json');
const distTemplatesDir = join(packageRoot, 'dist', 'templates');

/** @type {Record<string, string>} */
const versions = JSON.parse(readFileSync(versionsPath, 'utf8'));

function listDirs(root) {
  return readdirSync(root, { withFileTypes: true })
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

/** Apply a template overlay: copy (overlay wins), then process `.overlay-remove`. */
function applyTemplateOverlay(template, outDir) {
  const overlayDir = join(appsDir, template);
  const removeManifest = join(overlayDir, '.overlay-remove');

  cpSync(overlayDir, outDir, {
    recursive: true,
    filter: (src) => !src.endsWith('.overlay-remove'),
  });

  if (!existsSync(removeManifest)) return;
  const entries = readFileSync(removeManifest, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  for (const entry of entries) {
    const target = join(outDir, entry);
    if (!existsSync(target)) {
      throw new Error(
        `templates-src/apps/${template}/.overlay-remove lists "${entry}" but the assembled tree has no such file — stale entry, fix the manifest.`,
      );
    }
    rmSync(target, { recursive: true });
  }
}

function assemble(template, framework) {
  const outDir = join(distTemplatesDir, template, framework);
  mkdirSync(outDir, { recursive: true });
  cpSync(coreDir, outDir, { recursive: true });

  // `mcps/todo` = mcp-base + todo overlay. The overlay (core/mcps/todo/) was
  // just copied above and wins; `force: false` makes this second copy only
  // fill in files the overlay doesn't provide (tsconfig.json, Dockerfile).
  const todoDir = join(outDir, 'mcps', 'todo');
  cpSync(mcpBaseDir, todoDir, { recursive: true, force: false });
  stampNamePlaceholder(todoDir, 'todo');

  cpSync(join(appsDir, 'base'), outDir, { recursive: true });
  if (template !== 'base') applyTemplateOverlay(template, outDir);

  cpSync(join(frameworksDir, framework), outDir, { recursive: true });

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

const templates = listDirs(appsDir);
if (!templates.includes('base')) {
  throw new Error('templates-src/apps/ must contain the "base" template — every other template overlays it.');
}
const frameworks = listDirs(frameworksDir);
for (const template of templates) {
  for (const framework of frameworks) {
    assemble(template, framework);
  }
}
emitMcpBase();

console.log(
  `build-templates: assembled ${templates.map((t) => `${t}/{${frameworks.join(',')}}`).join(' + ')}, mcp-base -> ${distTemplatesDir}`,
);
