import { describe, expect, it } from 'vitest';
import { deployEnv, parseEnvFileText, substitutedLine } from './deploy-env';

describe('parseEnvFileText', () => {
  it('reads NAME=value lines, export prefixes, quotes and comments', () => {
    const vars = parseEnvFileText(
      [
        '# staging',
        '',
        'MCP_URL=https://mcp.staging.example.com/mcp',
        'export ISSUER_URL="https://id.example.com/pool # not a comment"',
        "AUDIENCE='client'",
        'PLAIN=value # trailing comment',
      ].join('\n'),
      '.env.staging',
    );
    expect(Object.fromEntries(vars)).toEqual({
      MCP_URL: 'https://mcp.staging.example.com/mcp',
      ISSUER_URL: 'https://id.example.com/pool # not a comment',
      AUDIENCE: 'client',
      PLAIN: 'value',
    });
  });

  it('refuses a malformed line or a repeated name, naming the line but never a value', () => {
    expect(() => parseEnvFileText('A=1\nnot-a-line', '.env')).toThrow('.env:2: expected NAME=value');
    expect(() => parseEnvFileText('A=secret-one\nA=secret-two', '.env')).toThrow(/^\.env:2: A is set twice$/);
  });
});

describe('deployEnv', () => {
  const read = (text: string) => () => text;

  it('without --env-file is the process environment itself', () => {
    const env = { A: '1' };
    expect(deployEnv({}, env)).toBe(env);
  });

  it('adds the file to the process environment', () => {
    expect(deployEnv({ 'env-file': '.env' }, { A: '1' }, read('B=2'))).toEqual({ A: '1', B: '2' });
  });

  it('agrees when both set the same value; refuses different values, naming only the variable', () => {
    expect(deployEnv({ 'env-file': '.env' }, { B: '2' }, read('B=2'))).toEqual({ B: '2' });
    expect(() => deployEnv({ 'env-file': '.env' }, { B: 'shell-value' }, read('B=file-value'))).toThrow(
      /^B is set both in the environment and in \.env with different values/,
    );
  });

  it('a shell variable set to the empty string counts as unset', () => {
    expect(deployEnv({ 'env-file': '.env' }, { B: '' }, read('B=2'))).toEqual({ B: '2' });
  });

  it('a valueless --env-file is a usage error', () => {
    expect(() => deployEnv({ 'env-file': true }, {})).toThrow('--env-file needs a path');
  });
});

describe('substitutedLine', () => {
  it('names the variables, never values', () => {
    expect(substitutedLine(['A', 'B'])).toBe('  ${env.*} resolved from the environment: A, B');
  });
});
