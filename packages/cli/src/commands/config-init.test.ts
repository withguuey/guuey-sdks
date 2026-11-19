/**
 * `guuey config init` (guuey#3360): the guuey.json it writes is a new project's
 * stored definition, so it is born without generative UI. `ggui: false` opts out
 * of the platform-default server, as every create-agentic-app template does, and
 * the file parses through the real schema.
 *
 * `resolveConfig` is mocked so the test never reads the operator's own
 * `~/.guuey/config.json` (an app id there would be stamped into the file).
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectiveMcpServers, safeParseGuueyJson, type GuueyJsonV1 } from '@guuey/config';
import { configInit } from './config.js';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    resolveConfig: vi.fn(() => ({ host: 'https://guuey.test', apiUrl: 'https://api.guuey.test' })),
  };
});

/** The written file, parsed by the real schema (the referenced prompt file is not created here). */
function readInitDoc(dir: string): GuueyJsonV1 {
  const parsed = safeParseGuueyJson(JSON.parse(readFileSync(join(dir, 'guuey.json'), 'utf8')));
  if (!parsed.success) throw new Error(`guuey.json does not parse: ${parsed.error.message}`);
  return parsed.data;
}

let originalCwd: string;
let workDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'guuey-config-init-')));
  process.chdir(workDir);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('guuey config init (guuey#3360)', () => {
  it('writes mcpServers.ggui false, and the file parses with no GGUI server in effect', () => {
    configInit({});
    const written: unknown = JSON.parse(readFileSync(join(workDir, 'guuey.json'), 'utf8'));
    expect(written).toMatchObject({ schema: '1', agent: { mcpServers: { ggui: false } } });
    expect(written).not.toHaveProperty('ggui');

    const doc = readInitDoc(workDir);
    expect(doc.agent.mcpServers).toEqual({ ggui: false });
    expect(effectiveMcpServers(doc.agent.mcpServers)).toEqual({});
  });

  it('stamps an app id passed on the command line beside the opt-out', () => {
    configInit({ 'app-id': 'app_123' });
    const doc = readInitDoc(workDir);
    expect(doc.appId).toBe('app_123');
    expect(doc.agent.mcpServers).toEqual({ ggui: false });
  });
});
