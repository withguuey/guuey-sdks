/**
 * Resolves an installed SDK package's own `package.json#version` at RUNTIME —
 * the real resolved version (never a hardcoded literal, and never the
 * `package.json` dependency RANGE, which may be a caret). Feeds the worker
 * hello handshake's `sdkVersion` field (§8 item B).
 *
 * Mirrors silverprotocol's `resolveSdkVersion`
 * (`sdks/typescript/packages/e2e/src/capture-cli.ts`): `require.resolve(pkg)`
 * finds the package's main entry — `require.resolve(`${pkg}/package.json`)`
 * (the naive approach) THROWS `ERR_PACKAGE_PATH_NOT_EXPORTED` for a package
 * whose `exports` map omits a `./package.json` subpath, which is the case for
 * BOTH `@anthropic-ai/claude-agent-sdk` and `@openai/agents` (verified
 * empirically in that playbook run) — so we walk up from the main entry's
 * directory instead, bounded to a few levels (real packages are 0-2 levels
 * deep), until we find the `package.json` whose own `name` matches.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Real packages are 0-2 levels deep from their resolved main entry. */
const MAX_WALK_UP_DEPTH = 5;

/** Reads the installed `pkgName` package's own `package.json#version`, or
 *  `null` when the package isn't installed / its version can't be resolved
 *  (never throws — a missing SDK is tolerated, not fatal). */
export function resolveSdkVersion(pkgName: string): string | null {
  try {
    const mainEntryPath = require.resolve(pkgName);
    let dir = dirname(mainEntryPath);
    for (let depth = 0; depth < MAX_WALK_UP_DEPTH; depth++) {
      const candidate = join(dir, "package.json");
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === pkgName) {
          return parsed.version ?? null;
        }
      } catch {
        // Not found at this level (or unparsable) — keep walking up.
      }
      const parent = dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}
