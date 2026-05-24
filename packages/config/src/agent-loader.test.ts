import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_JSON_FILENAME,
  AgentJsonLoadError,
  findAgentJson,
  loadAgentJson,
  safeLoadAgentJson,
} from './agent-loader.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-json-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeAgent(json: unknown): string {
  const path = join(dir, AGENT_JSON_FILENAME);
  writeFileSync(path, JSON.stringify(json));
  return path;
}

describe('loadAgentJson — minimal doc', () => {
  it('loads {schema: "1"} cleanly', () => {
    const path = writeAgent({ schema: '1' });
    const doc = loadAgentJson(path);
    expect(doc.schema).toBe('1');
    expect(doc.systemPrompt).toBeUndefined();
  });
});

describe('loadAgentJson — inline systemPrompt', () => {
  it('passes inline string through unchanged', () => {
    const path = writeAgent({ schema: '1', systemPrompt: 'Be helpful.' });
    const doc = loadAgentJson(path);
    expect(doc.systemPrompt).toBe('Be helpful.');
  });
});

describe('loadAgentJson — file-ref systemPrompt', () => {
  it('inlines the referenced file contents (trimmed)', () => {
    mkdirSync(join(dir, 'prompts'));
    writeFileSync(
      join(dir, 'prompts', 'system.md'),
      '\nYou are a docs agent.\n\n',
    );
    const path = writeAgent({
      schema: '1',
      systemPrompt: { file: 'prompts/system.md' },
    });
    const doc = loadAgentJson(path);
    expect(doc.systemPrompt).toBe('You are a docs agent.');
  });

  it('rejects an absolute path', () => {
    const path = writeAgent({
      schema: '1',
      systemPrompt: { file: '/etc/passwd' },
    });
    const result = safeLoadAgentJson(path);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/must be a relative path/);
    }
  });

  it('rejects a parent-directory escape', () => {
    const path = writeAgent({
      schema: '1',
      systemPrompt: { file: '../escape.md' },
    });
    const result = safeLoadAgentJson(path);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/outside the project directory/);
    }
  });

  it('reports a missing prompt file with the resolved path', () => {
    const path = writeAgent({
      schema: '1',
      systemPrompt: { file: 'prompts/missing.md' },
    });
    const result = safeLoadAgentJson(path);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/does not exist/);
    }
  });
});

describe('loadAgentJson — error envelopes', () => {
  it('reports a missing file with the AgentJsonLoadError class', () => {
    expect(() => loadAgentJson(join(dir, 'missing.json'))).toThrow(
      AgentJsonLoadError,
    );
  });

  it('reports malformed JSON', () => {
    const path = join(dir, AGENT_JSON_FILENAME);
    writeFileSync(path, '{not json');
    const result = safeLoadAgentJson(path);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/not valid JSON/);
    }
  });

  it('reports schema validation failure', () => {
    const path = writeAgent({ schema: '2' });
    const result = safeLoadAgentJson(path);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/schema validation/);
    }
  });
});

describe('findAgentJson — upward walk', () => {
  it('returns null when no file is found in the chain', () => {
    const sub = join(dir, 'a', 'b', 'c');
    mkdirSync(sub, { recursive: true });
    expect(findAgentJson(sub)).toBeNull();
  });

  it('finds an agent.json in a parent directory', () => {
    writeAgent({ schema: '1' });
    const sub = join(dir, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    const found = findAgentJson(sub);
    expect(found).toBe(join(dir, AGENT_JSON_FILENAME));
  });
});
