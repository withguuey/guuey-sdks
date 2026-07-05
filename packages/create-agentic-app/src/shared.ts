/**
 * Small filesystem + naming helpers shared by `scaffold.ts` (whole-app
 * scaffold) and `scaffold-mcp.ts` (single hosted-MCP scaffold) — neither
 * is app- or mcp-specific, so they live here instead of being duplicated.
 */
import { promises as fs } from 'node:fs';

/** npm-safe name rule: lowercase-start, then letters/digits/dots/dashes/underscores. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Whether `name` matches the npm-safe {@link NAME_PATTERN} rule. */
export function isNpmSafeName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/** Throws a clear, rule-naming error unless `name` is npm-safe. */
export function assertNpmSafeName(name: string, label: string): void {
  if (!isNpmSafeName(name)) {
    throw new Error(
      `Invalid ${label} name "${name}": must be npm-safe (match ${NAME_PATTERN.toString()}).`
    );
  }
}

export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Create `targetDir` if absent. If it already exists and is non-empty,
 * throws unless `force` is set — the caller decides whether "existing but
 * empty" or "force" is acceptable.
 */
export async function ensureTargetDir(targetDir: string, force: boolean | undefined): Promise<void> {
  if (!(await pathExists(targetDir))) {
    await fs.mkdir(targetDir, { recursive: true });
    return;
  }
  const entries = await fs.readdir(targetDir);
  if (entries.length > 0 && !force) {
    throw new Error(
      `Target directory "${targetDir}" is not empty. Pass force: true (or --force) to scaffold into it anyway.`
    );
  }
}
