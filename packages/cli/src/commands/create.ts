/**
 * guuey create -- Scaffold a new guuey agent project.
 *
 * Code-mode template scaffolding (Claude SDK / OpenAI / Google ADK / Vanilla
 * src/ directories) was retired with `@ggui-ai/build-templates`. The new
 * declarative scaffold (`guuey.json` + `ggui.json` + `agent.json`) is being
 * built as part of the agent-host launch — see slice 2 of the cleanup plan.
 *
 * Until that lands, this command exits with a pointer to the manual flow.
 */
import * as out from '../output';

export async function create(
  _nameArg?: string,
  _flags?: Record<string, string | true>,
): Promise<void> {
  out.error(
    'guuey create is being rebuilt for the declarative-agent flow.\n' +
      '  In the meantime, create your app via the platform UI or `guuey apps create`,\n' +
      '  then link locally with `guuey link <appId>`.',
  );
  process.exit(1);
}
