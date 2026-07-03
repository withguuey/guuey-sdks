/**
 * guuey create -- Scaffold a new guuey agent project.
 *
 * Alias onto @guuey/create-agentic-app's scaffold() function.
 * Requires --framework or --agent flag (no interactive prompting here).
 * Authentication not required for scaffolding.
 */
import * as out from '../output.js';
import { scaffold, type Framework, type ScaffoldOptions } from '@guuey/create-agentic-app';

const FRAMEWORKS: Framework[] = ['claude-agent-sdk', 'openai-agents-sdk'];

function isFramework(value: string): value is Framework {
  return (FRAMEWORKS as string[]).includes(value);
}

/** Derive an npm-safe default project name from the target path's basename. */
function deriveName(target: string): string {
  const base = target.split(/[\\/]/).filter(Boolean).pop() ?? target;
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '');
  return slug || 'agentic-app';
}

/**
 * Convert CLI positional target + flags to ScaffoldOptions.
 *
 * @throws {Error} if framework is invalid or missing, or if target is missing
 */
export function buildScaffoldOptions(
  target: string | undefined,
  flags?: Record<string, string | true>,
): ScaffoldOptions {
  if (!target) {
    throw new Error('A target directory is required.');
  }

  const frameworkFlag = flags?.framework ?? flags?.agent;
  const frameworkInput = typeof frameworkFlag === 'string' ? frameworkFlag : undefined;

  if (!frameworkInput || !isFramework(frameworkInput)) {
    throw new Error(
      `Missing or unknown framework "${frameworkInput ?? '(not provided)'}". ` +
      `Available frameworks: ${FRAMEWORKS.join(', ')}.`,
    );
  }

  const name = typeof flags?.name === 'string' ? flags.name : deriveName(target);
  const scope = typeof flags?.scope === 'string' ? flags.scope : undefined;
  const install = flags?.install === true;

  return {
    targetDir: target,
    name,
    framework: frameworkInput,
    scope,
    install,
    git: flags?.['no-git'] !== true,
    force: flags?.force === true,
  };
}

export async function create(
  target?: string,
  flags?: Record<string, string | true>,
): Promise<void> {
  try {
    const opts = buildScaffoldOptions(target, flags);
    const { projectDir } = await scaffold(opts);

    console.log(`\nScaffolded "${opts.name}" in ${projectDir}\n`);
    console.log('Next steps:');
    console.log(`  cd ${projectDir}`);
    if (!opts.install) console.log('  pnpm install');
    console.log('  pnpm dev');
    console.log('  guuey login && guuey deploy');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    out.error(message);
    process.exit(1);
  }
}
