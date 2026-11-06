/**
 * The CLI's runner preflight names each framework's runtime package the way
 * `@guuey/host` declares it: the key in host's manifest `peerDependencies`
 * (the range the install line reads at run time) and the `peer` of host's
 * runner registry (`src/index.ts` `RUNNERS`, the package its runner imports).
 * Both files sit inside this repo's oss/ tree, so the cell runs on the public
 * mirror too.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUNNER_PEER } from './runner-peer';

const HOST = fileURLToPath(new URL('../../../host/', import.meta.url));
const manifest = JSON.parse(readFileSync(`${HOST}package.json`, 'utf8')) as {
  name: string;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};
const registry = readFileSync(`${HOST}src/index.ts`, 'utf8');

describe('runner peers match @guuey/host', () => {
  it('reads the host package', () => {
    expect(manifest.name).toBe('@guuey/host');
  });

  it.each(Object.entries(RUNNER_PEER))('%s: %s is an optional peer of @guuey/host', (_framework, peer) => {
    expect(manifest.peerDependencies[peer]).toEqual(expect.any(String));
    expect(manifest.peerDependenciesMeta[peer]?.optional).toBe(true);
  });

  it.each(Object.entries(RUNNER_PEER))("%s: host's runner registry imports %s", (framework, peer) => {
    const entry = new RegExp(`"${framework}":\\s*\\{[^}]*\\bpeer:\\s*"([^"]+)"`).exec(registry);
    expect(entry?.[1]).toBe(peer);
  });
});
