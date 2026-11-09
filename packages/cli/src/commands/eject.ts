/**
 * guuey eject -- switch a declarative (no-code) app to code mode, for good.
 *
 * `guuey agent apply` updates a declarative app; `guuey deploy` deploys code.
 * The one move between them is this command, and it is one-way: the deploy
 * door replaces a live no-code build with a code build in place (guuey#2357)
 * and refuses the reverse in every state. So eject asks first, and says why:
 * a declarative app runs guuey's runtime, which guuey keeps up to date; a
 * code app runs an image built from your project, which only a rebuild
 * (`guuey deploy`) updates.
 *
 *   1. Read the app's deployments: refuse unless its serving build is no-code.
 *   2. Confirm (y/N on a terminal; `--yes` for scripts; refused otherwise).
 *   3. Scaffold a code project bound to the app (`@guuey/create-agentic-app`,
 *      the `base` template, `--framework` or else the live definition's),
 *      without the template's `ggui` block: the asset push is a full-state
 *      replace, so the template's empty ggui assets would wipe the app's own.
 *      Run inside (or `--dir` at) the declarative project the console's
 *      export path made for this app (`--template agent --app <id>`), eject
 *      converts THAT project in place instead (guuey#3276): create-agentic-app's
 *      `addCode` adds the worker beside the definition and flips
 *      `agent.mode`, then installs the worker's dependencies.
 *   4. `guuey pull` the live definition into it (the project keeps
 *      `agent.mode: "code"`).
 *   5. `guuey deploy` it: the first code build replaces the no-code one.
 *
 * Re-running eject on a directory it already scaffolded for the same app
 * skips the scaffold and pulls again (pull is idempotent on a code project),
 * so a run that died before or after its pull never deploys the template's
 * agent; the no-code build serves until a code build is live.
 *
 * Usage:
 *   guuey eject --app-id <id> [--dir <path>] [--framework <id>] [--yes]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { AddCodeError, addCode, scaffold, type Framework } from '@guuey/create-agentic-app';
import { GUUEY_JSON_FILENAME, safeParseGuueyJson } from '@guuey/config';
import { requireAuth } from '../auth';
import { resolveConfig, saveProjectConfig } from '../config';
import { apiRequest, parseApiError } from '../deploy-shared';
import { liveAgentMode } from '../deploy-plan';
import * as out from '../output';
import { pickSnapshotBuild, pull, type AppResponse, type DeploymentSnapshotResponse, type DeploymentsResponse } from './pull';
import { deploy } from './deploy';

/** The frameworks a code project can be scaffolded for (`@guuey/create-agentic-app`'s worker templates). */
export const EJECT_FRAMEWORKS: readonly Framework[] = ['claude-agent-sdk', 'openai-agents-sdk', 'google-adk'];

/** The confirmation eject asks, with the reason the switch is one-way. */
export function ejectQuestion(appId: string): string {
  return [
    `  Switch app ${appId} to code mode? This cannot be undone:`,
    "    - guuey can no longer update this app's runtime. A code app runs an image built from your project;",
    '      you rebuild it with guuey deploy to take runtime updates.',
    '    - guuey agent apply, the console and Studio can no longer publish to it.',
    '  Eject? [y/N] ',
  ].join('\n');
}

/**
 * The confirmation gate (pure): `--yes` skips it; a terminal (stdin AND
 * stdout) asks; anything else refuses, since there is no one to ask.
 */
export function resolveEjectConfirmation(opts: {
  yes: boolean;
  stdinIsTTY: boolean | undefined;
  stdoutIsTTY: boolean | undefined;
}): 'skip' | 'prompt' | 'refuse' {
  if (opts.yes) return 'skip';
  if (opts.stdinIsTTY === true && opts.stdoutIsTTY === true) return 'prompt';
  return 'refuse';
}

/** The default project directory: the app's name as an npm-safe slug, else `my-agent`. */
export function ejectDirName(displayName: string | null | undefined): string {
  const slug = (displayName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return slug || 'my-agent';
}

/**
 * The framework to scaffold for: `--framework` when given, else the live
 * definition's, else `claude-agent-sdk`. `null` names one with no code template.
 */
export function ejectFramework(flag: string | undefined, live: string | undefined): Framework | null {
  const wanted = flag ?? live;
  if (wanted === undefined) return 'claude-agent-sdk';
  return EJECT_FRAMEWORKS.find((f) => f === wanted) ?? null;
}

/** The part of a directory's guuey.json eject reads: which app it is bound to, and in which mode. */
export interface EjectDirBinding {
  appId?: string | undefined;
  agent?: { mode?: string | undefined } | undefined;
}

/**
 * What a directory holds for this eject: nothing yet (scaffold), this app's
 * code project (resume), this app's declarative project (convert it in place,
 * guuey#3276), or something else.
 */
export function ejectDirState(
  dirExists: boolean,
  entries: readonly string[],
  guueyJson: EjectDirBinding | null,
  appId: string,
): 'fresh' | 'resume' | 'convert' | 'occupied' {
  if (!dirExists || entries.length === 0) return 'fresh';
  if (guueyJson !== null && guueyJson.appId === appId) {
    return guueyJson.agent?.mode === 'code' ? 'resume' : 'convert';
  }
  return 'occupied';
}

/**
 * The directory eject works in: `--dir` when given; else the current
 * directory when its guuey.json is bound to this app (the console's export
 * path ends there, guuey#3276); else a new directory named after the app.
 */
export function ejectTargetDir(
  dirFlag: string | undefined,
  cwd: string,
  cwdBinding: EjectDirBinding | null,
  appId: string,
  displayName: string | null | undefined,
): string {
  if (dirFlag !== undefined && dirFlag.trim() !== '') return resolve(dirFlag.trim());
  if (cwdBinding !== null && cwdBinding.appId === appId) return resolve(cwd);
  return resolve(ejectDirName(displayName));
}

/**
 * The directory's guuey.json through the canonical schema, or `null` when
 * there is none or it is not a valid one (either way, not this app's code
 * project). Unreadable JSON stops eject: the directory is not empty and its
 * file cannot be judged.
 */
function readDirBinding(dir: string): EjectDirBinding | null {
  const path = join(dir, GUUEY_JSON_FILENAME);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    out.error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const parsed = safeParseGuueyJson(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Take the `ggui` block out of the project's guuey.json before eject's deploy.
 * A code deploy pushes the project's ggui assets as a FULL-STATE replace, and
 * while eject runs the app is still no-code, so its assets are the ones the
 * console set: any block here (the template's, or one a run that died before
 * this step left behind) would wipe them. Without the block the deploy skips
 * that leg and the app keeps them; the builder adds the block back after eject
 * to push their own. Runs on a fresh scaffold AND on a resume.
 */
function dropGguiBlock(dir: string): void {
  const path = join(dir, GUUEY_JSON_FILENAME);
  const parsed = safeParseGuueyJson(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    out.error(`${path} is not a valid guuey.json: ${parsed.error.message}`);
    process.exit(1);
  }
  if (parsed.data.ggui === undefined) return;
  const { ggui: _gguiBlock, ...rest } = parsed.data;
  saveProjectConfig(rest, path);
  console.log(
    "  Took the ggui block out of guuey.json: a deploy replaces all of an app's ggui assets, so eject's deploy keeps the app's as they are. To push your own ggui assets later, add a ggui block: a deploy then replaces the app's set with yours.",
  );
}

/**
 * A GET's body, or exit 1 with the server's message. Each caller passes its
 * own literal route to `apiRequest`, so the release gate's route derivation
 * reads every route eject calls.
 */
async function readOk<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    out.error(parseApiError(data, `Could not read ${what}: HTTP ${res.status}`));
    process.exit(1);
  }
  return (await res.json()) as T;
}

export async function eject(flags?: Record<string, string | true>): Promise<void> {
  // The switch is one-way, so the app is always named on the command line:
  // never a guuey.json binding or the machine-global default (guuey#355).
  const appIdFlag = flags?.['app-id'];
  const appId = typeof appIdFlag === 'string' ? appIdFlag.trim() : '';
  if (!appId) {
    out.error('Name the app to eject: guuey eject --app-id <id>.');
    process.exit(1);
  }
  const config = resolveConfig();
  const auth = requireAuth();

  // 1. Only a no-code app ejects.
  const { deployments } = await readOk<DeploymentsResponse>(
    await apiRequest(auth.pat, config, 'GET', `/apps/${appId}/deployments`),
    `app ${appId}'s deployments`,
  );
  const live = liveAgentMode(deployments);
  if (live === 'code') {
    out.error(`App ${appId} is already in code mode. Deploy it from its project with guuey deploy.`);
    process.exit(1);
  }
  const buildNumber = pickSnapshotBuild(deployments);
  if (live === null || buildNumber === null) {
    out.error(
      `App ${appId} has no live no-code build to eject. ` +
        `Eject copies a live no-code agent into a code project; guuey deployments list --app-id ${appId} shows this app's builds.`,
    );
    process.exit(1);
  }

  const { app } = await readOk<{ app: AppResponse }>(
    await apiRequest(auth.pat, config, 'GET', `/apps/${appId}`),
    `app ${appId}`,
  );
  const dirFlag = typeof flags?.dir === 'string' ? flags.dir : undefined;
  const cwd = process.cwd();
  // The current directory's binding matters only when no --dir names one.
  const cwdBinding = dirFlag === undefined || dirFlag.trim() === '' ? readDirBinding(cwd) : null;
  const dir = ejectTargetDir(dirFlag, cwd, cwdBinding, appId, app.displayName);
  const dirExists = existsSync(dir);
  const state = ejectDirState(dirExists, dirExists ? readdirSync(dir) : [], dirExists ? readDirBinding(dir) : null, appId);
  if (state === 'occupied') {
    out.error(`${dir} is not empty. Pass --dir <path> to eject into a new directory.`);
    process.exit(1);
  }

  // The framework is chosen for a scaffold or a conversion; a resumed project has one.
  let framework: Framework | undefined;
  if (state === 'fresh' || state === 'convert') {
    const { snapshot } = await readOk<DeploymentSnapshotResponse>(
      await apiRequest(auth.pat, config, 'GET', `/apps/${appId}/deployments/${buildNumber}`),
      `build #${buildNumber}'s definition`,
    );
    const frameworkFlag = typeof flags?.framework === 'string' ? flags.framework.trim() : undefined;
    const chosen = ejectFramework(frameworkFlag, snapshot?.agent.framework);
    if (chosen === null) {
      out.error(
        `"${frameworkFlag ?? snapshot?.agent.framework ?? ''}" has no code template. ` +
          `Pass --framework with one of: ${EJECT_FRAMEWORKS.join(', ')}.`,
      );
      process.exit(1);
    }
    framework = chosen;
  }

  // 2. The one-way switch is asked, never assumed.
  const confirmation = resolveEjectConfirmation({
    yes: flags?.yes === true,
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
  });
  if (confirmation === 'refuse') {
    out.error(
      `Refusing to switch app ${appId} to code mode without confirmation in a non-interactive session. ` +
        'It cannot be undone; pass --yes to confirm.',
    );
    process.exit(1);
  }
  if (confirmation === 'prompt') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((res) => rl.question(ejectQuestion(appId), res));
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('  Cancelled. The app stays declarative.');
      process.exit(1);
    }
  }

  // 3–4. A code project bound to the app, carrying its live definition.
  if (state === 'convert' && framework !== undefined) {
    console.log('');
    console.log(`  Adding the ${framework} worker to ${dir} ...`);
    try {
      const added = await addCode({ projectDir: dir, framework, install: true });
      console.log(`  Changed: ${added.changed.join(', ')}.`);
      if (added.keptWorkspaceFile) {
        console.log(
          `  Kept your pnpm-workspace.yaml: if the install refuses a build script, add the allow and ignore lists a ${framework} worker needs.`,
        );
      }
    } catch (err) {
      if (err instanceof AddCodeError) {
        out.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  } else if (framework !== undefined) {
    console.log('');
    console.log(`  Scaffolding a code project in ${dir} ...`);
    await scaffold({
      targetDir: dir,
      name: ejectDirName(app.displayName),
      framework,
      template: 'base',
      appId,
      install: false,
      git: true,
    });
  } else {
    console.log(`  Resuming in ${dir} (already scaffolded for app ${appId}).`);
  }
  // On both paths: a run that died between its scaffold and this line leaves
  // the template's block in a project that now reads as a resume.
  dropGguiBlock(dir);
  process.chdir(dir);
  await pull({ 'app-id': appId });

  // 5. The first code build replaces the no-code one — but only once it is
  // LIVE; until then the no-code build keeps serving, so say which happened.
  // The app is passed explicitly: --app-id wins over every other source
  // (GUUEY_APP_ID would otherwise re-target a bound project, guuey#975), so
  // the app switched is the app the question named.
  await deploy({ 'app-id': appId }, { allowNocodeToCode: true });
  const after = await readOk<DeploymentsResponse>(
    await apiRequest(auth.pat, config, 'GET', `/apps/${appId}/deployments`),
    `app ${appId}'s deployments`,
  );
  console.log(ejectOutcomeLine(liveAgentMode(after.deployments), appId, dir));
}

/**
 * The last line eject prints, read off the serving build after the deploy
 * returns. deploy exits on a failed or superseded build, so it returns only
 * when the build is live or its client wait ran out; the build then keeps
 * going and goes live on its own, and running eject again would start a
 * second build, so the line says to watch, not to retry.
 */
export function ejectOutcomeLine(live: 'code' | 'nocode' | null, appId: string, dir: string): string {
  return live === 'code'
    ? `  App ${appId} is in code mode. Your project is ${dir}; redeploy it with guuey deploy.`
    : `  App ${appId}'s code build is not live yet: it is still deploying, and its no-code build serves until it ` +
        `goes live on its own. Watch "guuey deployments list"; do not run eject again. Your project is ${dir}.`;
}
