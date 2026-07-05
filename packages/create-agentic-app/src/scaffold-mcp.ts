import { promises as fs } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renameContent, isProbablyText } from './rename.js';
import { assertNpmSafeName, ensureTargetDir, pathExists } from './shared.js';

export interface ScaffoldMcpOptions {
  /** Absolute or cwd-relative path to create the MCP package in. */
  targetDir: string;
  /** npm-safe MCP name (also the default scope in standalone mode). */
  name: string;
  /**
   * Package scope for the emitted `@<scope>/<name>-mcp` name. Project-mode
   * callers (`guuey mcp new` inside a scaffolded app) pass the surrounding
   * project's own scope — its root `package.json` name, since a scaffolded
   * app's own `scope` defaults to its (unscoped) project name (see
   * `scaffold()`'s `scope ?? name`). Standalone-mode callers default this
   * to `name`.
   */
  scope?: string;
  /** Root directory holding `mcp-base/`. Default: `dist/templates`. */
  templatesDir?: string;
}

export interface ScaffoldMcpResult {
  mcpDir: string;
}

const here = dirname(fileURLToPath(import.meta.url));
/** Package root: this module lives at `<packageRoot>/dist/*.js` once built. */
const packageRoot = join(here, '..');
const defaultTemplatesDir = join(packageRoot, 'dist', 'templates');

/**
 * Resolve both `mcp-base` template tokens in one pass:
 *
 * 1. `NAME_PLACEHOLDER` (left unresolved by `build-templates.mjs#emitMcpBase`
 *    on purpose — see that script's doc comment) becomes the requested MCP
 *    `name`, e.g. `NAME_PLACEHOLDER-mcp` -> `billing-mcp`.
 * 2. The standard `agentic-app-template` / `@agentic-app-template`
 *    project/scope tokens (the same ones `scaffold()`'s `renameContent`
 *    resolves for a whole app) become `scope`. mcp-base's only BARE
 *    occurrence of the token is a doc comment naming the *parent* project
 *    ("the copy-me starter MCP server for @agentic-app-template"), not the
 *    MCP itself — unlike the whole-app scaffold, there is no second
 *    "project name" in play here, so both the scoped (`@agentic-app-template/`)
 *    and bare (`agentic-app-template`) forms resolve to the same `scope`
 *    value.
 */
function renameMcpTokens(content: string, name: string, scope: string): string {
  return renameContent(content.replaceAll('NAME_PLACEHOLDER', name), scope, scope);
}

async function copyMcpTree(src: string, dest: string, name: string, scope: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const destName = renameMcpTokens(entry.name, name, scope);
    const srcPath = join(src, entry.name);
    const destPath = join(dest, destName);
    if (entry.isDirectory()) {
      await copyMcpTree(srcPath, destPath, name, scope);
    } else {
      const buf = await fs.readFile(srcPath);
      if (isProbablyText(buf)) {
        await fs.writeFile(destPath, renameMcpTokens(buf.toString('utf8'), name, scope), 'utf8');
      } else {
        await fs.writeFile(destPath, buf);
      }
    }
  }
}

/**
 * Scaffold a single hosted-MCP package from the shared `mcp-base` template
 * (`templates-src/mcp-base/`, emitted verbatim with `NAME_PLACEHOLDER`
 * unresolved to `dist/templates/mcp-base/` by `build-templates.mjs`; see
 * the mcp-lifecycle design spec §5).
 *
 * The sole consumer today is `guuey mcp new` (`@guuey/cli`):
 * - **Project mode** — `targetDir: <project>/mcps/<name>`, `scope`: the
 *   surrounding project's own scope.
 * - **Standalone mode** — `targetDir: ./<name>`, `scope` left `undefined`
 *   (defaults to `name`).
 *
 * Refuses (via {@link ensureTargetDir}) a non-empty `targetDir` — callers
 * that want a stricter "refuse ANY existing directory" rule (project mode's
 * "refuse if `mcps/<name>` exists") check `existsSync(targetDir)` themselves
 * before calling this.
 */
export async function scaffoldMcp(opts: ScaffoldMcpOptions): Promise<ScaffoldMcpResult> {
  assertNpmSafeName(opts.name, 'MCP');

  const scope = opts.scope ?? opts.name;
  const templatesDir = opts.templatesDir ?? defaultTemplatesDir;
  const templateDir = join(templatesDir, 'mcp-base');
  if (!(await pathExists(templateDir))) {
    throw new Error(`No mcp-base template found at ${templateDir}.`);
  }

  const mcpDir = resolve(opts.targetDir);
  await ensureTargetDir(mcpDir, undefined);

  await copyMcpTree(templateDir, mcpDir, opts.name, scope);

  return { mcpDir };
}
