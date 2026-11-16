#!/usr/bin/env node
/**
 * Copies the Python host (`src/python/guuey_host/*.py`) into `dist/python/guuey_host/`, so it ships inside
 * @guuey/host (guuey#3517). The worker image's pinned Python 3.15.2 interpreter runs that tree; the image gets it
 * through the same `pnpm deploy` of the workspace as the JS host, so npm and the image carry the same bytes.
 *
 * A fixed allowlist: only the package's own `*.py` modules. Never the tests (`src/python/tests/`), the golden corpus
 * (`src/python/golden/`), `test_*.py`, `__pycache__` or `*.pyc`. Node built-ins only (the public mirror installs with a
 * frozen lockfile). It fails loudly when the source is missing or the copy comes out empty: a build that ships no
 * Python host is a broken build, never a quiet one.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(packageRoot, 'src', 'python', 'guuey_host');
const targetDir = join(packageRoot, 'dist', 'python', 'guuey_host');

/** The module files a build ships: `*.py` directly in the package directory, never a test module. */
export function shippedModules(names) {
  return names.filter((name) => name.endsWith('.py') && !name.startsWith('test_')).sort();
}

function main() {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new Error(`build-python: the Python host source is missing: ${sourceDir}`);
  }
  const modules = shippedModules(
    readdirSync(sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );
  if (!modules.includes('__init__.py') || modules.length < 2) {
    throw new Error(`build-python: the copy would ship no Python host (found: ${modules.join(', ') || 'nothing'})`);
  }
  rmSync(join(packageRoot, 'dist', 'python'), { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  for (const name of modules) copyFileSync(join(sourceDir, name), join(targetDir, name));
  const copied = readdirSync(targetDir);
  if (copied.length !== modules.length) {
    throw new Error(`build-python: copied ${copied.length} files, expected ${modules.length}`);
  }
  console.log(`build-python: ${modules.length} modules -> dist/python/guuey_host/`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
