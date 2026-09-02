/**
 * guuey#648 — `FRAMEWORK_REGISTRY.platformPinnedVersion` is a CLAIM about
 * what the fat image ships. Nothing guarded the claim, so it drifted
 * (registry said 0.3.199 while the image shipped 0.3.247). This file is the
 * drift guard: each row's claim must equal the version actually pinned
 * where the pod's SDK comes from.
 *
 * ONE layer, by path (config is published npm — it cannot import the
 * manifest, so it READS it, the wire-mirror-guard pattern): every pinned
 * row == `@guuey/host`'s exact devDependency — what host builds and tests
 * against, present in the publish extract gate too. The platform side of
 * the chain (host-shared == registry == nocode-runtime image pin == host
 * devDep == facet peer range, plus every scaffold template range) is
 * `scripts/check-pin-coherence.mjs` (infra, guuey#653; CI Quality +
 * pre-push). One guard per fact: this file exists only for the place that
 * script cannot run — the published package's own gate.
 *
 * A caret/tilde on the manifest side is tolerated for the COMPARISON only
 * (the version it names must still match) — exact-pinning the manifests is
 * the pnpm-deploy law's business, not this guard's.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMEWORK_REGISTRY } from './registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const ossRoot = join(here, '..', '..', '..'); // oss/

const HOST_PKG = join(ossRoot, 'packages', 'host', 'package.json');

interface ManifestDeps {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * `@guuey/host` carries the SDKs as exact `devDependencies` (what it builds
 * and tests against — consumers bring their own via the peer ranges); the
 * platform manifests carry them as `dependencies` (what the pod installs).
 */
function pinnedIn(manifestPath: string, pkg: string, field: keyof ManifestDeps): string | undefined {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestDeps;
  const range = manifest[field]?.[pkg];
  return range === undefined ? undefined : range.replace(/^[\^~]/, '');
}

type FrameworkRow = (typeof FRAMEWORK_REGISTRY)[number];
/** A row that claims a platform pin — which implies a real sdkPackage to pin. */
type PinnedRow = FrameworkRow & { platformPinnedVersion: string; sdkPackage: string };

const rowsWithPins = FRAMEWORK_REGISTRY.filter(
  (row): row is PinnedRow => row.platformPinnedVersion !== null && row.sdkPackage !== null,
);

describe('FRAMEWORK_REGISTRY.platformPinnedVersion == the shipped pin (guuey#648 drift guard)', () => {
  it('every pinned row matches @guuey/host dependencies (always on)', () => {
    for (const row of rowsWithPins) {
      expect(pinnedIn(HOST_PKG, row.sdkPackage, 'devDependencies'), `${row.framework}: @guuey/host pins ${row.sdkPackage}`).toBe(
        row.platformPinnedVersion,
      );
    }
  });

});
