/**
 * Target-app resolution shared by every app-scoped command.
 *
 * `--app-id` is documented as a global option ("Target a specific app —
 * overrides config"), so an explicit flag must win over the project /
 * GGUI_APP_ID / global-config binding everywhere. Commands that read only
 * `config.appId` silently swallow the flag, which reads as broken auth or
 * binding (guuey#183).
 */

/** Resolve the app a command targets: `--app-id` flag first, then the bound `config.appId`. */
export function resolveTargetAppId(
  flags: Record<string, string | true> | undefined,
  config: { appId?: string },
): string | undefined {
  const flag = flags?.['app-id'];
  return typeof flag === 'string' ? flag : config.appId;
}
