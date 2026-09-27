/**
 * The one provider-key resolver `guuey dev` and the scaffolded project's
 * `bootstrap` / `dev` scripts share (guuey#1908): the `.env.local` parse
 * table, the precedence (shell env, then `.env.local`), and the framework
 * read from `guuey.json`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROVIDER_KEY_ENV_VAR,
  DEFAULT_AGENT_FRAMEWORK,
  AGENT_FRAMEWORKS,
  parseEnvLocal,
  resolveProviderKey,
  resolveProjectProviderKey,
  missingProviderKeyMessage,
} from './index.js';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'provider-key-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseEnvLocal', () => {
  it.each([
    ['KEY=value', 'value'],
    ['KEY = value ', 'value'],
    ['  KEY=value', 'value'],
    ['KEY="quoted value"', 'quoted value'],
    ["KEY='single'", 'single'],
    ['KEY=value\r', 'value'],
    ['KEY=', ''],
    ['KEY=a=b=c', 'a=b=c'],
    ['KEY="', '"'],
  ])('%j → %j', (line, expected) => {
    expect(parseEnvLocal(`${line}\n`).KEY).toBe(expected);
  });

  it('skips comments, blank lines and lines without "="; the last duplicate wins', () => {
    const parsed = parseEnvLocal('# a comment\n\nNOEQUALS\nKEY=first\nKEY=second\n');
    expect(parsed).toEqual({ KEY: 'second' });
  });

  it('does not read an `export ` prefix as the key (a stated limit, shared by every check)', () => {
    expect(parseEnvLocal('export KEY=value\n').KEY).toBeUndefined();
  });
});

describe('resolveProviderKey', () => {
  it('maps every framework to its key variable', () => {
    for (const f of AGENT_FRAMEWORKS) expect(typeof PROVIDER_KEY_ENV_VAR[f]).toBe('string');
    expect(PROVIDER_KEY_ENV_VAR['claude-agent-sdk']).toBe('ANTHROPIC_API_KEY');
    expect(PROVIDER_KEY_ENV_VAR['openai-agents-sdk']).toBe('OPENAI_API_KEY');
    expect(PROVIDER_KEY_ENV_VAR['google-adk']).toBe('GEMINI_API_KEY');
  });

  it('the shell environment wins over .env.local', () => {
    const root = project({ '.env.local': 'ANTHROPIC_API_KEY=from-file\n' });
    const r = resolveProviderKey(root, 'claude-agent-sdk', { ANTHROPIC_API_KEY: 'from-env' });
    expect(r).toEqual({ framework: 'claude-agent-sdk', varName: 'ANTHROPIC_API_KEY', value: 'from-env', source: 'env' });
  });

  it('an empty shell value falls through to .env.local', () => {
    const root = project({ '.env.local': 'OPENAI_API_KEY="sk-file"\n' });
    const r = resolveProviderKey(root, 'openai-agents-sdk', { OPENAI_API_KEY: '' });
    expect(r.value).toBe('sk-file');
    expect(r.source).toBe('env-local');
  });

  it('an empty .env.local value, another framework\'s key, or no file is no key', () => {
    expect(resolveProviderKey(project({ '.env.local': 'GEMINI_API_KEY=\n' }), 'google-adk', {}).value).toBeNull();
    expect(resolveProviderKey(project({ '.env.local': 'ANTHROPIC_API_KEY=x\n' }), 'google-adk', {}).value).toBeNull();
    const none = resolveProviderKey(project({}), 'claude-agent-sdk', {});
    expect(none).toEqual({ framework: 'claude-agent-sdk', varName: 'ANTHROPIC_API_KEY', value: null, source: null });
  });
});

describe('resolveProjectProviderKey', () => {
  it('reads the framework from guuey.json', () => {
    const root = project({
      'guuey.json': JSON.stringify({ schema: '1', agent: { mode: 'declarative', framework: 'google-adk' } }),
      '.env.local': 'GEMINI_API_KEY=g-key\n',
    });
    expect(resolveProjectProviderKey(root, {})).toMatchObject({ framework: 'google-adk', varName: 'GEMINI_API_KEY', value: 'g-key' });
  });

  it('a guuey.json with no framework runs the default', () => {
    const root = project({ 'guuey.json': JSON.stringify({ schema: '1', agent: { mode: 'declarative' } }) });
    const r = resolveProjectProviderKey(root, {});
    expect(r.framework).toBe(DEFAULT_AGENT_FRAMEWORK);
    expect(r.varName).toBe('ANTHROPIC_API_KEY');
  });

  it('a missing guuey.json throws what the loader throws', () => {
    expect(() => resolveProjectProviderKey(project({}), {})).toThrow(/guuey\.json not found/);
  });
});

describe('missingProviderKeyMessage', () => {
  it('names the variable and both places it may be set', () => {
    expect(missingProviderKeyMessage('ANTHROPIC_API_KEY')).toBe(
      'Missing ANTHROPIC_API_KEY — set it in your shell environment or in .env.local at the project root.',
    );
  });
});
