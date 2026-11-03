/**
 * On Windows `pnpm` and `npx` are `.cmd` shims, which a shell-less spawn never
 * finds and Node refuses to run without a shell (CVE-2024-27980). The probe and
 * the install must go through cmd.exe there, as one command line, or every
 * Windows machine reads as having no pnpm.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const spawnCalls = vi.hoisted(() => [] as Array<{ file: string; args: readonly string[]; shell: unknown }>);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn((file: string, args: readonly string[], opts: { shell?: unknown }) => {
      spawnCalls.push({ file, args, shell: opts.shell });
      return { status: 0 };
    }),
  };
});

const { pnpmSpawn, pnpmInvocation, SCAFFOLD_PNPM } = await import('./pnpm.js');

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

afterEach(() => {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  spawnCalls.length = 0;
});

describe('pnpmSpawn', () => {
  it('★ win32: one command line through the shell, no separate arguments', () => {
    expect(pnpmSpawn('npx', ['--yes', SCAFFOLD_PNPM, 'install'], 'win32')).toEqual({
      file: `npx --yes ${SCAFFOLD_PNPM} install`,
      args: [],
      shell: true,
    });
  });

  it.each(['darwin', 'linux'] as const)('%s: the file and its arguments, no shell', (platform) => {
    expect(pnpmSpawn('pnpm', ['install'], platform)).toEqual({ file: 'pnpm', args: ['install'], shell: false });
  });
});

describe('pnpmInvocation probe', () => {
  it('★ on win32 the pnpm probe runs through the shell, so pnpm.cmd is found', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(pnpmInvocation()).toEqual({ file: 'pnpm', prefix: [] });
    expect(spawnCalls).toEqual([{ file: 'pnpm --version', args: [], shell: true }]);
  });

  it('elsewhere the probe spawns pnpm directly, as before', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(pnpmInvocation()).toEqual({ file: 'pnpm', prefix: [] });
    expect(spawnCalls).toEqual([{ file: 'pnpm', args: ['--version'], shell: false }]);
  });
});
