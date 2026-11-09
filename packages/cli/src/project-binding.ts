/**
 * Binding an app to the project in the current directory (guuey#3263).
 *
 * `guuey agent apply` and `guuey deploy` read a project's app from its
 * `guuey.json` `appId`, never from the CLI's global default, so an app made
 * for a project is bound there. One writer for every command that creates an
 * app for a project (`guuey apps create`, deploy's first-run create).
 */
import { writeGuueyJsonFile, type AppBuiltFor } from '@guuey/config';
import type { ProjectConfig } from './config';

/**
 * Write `appId` (and, when given, `app.builtFor`) into the project's
 * guuey.json; every other key is kept as loaded.
 */
export function bindAppIdIntoProject(opts: {
  guueyJsonPath: string;
  project: ProjectConfig;
  appId: string;
  builtFor?: AppBuiltFor;
}): void {
  const { guueyJsonPath, project, appId, builtFor } = opts;
  const appSection = builtFor !== undefined ? { ...project.app, builtFor } : project.app;
  writeGuueyJsonFile(guueyJsonPath, {
    ...project,
    appId,
    ...(appSection !== undefined ? { app: appSection } : {}),
  });
}
