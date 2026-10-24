import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { GuueyJsonV1 } from './schema.js';
import {
  isRuntimeReservedEnvName,
  RUNTIME_RESERVED_ENV_NAMES,
  validateAgentEnvNotReserved,
  withoutReservedEnvNames,
} from './reserved-env.js';

describe('RUNTIME_RESERVED_ENV_NAMES', () => {
  it('is the exact runtime-owned list: Node, OpenSSL, the sandbox switch, the loader names and GLIBC_TUNABLES', () => {
    expect([...RUNTIME_RESERVED_ENV_NAMES].sort()).toEqual(
      [
        'GLIBC_TUNABLES',
        'GUUEY_SANDBOX',
        'LD_ASSUME_KERNEL',
        'LD_AUDIT',
        'LD_BIND_NOT',
        'LD_BIND_NOW',
        'LD_DEBUG',
        'LD_DEBUG_OUTPUT',
        'LD_DYNAMIC_WEAK',
        'LD_HWCAP_MASK',
        'LD_LIBRARY_PATH',
        'LD_ORIGIN_PATH',
        'LD_PREFER_MAP_32BIT_EXEC',
        'LD_PRELOAD',
        'LD_PROFILE',
        'LD_PROFILE_OUTPUT',
        'LD_SHOW_AUXV',
        'LD_TRACE_LOADED_OBJECTS',
        'LD_USE_LOAD_BIAS',
        'LD_VERBOSE',
        'LD_WARN',
        'NODE_EXTRA_CA_CERTS',
        'NODE_OPTIONS',
        'NODE_PATH',
        'NODE_TLS_REJECT_UNAUTHORIZED',
        'OPENSSL_CONF',
        'OPENSSL_ENGINES',
        'OPENSSL_MODULES',
      ],
    );
    expect(new Set(RUNTIME_RESERVED_ENV_NAMES).size).toBe(RUNTIME_RESERVED_ENV_NAMES.length);
  });

  it('matches exactly and case-sensitively; an LD_ name outside the list stays settable', () => {
    expect(isRuntimeReservedEnvName('LD_PRELOAD')).toBe(true);
    expect(isRuntimeReservedEnvName('GLIBC_TUNABLES')).toBe(true);
    expect(isRuntimeReservedEnvName('LD_SDK_KEY')).toBe(false);
    expect(isRuntimeReservedEnvName('ld_preload')).toBe(false);
    expect(isRuntimeReservedEnvName('NODE_OPTIONS_EXTRA')).toBe(false);
  });
});

describe('validateAgentEnvNotReserved (write path)', () => {
  it('returns one violation per reserved name, naming the name and never the value', () => {
    const violations = validateAgentEnvNotReserved({
      env: { KEEP: 'ok', NODE_OPTIONS: 'value-one', LD_PRELOAD: 'value-two' },
    });
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('agent.env.NODE_OPTIONS');
    expect(violations[1]).toContain('agent.env.LD_PRELOAD');
    expect(violations.join('\n')).not.toMatch(/value-one|value-two/);
  });

  it('is clean for an absent agent, an absent env and ordinary names', () => {
    expect(validateAgentEnvNotReserved(undefined)).toEqual([]);
    expect(validateAgentEnvNotReserved({})).toEqual([]);
    expect(validateAgentEnvNotReserved({ env: { LD_SDK_KEY: 'x', LOG_LEVEL: 'debug' } })).toEqual([]);
  });
});

describe('withoutReservedEnvNames (render path)', () => {
  it('leaves the reserved names out, reports each in map order, and keeps the rest', () => {
    const input = { A: '1', LD_AUDIT: 'x', B: '2', GLIBC_TUNABLES: 'y' };
    const { env, dropped } = withoutReservedEnvNames(input);
    expect(env).toEqual({ A: '1', B: '2' });
    expect(dropped).toEqual(['LD_AUDIT', 'GLIBC_TUNABLES']);
    expect(input).toEqual({ A: '1', LD_AUDIT: 'x', B: '2', GLIBC_TUNABLES: 'y' });
  });

  it('returns an empty map for an absent env', () => {
    expect(withoutReservedEnvNames(undefined)).toEqual({ env: {}, dropped: [] });
  });
});

describe('a stored guuey.json whose agent.env carries a reserved name', () => {
  it('still parses: the reservation is a write-path check, not a schema rule', () => {
    const parsed = GuueyJsonV1.safeParse({
      schema: '1',
      agent: { systemPrompt: 'x', env: { LD_PRELOAD: '/x.so', KEEP: '1' } },
    });
    expect(parsed.success).toBe(true);
  });
});

/**
 * The list is a hand-copy of the platform's own (a published package cannot
 * import the private source). Both sides are read off disk when present; on
 * the published mirror there is no backend/, and only the comparison is
 * skipped there.
 */
const PLATFORM_ENV_LIST = fileURLToPath(new URL('../../../../backend/libs/cli-wire/env.ts', import.meta.url));
describe.skipIf(!existsSync(PLATFORM_ENV_LIST))('RUNTIME_RESERVED_ENV_NAMES mirrors the platform list', () => {
  it('holds exactly the names of RUNTIME_RESERVED_ENV_KEYS, in the same order', () => {
    const src = readFileSync(PLATFORM_ENV_LIST, 'utf8');
    const block = /export const RUNTIME_RESERVED_ENV_KEYS = \[([\s\S]*?)\] as const;/.exec(src);
    expect(block).not.toBeNull();
    const names = [...(block?.[1] ?? '').matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual([...RUNTIME_RESERVED_ENV_NAMES]);
  });
});
