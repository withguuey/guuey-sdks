/**
 * Node-only filesystem helpers for `guuey.json`.
 *
 * Pure-parse helpers (`parseGuueyJson` / `safeParseGuueyJson`) live in
 * `./schema.ts` and are safe to import from non-Node contexts. This
 * module adds the file-resolution layer: reading `guuey.json` from disk,
 * inlining `agent.systemPrompt.file` references, and producing the
 * snapshot the deploy upload + pod boot both read.
 *
 * Intended callers:
 *
 * - `@guuey/cli` — `guuey deploy` reads + inlines + POSTs the snapshot.
 * - `@guuey/cli` — `guuey pull` writes back from a hosted record.
 * - Guuey control-plane services that re-validate a submitted snapshot
 *   server-side before persisting to `AgentDeployment`.
 * - `nocode-runtime` / `@guuey/host` — pod reads the snapshot back at boot
 *   (from the env-injected JSON, not directly from disk).
 *
 * The open `ggui` ecosystem must NOT import from this package — `guuey.json`
 * is Guuey platform config, not protocol shape.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
 * Never throws — a missing file is a valid result (not in a guuey project),
 * not an error.
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
 * Read + parse `guuey.json` from `path`. Throws if the file is missing,
 * unreadable, malformed JSON, or fails schema validation.
 *
 * Does NOT resolve `agent.systemPrompt.file` references. Use
 * {@link loadGuueyJson} for file resolution.
 */
export function readGuueyJsonFile(path: string): GuueyJsonV1 {
  if (!existsSync(path)) {
    throw new Error(`guuey.json not found at ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`guuey.json at ${path} is not valid JSON: ${msg}`);
  }
  return parseGuueyJson(json);
}

/**
 * Write a `guuey.json` to disk at `path` with stable 2-space indentation
 * and a trailing newline.
 *
 * Validates the document against {@link GuueyJsonV1} before writing — bad
 * data never lands on disk.
 */
export function writeGuueyJsonFile(path: string, doc: GuueyJsonV1): void {
  const validated = parseGuueyJson(doc);
  const serialized = JSON.stringify(validated, null, 2) + '\n';
  writeFileSync(path, serialized, 'utf-8');
}

/**
 * Result of resolving file-references inside a `guuey.json` document.
 *
 * `doc` is the original document (with `{ file: '...' }` references intact);
 * `resolvedSystemPrompt` is the inlined string the pod will use at boot.
 */
export interface ResolvedGuueyJson {
  /** The original parsed document. */
  doc: GuueyJsonV1;
  /**
   * The resolved system prompt — either the inline string from
   * `agent.systemPrompt`, or the file contents when it was a
   * `{ file: '...' }` reference, or `undefined` when no prompt was set
   * (caller falls back to `GUUEY_DEFAULT_SYSTEM_PROMPT`).
   */
  resolvedSystemPrompt: string | undefined;
  /** Absolute path the document was loaded from (for diagnostics). */
  sourcePath: string;
}

/**
 * Load + parse `guuey.json` from `path`, then resolve any
 * `agent.systemPrompt.file` reference into an inlined string.
 *
 * The resolved prompt is returned alongside the parsed document so callers
 * can choose how to use it. The deploy snapshot inlines it into a string
 * shape; the pod runtime reads the resolved prompt directly.
 *
 * Throws if the file is missing, unreadable, malformed, fails schema
 * validation, OR the systemPrompt.file path resolves to a missing or
 * unreadable file.
 */
export function loadGuueyJson(path: string): ResolvedGuueyJson {
  const doc = readGuueyJsonFile(path);
  const resolvedSystemPrompt = resolveSystemPrompt(doc, path);
  return { doc, resolvedSystemPrompt, sourcePath: path };
}

/**
 * Resolve `agent.systemPrompt` to a final string (or undefined).
 *
 * - Absent → undefined (caller applies platform default).
 * - Inline string → returned as-is.
 * - `{ file }` → resolved relative to `guueyJsonPath`'s directory, file read.
 *
 * File paths must be relative + must not escape the project root (no
 * `..` traversal). Absolute paths are rejected — keeps the snapshot
 * portable across deploy environments.
 */
function resolveSystemPrompt(
  doc: GuueyJsonV1,
  guueyJsonPath: string,
): string | undefined {
  const sp = doc.agent.systemPrompt;
  if (sp === undefined) return undefined;
  if (typeof sp === 'string') return sp;
  // sp = { file: '...' }
  if (isAbsolute(sp.file)) {
    throw new Error(
      `agent.systemPrompt.file must be a relative path (got absolute: ${sp.file})`,
    );
  }
  if (sp.file.split('/').includes('..')) {
    throw new Error(
      `agent.systemPrompt.file must not traverse parent directories (got: ${sp.file})`,
    );
  }
  const baseDir = dirname(guueyJsonPath);
  const resolved = resolve(baseDir, sp.file);
  if (!existsSync(resolved)) {
    throw new Error(
      `agent.systemPrompt.file references missing file: ${sp.file} (resolved to ${resolved})`,
    );
  }
  return readFileSync(resolved, 'utf-8');
}

/**
 * Build the snapshot the deploy upload + pod boot consume.
 *
 * Replaces `agent.systemPrompt = { file }` with `agent.systemPrompt = <inlined>`
 * so the snapshot is self-contained. Returns a deep-cloned document
 * (caller mutations don't leak back).
 */
export function buildDeploySnapshot(loaded: ResolvedGuueyJson): GuueyJsonV1 {
  const cloned: GuueyJsonV1 = JSON.parse(JSON.stringify(loaded.doc));
  if (loaded.resolvedSystemPrompt !== undefined) {
    cloned.agent.systemPrompt = loaded.resolvedSystemPrompt;
  }
  return cloned;
}
