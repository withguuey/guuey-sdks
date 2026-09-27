import { PNPM_PLACEHOLDER } from './pnpm.js';

/**
 * Rewrites template placeholder tokens in a file's text content.
 *
 * Templates are authored against the fixed project name
 * `agentic-app-template` and scope `@agentic-app-template`. Rewriting the
 * scoped form first (`@agentic-app-template/` → `@<scope>/`) matters:
 * doing it in the other order would let the bare-name replacement eat the
 * `agentic-app-template` inside `@agentic-app-template/...` first, leaving
 * a dangling `@<scope-that-is-actually-the-name>` fragment.
 */
export function renameContent(content: string, name: string, scope: string): string {
  return content
    .replaceAll('@agentic-app-template/', `@${scope}/`)
    .replaceAll('agentic-app-template', name);
}

/**
 * Fills the pnpm command token in a file's text content with `runner`, the
 * words this machine runs pnpm with (`pnpm`, or `npx --yes pnpm@<pinned>`;
 * see `pnpmRunner`). Text content only: no file or directory name carries it.
 */
export function fillPnpmRunner(content: string, runner: string): string {
  return content.replaceAll(PNPM_PLACEHOLDER, runner);
}

/**
 * Heuristic text/binary sniff: a NUL byte anywhere in the first 8KB means
 * "treat as binary, copy verbatim, don't attempt token rewriting."
 */
export function isProbablyText(buf: Buffer): boolean {
  const window = buf.subarray(0, 8192);
  return !window.includes(0);
}
