import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GuueyJsonV1 } from './schema.js';
import {
  findGuueyJson,
  GuueyJsonLoadError,
  loadGuueyJson,
  safeLoadGuueyJson,
  saveGuueyJson,
} from './loader.js';

const MINIMAL_V1: GuueyJsonV1 = {
  schema: '1',
  deployments: [],
};

describe('guuey.json loader — filesystem round-trip', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'guuey-json-test-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('save → load round-trips a valid document', () => {
    const path = join(workDir, 'guuey.json');
    saveGuueyJson(path, MINIMAL_V1);
    const loaded = loadGuueyJson(path);
    expect(loaded).toEqual(MINIMAL_V1);
  });

  it('save writes a trailing newline + 2-space indent', () => {
    const path = join(workDir, 'guuey.json');
    saveGuueyJson(path, MINIMAL_V1);
    // Read raw, not through loadGuueyJson, so we see the exact byte
    // layout rather than the parsed object.
    const raw = readFileSync(path, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  "schema": "1"');
  });

  it('save rejects an invalid document before writing', () => {
    const path = join(workDir, 'guuey.json');
    const bad = { ...MINIMAL_V1, schema: '2' as unknown as '1' };
    expect(() => saveGuueyJson(path, bad)).toThrow();
  });

  it('load throws GuueyJsonLoadError for a missing file', () => {
    const path = join(workDir, 'does-not-exist.json');
    try {
      loadGuueyJson(path);
      expect.unreachable('load should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GuueyJsonLoadError);
      expect((err as GuueyJsonLoadError).path).toBe(path);
    }
  });

  it('load throws GuueyJsonLoadError for malformed JSON', () => {
    const path = join(workDir, 'guuey.json');
    writeFileSync(path, '{not json', 'utf-8');
    try {
      loadGuueyJson(path);
      expect.unreachable('load should have thrown on bad JSON');
    } catch (err) {
      expect(err).toBeInstanceOf(GuueyJsonLoadError);
      expect((err as GuueyJsonLoadError).message).toMatch(
        /not valid JSON/,
      );
      // Underlying SyntaxError is preserved on `cause`.
      expect((err as GuueyJsonLoadError).cause).toBeInstanceOf(Error);
    }
  });

  it('load throws GuueyJsonLoadError for schema violations, preserving ZodError cause', () => {
    const path = join(workDir, 'guuey.json');
    writeFileSync(
      path,
      JSON.stringify({
        ...MINIMAL_V1,
        deployments: [{ target: 'local', url: 'not a url' }],
      }),
      'utf-8',
    );
    try {
      loadGuueyJson(path);
      expect.unreachable('load should have thrown on bad url');
    } catch (err) {
      expect(err).toBeInstanceOf(GuueyJsonLoadError);
      expect((err as GuueyJsonLoadError).message).toMatch(
        /failed schema validation/,
      );
      // Cause is a ZodError — we don't import ZodError directly to
      // avoid widening runtime deps, just check the shape.
      const cause = (err as GuueyJsonLoadError).cause as
        | { issues?: unknown }
        | undefined;
      expect(cause).toBeDefined();
      expect(Array.isArray(cause?.issues)).toBe(true);
    }
  });

  it('safeLoad returns a discriminated result on success', () => {
    const path = join(workDir, 'guuey.json');
    saveGuueyJson(path, MINIMAL_V1);
    const result = safeLoadGuueyJson(path);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schema).toBe('1');
      expect(result.data.deployments).toEqual([]);
    }
  });

  it('safeLoad returns a discriminated result on failure', () => {
    const path = join(workDir, 'missing.json');
    const result = safeLoadGuueyJson(path);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(GuueyJsonLoadError);
      expect(result.error.path).toBe(path);
    }
  });
});

describe('guuey.json loader — findGuueyJson upward walk', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'guuey-json-find-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('finds guuey.json in the start directory', () => {
    const path = join(workDir, 'guuey.json');
    saveGuueyJson(path, MINIMAL_V1);
    const found = findGuueyJson(workDir);
    expect(found).toBe(path);
  });

  it('finds guuey.json in a parent directory', () => {
    const nested = join(workDir, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    const rootPath = join(workDir, 'guuey.json');
    saveGuueyJson(rootPath, MINIMAL_V1);
    const found = findGuueyJson(nested);
    expect(found).toBe(rootPath);
  });

  it('returns null when no guuey.json exists above startDir', () => {
    // workDir was just mkdtemp'd under /tmp and contains nothing.
    // No guuey.json above /tmp either; cap the depth so the test
    // doesn't false-positive on anything in the dev user's home.
    const found = findGuueyJson(workDir, 2);
    expect(found).toBeNull();
  });

  it('honours maxDepth = 0 by searching only the start directory', () => {
    const nested = join(workDir, 'a');
    mkdirSync(nested, { recursive: true });
    // File is in workDir, not in nested.
    saveGuueyJson(join(workDir, 'guuey.json'), MINIMAL_V1);
    const found = findGuueyJson(nested, 0);
    expect(found).toBeNull();
  });
});
