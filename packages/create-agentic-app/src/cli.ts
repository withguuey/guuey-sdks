#!/usr/bin/env node
/**
 * create-agentic-app CLI -- scaffolds a new guuey agentic-app project.
 *
 * @example
 * ```bash
 * npx @guuey/create-agentic-app my-app --framework claude-agent-sdk
 * ```
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { scaffold, scaffoldExample, type Framework, type Template } from './index.js';

const FRAMEWORKS: Framework[] = ['claude-agent-sdk', 'openai-agents-sdk', 'google-adk'];
const TEMPLATES: Template[] = ['base', 'agentic-app'];

function isFramework(value: string): value is Framework {
  return (FRAMEWORKS as string[]).includes(value);
}

function isTemplate(value: string): value is Template {
  return (TEMPLATES as string[]).includes(value);
}

/**
 * Parse CLI arguments into positional args and named flags.
 *
 * Modeled on `oss/packages/cli/src/cli.ts`'s `parseArgs`: a flag (`--foo`)
 * consumes the following token as its value unless that token is itself a
 * flag, in which case the flag is boolean `true`.
 */
function parseArgs(argv: string[]): {
  positional: string[];
  flags: Record<string, string | true>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function printHelp(): void {
  console.log(`create-agentic-app -- scaffold a guuey agentic app

Usage: create-agentic-app [target] [options]

Arguments:
  target               Directory to create the project in (prompted if omitted)

Options:
  --name <name>         Project name (default: derived from target)
  --scope <scope>       npm scope for @<scope>/* packages (default: name)
  --template <t>        App template: ${TEMPLATES.join(' | ')} (default: base)
                        base = landing + login + home + chat;
                        agentic-app = base + split-sidebar product shell with
                        a fullscreen agent canvas and "talk on mobile" QR
  --framework <f>       Framework: ${FRAMEWORKS.join(' | ')}
  --agent <f>           Alias for --framework
  --example <vertical>  Extract a demo app from github.com/withguuey/demos
                        instead of a blank template (mutually exclusive with
                        --template/--framework; re-brand via pnpm bootstrap)
  --install             Run "pnpm install" after scaffolding
  --no-git              Skip "git init" + initial commit
  --force               Scaffold into a non-empty target directory
  --list-agents         List available frameworks and exit
  --help                Show this help

Examples:
  create-agentic-app my-app --framework claude-agent-sdk
  create-agentic-app my-app --agent openai-agents-sdk --install
`);
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
 * Interactive prompt — but a headless run (CI, a coding agent, a piped
 * stdin) must FAIL LOUDLY instead of hanging on a prompt nobody will
 * answer. `missingFlagHint` names the flag to pass instead.
 */
async function promptFor(question: string, missingFlagHint: string): Promise<string> {
  if (stdin.isTTY !== true) {
    console.error(`Non-interactive run: pass ${missingFlagHint} explicitly.`);
    process.exit(1);
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    return;
  }

  if (flags['list-agents']) {
    console.log(FRAMEWORKS.join('\n'));
    return;
  }

  let target = positional[0];
  if (!target) {
    target = await promptFor('Project directory: ', 'the target directory as the first argument');
  }
  if (!target) {
    console.error('A target directory is required.');
    process.exit(1);
    return;
  }

  // `--example <vertical>`: pull an already-branded demo app out of the
  // public withguuey/demos monorepo. Mutually exclusive with the template
  // axis — an example IS a pre-templated app with its framework baked in.
  if (flags.example !== undefined) {
    if (flags.template !== undefined || flags.framework !== undefined || flags.agent !== undefined) {
      console.error('--example is mutually exclusive with --template/--framework (an example is already a complete app).');
      process.exit(1);
      return;
    }
    if (typeof flags.example !== 'string') {
      console.error('--example needs a value, e.g. --example trimly');
      process.exit(1);
      return;
    }
    const { projectDir } = await scaffoldExample({
      targetDir: target,
      example: flags.example,
      install: flags.install === true,
      git: flags['no-git'] !== true,
      force: flags.force === true,
    });
    console.log(`\nExtracted the "${flags.example}" example into ${projectDir}\n`);
    console.log('Next steps:');
    console.log(`  cd ${projectDir}`);
    if (flags.install !== true) console.log('  pnpm install');
    console.log('  pnpm bootstrap        # re-brand it as yours (also turns the demo chrome off)');
    console.log('  pnpm dev');
    return;
  }

  const templateFlag = flags.template;
  const templateInput = typeof templateFlag === 'string' ? templateFlag : 'base';
  if (!isTemplate(templateInput)) {
    console.error(`Unknown template "${templateInput}". Available: ${TEMPLATES.join(', ')}`);
    process.exit(1);
    return;
  }
  const template = templateInput;

  const frameworkFlag = flags.framework ?? flags.agent;
  let frameworkInput = typeof frameworkFlag === 'string' ? frameworkFlag : undefined;
  if (!frameworkInput) {
    frameworkInput = await promptFor(`Framework (${FRAMEWORKS.join(' | ')}): `, '--framework <f>');
  }
  if (!isFramework(frameworkInput)) {
    console.error(`Unknown framework "${frameworkInput}". Available: ${FRAMEWORKS.join(', ')}`);
    process.exit(1);
    return;
  }
  const framework = frameworkInput;

  const name = typeof flags.name === 'string' ? flags.name : deriveName(target);
  const scope = typeof flags.scope === 'string' ? flags.scope : undefined;
  const install = flags.install === true;

  const { projectDir } = await scaffold({
    targetDir: target,
    name,
    framework,
    template,
    scope,
    install,
    git: flags['no-git'] !== true,
    force: flags.force === true,
  });

  console.log(`\nScaffolded "${name}" in ${projectDir}\n`);
  console.log('Next steps:');
  console.log(`  cd ${projectDir}`);
  if (!install) console.log('  pnpm install');
  console.log('  pnpm bootstrap        # brand, theme, copy — the web app is gated on this');
  console.log('  pnpm dev');
  // npx-form (guuey#451): the scaffold pins @guuey/cli, so the in-dir
  // resolution is version-matched and needs no global install — the bare
  // form broke the founder's first-agent walk at exactly this moment.
  console.log('  npx guuey login && npx guuey deploy');
  console.log('  pnpm bootstrap -- --link   # bind the deployed app into the frontend');
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    console.error(`✗ ${err.message}`);
  } else {
    console.error(`✗ ${err}`);
  }
  process.exit(1);
});
