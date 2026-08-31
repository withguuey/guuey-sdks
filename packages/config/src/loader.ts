/**
 * Node-only filesystem helpers for `guuey.json`.
 *
 * Pure-parse helpers (`parseGuueyJson` / `safeParseGuueyJson`) live in
 * `./schema.ts` and are safe to import from non-Node contexts. This
 * module adds the file-resolution layer: reading `guuey.json` from disk,
 * inlining `agent.systemPrompt.file` AND every
 * `agent.modes[*].{systemPrompt,systemPromptAppend}.file` reference
 * (guuey#545 — a file-shaped mode prompt used to ride into the snapshot
 * unresolved), and producing the snapshot the deploy upload + pod boot
 * both read.
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
  assertSupportedGuueyJsonSchema,
  parseGuueyJson,
} from './schema.js';
import { isThemeFileRef } from './app.js';
import { AppThemeV1, type GuueyAppTheme } from './theme.js';

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
 * unreadable, malformed JSON, declares a `schema` version this package
 * cannot honor (`GuueyJsonSchemaError` — `SCHEMA_TOO_NEW` / `SCHEMA_UNSUPPORTED`,
 * see `assertSupportedGuueyJsonSchema`), or fails schema validation.
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
  // Version gate BEFORE the shape parse: a too-new document must say
  // "upgrade", not `at "schema": expected "1"` (guuey#248 b2).
  assertSupportedGuueyJsonSchema(json);
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
  /**
   * The resolved app theme — the inline document from `app.theme`, or the
   * file's parsed content when it was a `{ file: '...' }` reference
   * (guuey#400), or `undefined` when no theme was set.
   */
  resolvedTheme: GuueyAppTheme | undefined;
  /**
   * Resolved per-mode prompts (guuey#545): for every `agent.modes[key]`
   * whose `systemPrompt` / `systemPromptAppend` is present, the FINAL
   * string — the inline value as-is, or the file contents when it was a
   * `{ file: '...' }` reference. Before this, a file-shaped mode prompt
   * rode into the snapshot unresolved and reached the pod (which has no
   * repo filesystem) — a silently broken deploy. `undefined` when the
   * document declares no modes.
   */
  resolvedModePrompts:
    | Record<string, { systemPrompt?: string; systemPromptAppend?: string }>
    | undefined;
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
 * validation, OR the systemPrompt.file / app.theme.file path resolves to
 * a missing or unreadable file.
 */
export function loadGuueyJson(path: string): ResolvedGuueyJson {
  const doc = readGuueyJsonFile(path);
  const resolvedSystemPrompt = resolveSystemPrompt(doc, path);
  const resolvedTheme = resolveAppTheme(doc, path);
  const resolvedModePrompts = resolveModePrompts(doc, path);
  return {
    doc,
    resolvedSystemPrompt,
    resolvedTheme,
    resolvedModePrompts,
    sourcePath: path,
  };
}

/**
 * Shared relative-file guard + read for prompt `{ file }` references
 * (guuey#545 extraction — the base prompt, and now every mode prompt,
 * enforce the identical rules): the path must be relative, must not
 * traverse parent directories, and must exist. `label` names the field
 * in every error so the failure reads like the document, not the loader.
 */
function readPromptFileRef(
  label: string,
  file: string,
  guueyJsonPath: string,
): string {
  if (isAbsolute(file)) {
    throw new Error(`${label} must be a relative path (got absolute: ${file})`);
  }
  if (file.split('/').includes('..')) {
    throw new Error(
      `${label} must not traverse parent directories (got: ${file})`,
    );
  }
  const resolved = resolve(dirname(guueyJsonPath), file);
  if (!existsSync(resolved)) {
    throw new Error(
      `${label} references missing file: ${file} (resolved to ${resolved})`,
    );
  }
  return readFileSync(resolved, 'utf-8');
}

/**
 * Resolve every mode's `systemPrompt` / `systemPromptAppend` to final
 * strings (guuey#545). Inline strings pass through; `{ file }` references
 * resolve under {@link readPromptFileRef}'s guards — the SAME contract as
 * the base prompt, which the ModeSchema doc always promised. Absent
 * modes → undefined.
 */
function resolveModePrompts(
  doc: GuueyJsonV1,
  guueyJsonPath: string,
): ResolvedGuueyJson['resolvedModePrompts'] {
  const modes = doc.agent.modes;
  if (modes === undefined) return undefined;
  const out: Record<
    string,
    { systemPrompt?: string; systemPromptAppend?: string }
  > = {};
  for (const [key, mode] of Object.entries(modes)) {
    const entry: { systemPrompt?: string; systemPromptAppend?: string } = {};
    if (mode.systemPrompt !== undefined) {
      entry.systemPrompt =
        typeof mode.systemPrompt === 'string'
          ? mode.systemPrompt
          : readPromptFileRef(
              `agent.modes.${key}.systemPrompt.file`,
              mode.systemPrompt.file,
              guueyJsonPath,
            );
    }
    if (mode.systemPromptAppend !== undefined) {
      entry.systemPromptAppend =
        typeof mode.systemPromptAppend === 'string'
          ? mode.systemPromptAppend
          : readPromptFileRef(
              `agent.modes.${key}.systemPromptAppend.file`,
              mode.systemPromptAppend.file,
              guueyJsonPath,
            );
    }
    out[key] = entry;
  }
  return out;
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
  // sp = { file: '...' } — shared guard+read (guuey#545 extraction).
  return readPromptFileRef('agent.systemPrompt.file', sp.file, guueyJsonPath);
}

/**
 * Resolve `app.theme` to the inline document (or undefined).
 *
 * - Absent → undefined.
 * - Inline document → returned as-is.
 * - `{ file }` → resolved relative to `guueyJsonPath`'s directory, file
 *   read + parsed against the STRICT {@link AppThemeV1} shape (guuey#400).
 *   Shape only — colour VALUES stay with the server's one grammar
 *   (`validateChatTheme`), so plan/apply surfaces its exact message.
 *
 * File paths must be relative + must not escape the project root (no
 * `..` traversal). Absolute paths are rejected — keeps the snapshot
 * portable across deploy environments.
 */
function resolveAppTheme(
  doc: GuueyJsonV1,
  guueyJsonPath: string,
): GuueyAppTheme | undefined {
  const theme = doc.app?.theme;
  if (theme === undefined) return undefined;
  if (!isThemeFileRef(theme)) return theme;
  // theme = { file: '...' }
  if (isAbsolute(theme.file)) {
    throw new Error(
      `app.theme.file must be a relative path (got absolute: ${theme.file})`,
    );
  }
  if (theme.file.split('/').includes('..')) {
    throw new Error(
      `app.theme.file must not traverse parent directories (got: ${theme.file})`,
    );
  }
  const baseDir = dirname(guueyJsonPath);
  const resolved = resolve(baseDir, theme.file);
  if (!existsSync(resolved)) {
    throw new Error(
      `app.theme.file references missing file: ${theme.file} (resolved to ${resolved})`,
    );
  }
  const raw = readFileSync(resolved, 'utf-8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`app.theme.file ${theme.file} is not valid JSON: ${msg}`);
  }
  const parsed = AppThemeV1.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') || '(root)';
    throw new Error(
      `app.theme.file ${theme.file} failed theme validation at "${path}": ${first?.message ?? 'unknown error'}`,
    );
  }
  return parsed.data;
}

/**
 * Build the snapshot the deploy upload + pod boot consume.
 *
 * Replaces `agent.systemPrompt = { file }` with `agent.systemPrompt = <inlined>`
 * and `app.theme = { file }` with the file's parsed document so the
 * snapshot is self-contained. Returns a deep-cloned document
 * (caller mutations don't leak back).
 */
export function buildDeploySnapshot(loaded: ResolvedGuueyJson): GuueyJsonV1 {
  const cloned: GuueyJsonV1 = JSON.parse(JSON.stringify(loaded.doc));
  if (loaded.resolvedSystemPrompt !== undefined) {
    cloned.agent.systemPrompt = loaded.resolvedSystemPrompt;
  }
  // guuey#545 — mode prompts inline the same way the base prompt does:
  // a `{ file }` reference must never ride into the snapshot (the pod
  // has no repo filesystem; an unresolved object was a silently broken
  // deploy). Only prompt fields are touched — tools/audience and every
  // unexposed mode key survive verbatim.
  if (loaded.resolvedModePrompts !== undefined && cloned.agent.modes !== undefined) {
    for (const [key, resolved] of Object.entries(loaded.resolvedModePrompts)) {
      const mode = cloned.agent.modes[key];
      if (mode === undefined) continue;
      if (resolved.systemPrompt !== undefined) {
        mode.systemPrompt = resolved.systemPrompt;
      }
      if (resolved.systemPromptAppend !== undefined) {
        mode.systemPromptAppend = resolved.systemPromptAppend;
      }
    }
  }
  const theme = cloned.app?.theme;
  if (
    cloned.app !== undefined &&
    theme !== undefined &&
    isThemeFileRef(theme) &&
    loaded.resolvedTheme !== undefined
  ) {
    const themeClone: GuueyAppTheme = JSON.parse(JSON.stringify(loaded.resolvedTheme));
    cloned.app.theme = themeClone;
  }
  return cloned;
}
