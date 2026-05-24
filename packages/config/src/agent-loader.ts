/**
 * Node-only filesystem helpers for `agent.json`.
 *
 * Pure-parse helpers (`parseAgentJson` / `safeParseAgentJson`) live in
 * `./agent.ts` and are safe to import from non-Node contexts. This
 * module adds the file-resolution layer: reading `agent.json` off
 * disk, inlining `systemPrompt.file` references, and producing the
 * snapshot the deploy upload + pod boot both read.
 *
 * Intended callers:
 *
 * - `guuey` CLI: `guuey deploy --config agent.json` reads the file,
 *   inlines the system prompt, and POSTs the resulting snapshot to
 *   the control plane as the no-tarball declarative deploy body.
 * - Guuey control-plane services that re-validate the submitted
 *   snapshot server-side before persisting to AgentDeployment.
 * - Stock nocode-runtime pod: reads the snapshot back at boot.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  AGENT_JSON_FILENAME,
  AgentJsonV1,
  parseAgentJson,
} from './agent.js';

/**
 * How many parent directories `findAgentJson` will walk by default.
 * Internal — the public-facing constant of the same name on
 * `./loader.ts` is the one re-exported on the package barrel; the
 * two values are kept in sync intentionally.
 */
const DEFAULT_FIND_MAX_DEPTH = 8;

/**
 * Walk up from `startDir` (default: `process.cwd()`) looking for an
 * `agent.json`. Returns the absolute path to the first match, or
 * `null` if no file is found within `maxDepth` levels.
 *
 * Stops at the filesystem root regardless of `maxDepth`. Never throws —
 * a missing file is a valid result ("this repo is code-mode only"),
 * not an error.
 */
export function findAgentJson(
  startDir: string = process.cwd(),
  maxDepth: number = DEFAULT_FIND_MAX_DEPTH,
): string | null {
  let dir = resolve(startDir);
  for (let i = 0; i <= maxDepth; i++) {
    const candidate = join(dir, AGENT_JSON_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Error thrown when an `agent.json` fails to load — missing file,
 * malformed JSON, schema validation failure, or an unresolvable
 * `systemPrompt.file` reference. Wraps the underlying cause
 * (`SyntaxError` / `ZodError` / filesystem error) on `.cause`.
 */
export class AgentJsonLoadError extends Error {
  readonly path: string;

  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentJsonLoadError';
    this.path = path;
  }
}

/**
 * The inlined, ready-to-snapshot form of `agent.json`. Identical
 * shape to {@link AgentJsonV1} EXCEPT `systemPrompt` is always
 * `string | undefined` — file references are resolved and inlined
 * during load. The pod runtime never reads the filesystem; it sees
 * only this resolved shape.
 *
 * `undefined` system prompt means "fall through to the platform
 * default" (see `GUUEY_DEFAULT_SYSTEM_PROMPT` in `./system-prompt`).
 */
export type ResolvedAgentJson = Omit<AgentJsonV1, 'systemPrompt'> & {
  systemPrompt?: string;
};

/**
 * Read `agent.json` at `path`, parse JSON, validate against v1, and
 * inline any `systemPrompt.file` reference (resolved relative to the
 * `agent.json` directory). Returns the fully-resolved snapshot.
 *
 * Throws {@link AgentJsonLoadError} if:
 *   - the file does not exist,
 *   - the file is not valid JSON,
 *   - the document fails schema validation (cause = `ZodError`),
 *   - `systemPrompt.file` points outside the project directory or
 *     does not exist on disk.
 */
export function loadAgentJson(path: string): ResolvedAgentJson {
  if (!existsSync(path)) {
    throw new AgentJsonLoadError(`agent.json not found at ${path}`, path);
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (cause) {
    throw new AgentJsonLoadError(
      `Failed to read agent.json at ${path}`,
      path,
      { cause },
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (cause) {
    throw new AgentJsonLoadError(
      `agent.json at ${path} is not valid JSON`,
      path,
      { cause },
    );
  }

  let parsed: AgentJsonV1;
  try {
    parsed = parseAgentJson(decoded);
  } catch (cause) {
    throw new AgentJsonLoadError(
      `agent.json at ${path} failed schema validation`,
      path,
      { cause },
    );
  }

  const baseDir = dirname(path);
  const resolvedPrompt = resolveSystemPrompt(parsed, baseDir, path);

  const out: ResolvedAgentJson = { ...parsed, systemPrompt: resolvedPrompt };
  if (resolvedPrompt === undefined) {
    delete out.systemPrompt;
  }
  return out;
}

/**
 * Non-throwing variant of {@link loadAgentJson}. Returns a
 * discriminated result mirroring `z.safeParse` for ergonomics in CLI
 * surfaces that render the error inline.
 */
export type SafeLoadAgentResult =
  | { success: true; data: ResolvedAgentJson }
  | { success: false; error: AgentJsonLoadError };

export function safeLoadAgentJson(path: string): SafeLoadAgentResult {
  try {
    return { success: true, data: loadAgentJson(path) };
  } catch (error) {
    if (error instanceof AgentJsonLoadError) {
      return { success: false, error };
    }
    throw error;
  }
}

/**
 * Resolve the `systemPrompt` field on a parsed `agent.json`. Returns
 * `undefined` when the field is absent (caller falls through to the
 * platform default). Inlines `{ file }` references relative to
 * `baseDir`; rejects absolute paths and parent-directory escapes so
 * the snapshot can't pull arbitrary host files into the deploy.
 */
function resolveSystemPrompt(
  doc: AgentJsonV1,
  baseDir: string,
  agentJsonPath: string,
): string | undefined {
  const sp = doc.systemPrompt;
  if (sp === undefined) return undefined;
  if (typeof sp === 'string') return sp;

  const relPath = sp.file;
  if (isAbsolute(relPath)) {
    throw new AgentJsonLoadError(
      `systemPrompt.file "${relPath}" must be a relative path, not absolute`,
      agentJsonPath,
    );
  }
  const resolved = resolve(baseDir, relPath);
  const baseResolved = resolve(baseDir);
  if (!resolved.startsWith(baseResolved + '/') && resolved !== baseResolved) {
    throw new AgentJsonLoadError(
      `systemPrompt.file "${relPath}" resolves outside the project directory`,
      agentJsonPath,
    );
  }
  if (!existsSync(resolved)) {
    throw new AgentJsonLoadError(
      `systemPrompt.file "${relPath}" does not exist (looked at ${resolved})`,
      agentJsonPath,
    );
  }
  try {
    return readFileSync(resolved, 'utf-8').trim();
  } catch (cause) {
    throw new AgentJsonLoadError(
      `Failed to read systemPrompt.file "${relPath}"`,
      agentJsonPath,
      { cause },
    );
  }
}

// Re-export pure schema + types from the same subpath so Node callers
// can do one import.
export {
  AGENT_JSON_FILENAME,
  AgentJsonV1,
  parseAgentJson,
  safeParseAgentJson,
  DEFAULT_AGENT_MCP_SERVERS,
} from './agent.js';
export type {
  AgentJsonMcpServer,
  AgentJsonRuntime,
  AgentJsonSystemPrompt,
  AgentJsonToolGates,
} from './agent.js';
