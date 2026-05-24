/**
 * Node-only filesystem helpers for `guuey.json`.
 *
 * This package (`@guuey/config`) is closed, private, and
 * Node-only — the loader ships on the single barrel, no browser-safe
 * subpath split is needed.
 *
 * Intended callers:
 *
 * - `guuey` CLI (closed hosted): `guuey deploy` reads `guuey.json` as
 *   input; `guuey pull` writes it back as output. Walks upward from
 *   `process.cwd()` to find the project-root file.
 * - Guuey hosted control-plane services that validate a submitted
 *   `guuey.json` blob server-side (hosted receive-side of deploy).
 *
 * The open `ggui` CLI must NOT import from this package. `guuey.json`
 * is Guuey platform config, not open protocol (see
 * `docs/plans/2026-04-17-ggui-oss-split.md` §8 correction 2026-04-18).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  GUUEY_JSON_FILENAME,
  GuueyJsonV1,
  parseGuueyJson,
} from './schema.js';

/** How many parent directories `findGuueyJson` will walk by default. */
export const DEFAULT_FIND_MAX_DEPTH = 8;

/**
 * Walk up from `startDir` (default: `process.cwd()`) looking for a
 * `guuey.json`. Returns the absolute path to the first match, or
 * `null` if no file is found within `maxDepth` levels.
 *
 * Stops when the filesystem root is reached, regardless of `maxDepth`.
 * Never throws — a missing file is a valid result ("not in a ggui
 * project"), not an error.
 */
export function findGuueyJson(
  startDir: string = process.cwd(),
  maxDepth: number = DEFAULT_FIND_MAX_DEPTH,
): string | null {
  let dir = resolve(startDir);
  for (let i = 0; i <= maxDepth; i++) {
    const candidate = join(dir, GUUEY_JSON_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Error thrown when a `guuey.json` fails to load — missing file,
 * malformed JSON, or schema validation failure. Wraps the underlying
 * cause (`SyntaxError` / `ZodError`) on `.cause` so callers can
 * inspect issue lists when they need to.
 */
export class GuueyJsonLoadError extends Error {
  readonly path: string;

  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GuueyJsonLoadError';
    this.path = path;
  }
}

/**
 * Read `guuey.json` at `path`, parse JSON, validate against the v1
 * schema. Returns the fully-defaulted document.
 *
 * Throws {@link GuueyJsonLoadError} if:
 *   - the file does not exist,
 *   - the file is not valid JSON,
 *   - the document fails schema validation (cause set to `ZodError`).
 */
export function loadGuueyJson(path: string): GuueyJsonV1 {
  if (!existsSync(path)) {
    throw new GuueyJsonLoadError(
      `guuey.json not found at ${path}`,
      path,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (cause) {
    throw new GuueyJsonLoadError(
      `Failed to read guuey.json at ${path}`,
      path,
      { cause },
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (cause) {
    throw new GuueyJsonLoadError(
      `guuey.json at ${path} is not valid JSON`,
      path,
      { cause },
    );
  }

  try {
    return parseGuueyJson(decoded);
  } catch (cause) {
    throw new GuueyJsonLoadError(
      `guuey.json at ${path} failed schema validation`,
      path,
      { cause },
    );
  }
}

/**
 * Result of {@link safeLoadGuueyJson} — mirrors the shape of
 * `z.safeParse` so consumers can branch without try/catch.
 */
export type SafeLoadResult =
  | { success: true; data: GuueyJsonV1 }
  | { success: false; error: GuueyJsonLoadError };

/**
 * Non-throwing variant of {@link loadGuueyJson}. Returns a
 * discriminated result. Use this in CLI surfaces that render issue
 * lists directly.
 */
export function safeLoadGuueyJson(path: string): SafeLoadResult {
  try {
    return { success: true, data: loadGuueyJson(path) };
  } catch (error) {
    if (error instanceof GuueyJsonLoadError) {
      return { success: false, error };
    }
    throw error;
  }
}

/**
 * Serialize and write a `guuey.json` document to `path`. The input
 * is re-validated against the v1 schema before writing so a caller
 * cannot accidentally persist a document that wouldn't round-trip
 * through {@link loadGuueyJson}.
 *
 * Output format: 2-space indent, trailing newline — matches the
 * scaffolder output and typical prettier defaults.
 */
export function saveGuueyJson(path: string, doc: GuueyJsonV1): void {
  const validated = parseGuueyJson(doc);
  writeFileSync(path, JSON.stringify(validated, null, 2) + '\n', 'utf-8');
}

// Re-export schema + types from the same subpath so Node callers
// can do `import { parseGuueyJson, loadGuueyJson } from
// '@guuey/config'` without two imports. Browser
// callers use the root barrel, which also exports the schema.
export {
  GUUEY_JSON_FILENAME,
  GuueyJsonV1,
  parseGuueyJson,
  safeParseGuueyJson,
} from './schema.js';
export type {
  GuueyJsonDeploy,
  GuueyJsonDeployment,
  GuueyJsonProject,
} from './schema.js';
