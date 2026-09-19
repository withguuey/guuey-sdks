/**
 * guuey#1435 — the pack reachability guard, red-first against the two shapes
 * that shipped (agent-client's fixtures at 898aa5d17^, chat's corpus at
 * 33a2899b0^) and the controls that prove it judges reachability, not names.
 *
 * Every case is a real package in a temp dir whose pack listing comes from
 * npm itself: the `files` semantics are npm's and are not re-implemented here,
 * so a case exercises the same listing the publisher packs.
 *
 * Run: node --test 'scripts/*.test.mjs' (pnpm test:scripts).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyzePackage, entryPoints } from './check-pack-reachability.mjs';

const RN_ARM = { 'react-native': './src/index.ts', types: './dist/index.d.ts', import: './dist/index.js', default: './dist/index.js' };
const DIST_ARM = { types: './dist/index.d.ts', import: './dist/index.js', default: './dist/index.js' };
const SRC_FILES = ['dist', 'src', '!src/**/*.test.ts', '!src/**/*.test.tsx'];

const dmap = (file, source) => JSON.stringify({ version: 3, file, sourceRoot: '', sources: [source], names: [], mappings: '' });

/** The minimal two-module package: dist + src twins, declaration maps, a test file that never ships. */
const BASE = {
  'dist/index.js': "import { sse } from './sse.js';\nexport { sse };\n",
  'dist/index.d.ts': "import type { Sse } from './sse.js';\nexport declare const sse: Sse;\n",
  'dist/index.d.ts.map': dmap('index.d.ts', '../src/index.ts'),
  'dist/sse.js': 'export const sse = 1;\n',
  'dist/sse.d.ts': 'export type Sse = number;\nexport declare const sse: Sse;\n',
  'dist/sse.d.ts.map': dmap('sse.d.ts', '../src/sse.ts'),
  'src/index.ts': "import { sse } from './sse.js';\nexport { sse };\n",
  'src/sse.ts': 'export type Sse = number;\nexport const sse: Sse = 1;\n',
  'src/sse.test.ts': "import { sse } from './sse.js';\nsse;\n",
  'README.md': '# shape\n',
  LICENSE: 'MIT\n',
};

const dirs = [];
function pkg(name, manifest, files) {
  const dir = mkdtempSync(join(tmpdir(), 'pack-reach-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module', ...manifest }, null, 2));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const found = (r) => r.findings.map((f) => f.file).sort();

test('agent-client at 898aa5d17^: the fixture json, its writer and the compiled writer ship, and nothing reaches them', () => {
  const dir = pkg(
    '@shape/agent-client-red',
    { files: SRC_FILES, exports: { '.': RN_ARM } },
    {
      ...BASE,
      'src/fixtures/widget-invoke-bodies.json': '[]\n',
      'src/fixtures/write-widget-invoke-bodies.ts': "import { writeFileSync } from 'node:fs';\nwriteFileSync('bodies.json', '[]');\n",
      'dist/fixtures/write-widget-invoke-bodies.js': "import { writeFileSync } from 'node:fs';\nwriteFileSync('bodies.json', '[]');\n",
      'dist/fixtures/write-widget-invoke-bodies.d.ts': 'export {};\n',
    }
  );
  assert.deepEqual(found(analyzePackage(dir)), [
    'dist/fixtures/write-widget-invoke-bodies.d.ts',
    'dist/fixtures/write-widget-invoke-bodies.js',
    'src/fixtures/widget-invoke-bodies.json',
    'src/fixtures/write-widget-invoke-bodies.ts',
  ]);
});

test('agent-client at 898aa5d17: fixtures out of `files` and out of the build — green, 11 shipped', () => {
  const dir = pkg(
    '@shape/agent-client-green',
    { files: [...SRC_FILES, '!src/fixtures/**'], exports: { '.': RN_ARM } },
    {
      ...BASE,
      'src/fixtures/widget-invoke-bodies.json': '[]\n',
      'src/fixtures/write-widget-invoke-bodies.ts': "import { writeFileSync } from 'node:fs';\n",
    }
  );
  const r = analyzePackage(dir);
  assert.deepEqual(r.findings, []);
  assert.equal(r.shipped, 11); // 6 dist + 2 src (the test never ships) + package.json + README + LICENSE
  assert.equal(r.unfollowed.length, 0);
});

test('chat at 33a2899b0^: the recorded corpus ships — captures, a snapshot, the harness — and only a test imports it', () => {
  const dir = pkg(
    '@shape/chat-red',
    { files: [...SRC_FILES, 'styles.css'], exports: { '.': RN_ARM, './styles.css': './styles.css' } },
    {
      ...BASE,
      'styles.css': '.x{}\n',
      'src/corpus/turn-1.sse': 'data: {}\n\n',
      'src/corpus/turn-1.json': '{}\n',
      'src/corpus/__snapshots__/plan.corpus.test.ts.snap': 'exports[`x`] = `y`;\n',
      'src/corpus/harness.ts': "import { readFileSync } from 'node:fs';\nexport const load = (n: string) => readFileSync(n, 'utf8');\n",
      'src/plan.corpus.test.ts': "import { load } from './corpus/harness.js';\nload('turn-1.sse');\n",
    }
  );
  assert.deepEqual(found(analyzePackage(dir)), [
    'src/corpus/__snapshots__/plan.corpus.test.ts.snap',
    'src/corpus/harness.ts',
    'src/corpus/turn-1.json',
    'src/corpus/turn-1.sse',
  ]);
});

test('chat at 33a2899b0: the corpus excluded — green; the styles.css exports arm is reachable as a target', () => {
  const dir = pkg(
    '@shape/chat-green',
    { files: [...SRC_FILES, '!src/corpus/**', 'styles.css'], exports: { '.': RN_ARM, './styles.css': './styles.css' } },
    { ...BASE, 'styles.css': '.x{}\n', 'src/corpus/turn-1.sse': 'data: {}\n\n' }
  );
  const r = analyzePackage(dir);
  assert.deepEqual(r.findings, []);
  assert.ok(r.entries.includes('styles.css'));
});

test('a directory named fixtures that IS imported is not a finding — reachability, not a name heuristic', () => {
  const dir = pkg(
    '@shape/fixtures-real',
    { files: SRC_FILES, exports: { '.': RN_ARM } },
    {
      'dist/index.js': "import { real } from './fixtures/real.js';\nexport { real };\n",
      'dist/index.d.ts': "export { real } from './fixtures/real.js';\n",
      'dist/index.d.ts.map': dmap('index.d.ts', '../src/index.ts'),
      'dist/fixtures/real.js': 'export const real = 1;\n',
      'dist/fixtures/real.d.ts': 'export declare const real: number;\n',
      'dist/fixtures/real.d.ts.map': dmap('real.d.ts', '../../src/fixtures/real.ts'),
      'src/index.ts': "import { real } from './fixtures/real.js';\nexport { real };\n",
      'src/fixtures/real.ts': 'export const real = 1;\n',
      'README.md': '# shape\n',
    }
  );
  assert.deepEqual(analyzePackage(dir).findings, []);
});

test('type-only and dynamic (string-literal) imports keep a file reachable', () => {
  const dir = pkg(
    '@shape/type-and-dynamic',
    { files: ['dist'], exports: { '.': DIST_ARM } },
    {
      'dist/index.js': "export const load = () => import('./lazy.js');\n",
      'dist/index.d.ts': "import type { Lazy } from './types-only.js';\nexport declare const load: () => Promise<Lazy>;\n",
      'dist/lazy.js': 'export default 1;\n',
      'dist/types-only.d.ts': 'export interface Lazy { n: number }\n',
    }
  );
  const r = analyzePackage(dir);
  assert.deepEqual(r.findings, []);
  assert.equal(r.reachable, 4);
});

test('a src tree with no react-native arm is reached through the declaration maps alone; a src file no map names is not', () => {
  const dir = pkg(
    '@shape/agent-layout-like',
    { files: SRC_FILES, exports: { '.': DIST_ARM } },
    { ...BASE, 'src/orphan.ts': 'export const orphan = 1;\n' }
  );
  assert.deepEqual(found(analyzePackage(dir)), ['src/orphan.ts']);
});

test('a tree read with fs at run time is a finding until declared with a reason; a declaration nothing falls under is a finding', () => {
  const name = '@shape/templates';
  const dir = pkg(
    name,
    { files: ['dist'], main: './dist/index.js', bin: { x: './dist/cli.js' } },
    {
      'dist/index.js':
        "import { readFileSync } from 'node:fs';\nexport const t = () => readFileSync(new URL('./templates/base/package.json', import.meta.url), 'utf8');\n",
      'dist/cli.js': "import { t } from './index.js';\nt();\n",
      'dist/templates/base/package.json': '{}\n',
    }
  );
  assert.deepEqual(found(analyzePackage(dir, { runtimeAssets: {} })), ['dist/templates/base/package.json']);
  assert.deepEqual(analyzePackage(dir, { runtimeAssets: { [name]: [{ prefix: 'dist/templates/', reason: 'read with fs' }] } }).findings, []);
  assert.deepEqual(found(analyzePackage(dir, { runtimeAssets: { [name]: [{ prefix: 'dist/nothing/', reason: 'stale' }] } })), [
    'dist/nothing/',
    'dist/templates/base/package.json',
  ]);
});

test('an entry point the pack does not ship, and a shipped module importing an excluded file, are findings', () => {
  const dir = pkg(
    '@shape/broken-edges',
    { files: ['dist', '!dist/helper.js'], exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' }, './missing': './dist/missing.js' } },
    {
      'dist/index.js': "import { h } from './helper.js';\nexport { h };\n",
      'dist/index.d.ts': 'export declare const h: number;\n',
      'dist/helper.js': 'export const h = 1;\n',
    }
  );
  const r = analyzePackage(dir);
  assert.deepEqual(found(r), ['dist/index.js', 'dist/missing.js']);
  assert.match(r.findings.find((f) => f.file === 'dist/missing.js').why, /not in the pack/);
  assert.match(r.findings.find((f) => f.file === 'dist/index.js').why, /does not ship/);
});

test('a computed specifier is reported as not followed, never as a finding', () => {
  const dir = pkg(
    '@shape/computed',
    { files: ['dist'], exports: { '.': { import: './dist/index.js' } } },
    { 'dist/index.js': "export const load = (n) => import('./' + n);\n" }
  );
  const r = analyzePackage(dir);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.unfollowed, [{ file: 'dist/index.js', spec: '<computed> line 1' }]);
});

test('a load by computed path — import(registry[name].module) — is surfaced as not followed; its modules are findings until declared as runtime entries, which are then walked', () => {
  const name = '@shape/runner-registry';
  const dir = pkg(
    name,
    { files: ['dist'], exports: { '.': { import: './dist/index.js' } } },
    {
      'dist/index.js': "const RUNNERS = { a: { module: './runners/a.js' } };\nexport const load = (n) => import(RUNNERS[n].module);\n",
      'dist/runners/a.js': "import { shared } from '../shared.js';\nexport const createRunner = () => shared;\n",
      'dist/shared.js': 'export const shared = 1;\n',
    }
  );
  const red = analyzePackage(dir, { runtimeEntries: {} });
  assert.deepEqual(found(red), ['dist/runners/a.js', 'dist/shared.js']);
  assert.deepEqual(red.unfollowed, [{ file: 'dist/index.js', spec: '<computed> line 2' }]);
  const green = analyzePackage(dir, { runtimeEntries: { [name]: [{ file: 'dist/runners/a.js', reason: 'the RUNNERS table' }] } });
  assert.deepEqual(green.findings, []);
  assert.equal(green.reachable, 3);
  assert.equal(green.declared, 1);
  const stale = analyzePackage(dir, { runtimeEntries: { [name]: [{ file: 'dist/runners/b.js', reason: 'gone' }] } });
  assert.deepEqual(found(stale), ['dist/runners/a.js', 'dist/runners/b.js', 'dist/shared.js']);
});

test('the CommonJS twin of an entry is reachable through its condition; a twin nothing names is not (the tsup dual-output shape)', () => {
  const dir = pkg(
    '@shape/dual-output',
    { files: ['dist'], exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.cjs' } }, bin: { x: './dist/cli.js' } },
    {
      'dist/index.js': 'export const a = 1;\n',
      'dist/index.d.ts': 'export declare const a: number;\n',
      'dist/index.cjs': 'exports.a = 1;\n',
      'dist/index.d.cts': 'export declare const a: number;\n',
      'dist/cli.js': "import { a } from './index.js';\nconsole.log(a);\n",
      'dist/cli.cjs': "const { a } = require('./index.cjs');\nconsole.log(a);\n",
      'dist/cli.d.cts': 'export {};\n',
    }
  );
  assert.deepEqual(found(analyzePackage(dir)), ['dist/cli.cjs', 'dist/cli.d.cts']);
});

test('entry points: a string exports plus bin (the bare-name forwarder shape); a subpath pattern is refused', () => {
  assert.deepEqual(entryPoints({ name: 'guuey', exports: './index.js', bin: { guuey: './bin.js' } }), ['index.js', 'bin.js']);
  assert.throws(() => entryPoints({ name: 'x', exports: { './*': './dist/*.js' } }), /pattern/);
});
