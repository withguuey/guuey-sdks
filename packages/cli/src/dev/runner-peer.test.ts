import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { RUNNER_PEER, addCommand, hostPackageDir, isInside, peerInstalledFrom, peerSpec, runnerPreflight } from './runner-peer';

/** A fake filesystem: the set of paths that exist. */
const fs = (paths: string[]) => {
  const set = new Set(paths);
  return (p: string): boolean => set.has(p);
};

const PROJECT = '/work/app';
const SDK = '@anthropic-ai/claude-agent-sdk';
const MANIFEST = { peerDependencies: { [SDK]: '^0.3.199', '@openai/agents': '>=0.12.0 <0.19' } };

// The three measured shapes (game-day local dev, 2026-11-06): the CLI in the project, from an npx cache, global.
const IN_PROJECT_HOST = `${PROJECT}/node_modules/@guuey/host`;
const NPX_HOST = '/home/u/.npm/_npx/abc/node_modules/@guuey/host';
const PNPM_HOST = `${PROJECT}/node_modules/.pnpm/@guuey+host@0.32.0/node_modules/@guuey/host`;

describe('runner preflight', () => {
  it('finds the host package dir from its entry', () => {
    expect(hostPackageDir(`${IN_PROJECT_HOST}/dist/index.js`, fs([`${IN_PROJECT_HOST}/package.json`]))).toBe(IN_PROJECT_HOST);
  });

  it('resolves the peer from the host dir and every ancestor, as Node does', () => {
    expect(peerInstalledFrom(IN_PROJECT_HOST, SDK, fs([`${PROJECT}/node_modules/${SDK}/package.json`]))).toBe(true);
    // pnpm links a peer next to the host inside .pnpm
    const pnpmPeer = `${PROJECT}/node_modules/.pnpm/@guuey+host@0.32.0/node_modules/${SDK}/package.json`;
    expect(peerInstalledFrom(PNPM_HOST, SDK, fs([pnpmPeer]))).toBe(true);
    expect(peerInstalledFrom(NPX_HOST, SDK, fs([`${PROJECT}/node_modules/${SDK}/package.json`]))).toBe(false);
  });

  it('passes when the runner is installed where the host resolves it', () => {
    const exists = fs([`${IN_PROJECT_HOST}/package.json`, `${PROJECT}/node_modules/${SDK}/package.json`]);
    expect(runnerPreflight({ framework: 'claude-agent-sdk', hostEntry: `${IN_PROJECT_HOST}/dist/index.js`, projectRoot: PROJECT, exists, readManifest: () => MANIFEST })).toBeNull();
  });

  it('a host inside the project: install the runner there, with the range the host manifest declares', () => {
    const exists = fs([`${IN_PROJECT_HOST}/package.json`, `${PROJECT}/package.json`]);
    const msg = runnerPreflight({ framework: 'claude-agent-sdk', hostEntry: `${IN_PROJECT_HOST}/dist/index.js`, projectRoot: PROJECT, exists, readManifest: () => MANIFEST });
    expect(msg).toBe(
      `guuey dev --serve runs a claude-agent-sdk agent with ${SDK}, and it is not installed in this project. Install it, then run this again:\n` +
        `  npm install "${SDK}@^0.3.199"`,
    );
  });

  it("uses the project's package manager by its lockfile", () => {
    expect(addCommand(PROJECT, fs([join(PROJECT, 'pnpm-lock.yaml')]))).toBe('pnpm add');
    expect(addCommand(PROJECT, fs([join(PROJECT, 'yarn.lock')]))).toBe('yarn add');
    expect(addCommand(PROJECT, fs([]))).toBe('npm install');
  });

  it('a host outside the project (npx cache, global): install the CLI and the runner into the project, then run its CLI', () => {
    const exists = fs([`${NPX_HOST}/package.json`, `${PROJECT}/node_modules/${SDK}/package.json`]);
    const msg = runnerPreflight({ framework: 'claude-agent-sdk', hostEntry: `${NPX_HOST}/dist/index.js`, projectRoot: PROJECT, exists, readManifest: () => MANIFEST });
    expect(msg).toBe(
      [
        `guuey dev --serve runs a claude-agent-sdk agent with ${SDK}, and it is not installed where this guuey CLI can load it. This CLI runs from outside the project (an npx cache or a global install),`,
        'so it cannot load a package installed in the project. Install the CLI and the runner into the project, and run it from there:',
        '  npm init -y',
        `  npm install @guuey/cli "${SDK}@^0.3.199"`,
        '  npx guuey dev --serve',
      ].join('\n'),
    );
  });

  it('skips npm init when the project already has a package.json', () => {
    const exists = fs([`${NPX_HOST}/package.json`, `${PROJECT}/package.json`]);
    const msg = runnerPreflight({ framework: 'openai-agents-sdk', hostEntry: `${NPX_HOST}/dist/index.js`, projectRoot: PROJECT, exists, readManifest: () => MANIFEST });
    expect(msg).not.toContain('npm init -y');
    expect(msg).toContain('  npm install @guuey/cli "@openai/agents@>=0.12.0 <0.19"');
  });

  it('names the bare peer when the manifest declares no range', () => {
    expect(peerSpec({}, SDK)).toBe(SDK);
  });

  it('isInside', () => {
    expect(isInside(PROJECT, IN_PROJECT_HOST)).toBe(true);
    expect(isInside(PROJECT, PROJECT)).toBe(true);
    expect(isInside(PROJECT, NPX_HOST)).toBe(false);
    expect(isInside(PROJECT, '/work/app-other/node_modules/@guuey/host')).toBe(false);
  });

  it('covers every framework guuey dev --serve runs', () => {
    expect(Object.keys(RUNNER_PEER).sort()).toEqual(['claude-agent-sdk', 'google-adk', 'openai-agents-sdk']);
  });
});
