/**
 * The "Next steps" a scaffold prints (guuey#1741). One printer for every
 * caller — `create-agentic-app` and `guuey create` — so the lines cannot drift
 * apart, and every command in them starts with the pnpm the scaffold itself
 * found (`ScaffoldResult.pnpm`): a user whose machine ran the install through
 * `npx --yes pnpm@<pinned>` is told to type exactly that, never a bare `pnpm`
 * that is not on their PATH. The templates' own command lines were filled with
 * the same words at scaffold time, so what the terminal says and what the app
 * says agree.
 */
import { pnpmRunner, SCAFFOLD_PNPM, type PnpmInvocation } from './pnpm.js';

/** What was scaffolded: a web-app template, the manage-only agent template, or an `--example` demo. */
export type NextStepsKind = 'app' | 'agent' | 'example';

export interface NextStepsInput {
  /** The scaffolded project's directory. */
  readonly projectDir: string;
  /** The scaffold's one probe of the pnpm ladder (`ScaffoldResult.pnpm`). */
  readonly pnpm: PnpmInvocation | null;
  /** Whether the scaffold ran the install; when it did not, installing is the first step. */
  readonly installed: boolean;
  readonly kind: NextStepsKind;
  /** How the user runs the guuey CLI in the project. Default `npx guuey`: the scaffold pins @guuey/cli. */
  readonly guuey?: string;
  /**
   * The scaffold is bound to an EXISTING app (`--app`). Its live definition is
   * not in the repo yet, and `apply` makes the live agent match the repo, so
   * the agent steps pull first: an apply before the pull would replace the
   * console-authored prompt and MCP servers with the template's.
   */
  readonly bound?: boolean;
}

/** The lines to print, `Next steps:` first. Each command line runs as printed, from the project directory. */
export function nextSteps(input: NextStepsInput): string[] {
  const run = pnpmRunner(input.pnpm);
  const guuey = input.guuey ?? 'npx guuey';
  const lines = ['Next steps:', `  cd ${input.projectDir}`];
  if (input.pnpm === null) {
    lines.push(`  # pnpm is not on your PATH and \`npx ${SCAFFOLD_PNPM}\` did not run: install pnpm first (https://pnpm.io/installation)`);
  }
  if (!input.installed) lines.push(`  ${run} install`);
  switch (input.kind) {
    case 'example':
      lines.push(`  ${run} bootstrap        # re-brand it as yours (also turns the demo chrome off)`);
      lines.push(`  ${run} dev`);
      break;
    case 'agent':
      lines.push(`  ${run} login          # once — opens the guuey console`);
      if (input.bound === true) {
        lines.push(`  ${run} pull           # first: bring the live agent (prompt, MCP servers, modes) into this repo`);
      }
      lines.push(`  ${run} apply          # push prompts/system.md and guuey.json to your live agent`);
      break;
    case 'app':
      lines.push(`  ${run} bootstrap        # brand, theme, copy — the web app is gated on this`);
      lines.push(`  ${run} dev`);
      lines.push(`  ${guuey} login && ${guuey} deploy`);
      lines.push(`  ${run} bootstrap -- --link   # bind the deployed app into the frontend`);
      break;
  }
  return lines;
}
