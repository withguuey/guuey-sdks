import {
  loadConfig,
  saveConfig,
  getConfigPath,
  loadProjectConfig,
  saveProjectConfig,
  getProjectConfigPath,
  resolveConfig,
  type CliConfig,
  type ProjectConfigInput,
} from '../config';
import { basename } from 'node:path';
import * as out from '../output';

const ALLOWED_KEYS: Record<string, keyof CliConfig> = {
  host: 'host',
  'api-key': 'apiKey',
  'app-id': 'appId',
};

/**
 * Handle `guuey config set <key> <value>`.
 * Persists a configuration value to the global config file (`~/.guuey/config.json`).
 *
 * @param key - Config key (`endpoint`, `api-key`, or `app-id`)
 * @param value - Value to set
 */
export function configSet(key: string, value: string): void {
  const configKey = ALLOWED_KEYS[key];
  if (!configKey) {
    out.error(
      `Unknown config key "${key}". Valid keys: ${Object.keys(ALLOWED_KEYS).join(', ')}`,
    );
    process.exit(1);
  }

  const config = loadConfig();
  config[configKey] = value;
  saveConfig(config);
  out.success(`Set ${key}`);
}

/**
 * Handle `guuey config show`.
 * Displays the resolved configuration (merging env vars, project config, and global config)
 * with the API key partially masked for security.
 */
export function configShow(): void {
  const project = loadProjectConfig();
  const resolved = resolveConfig();
  const projectPath = getProjectConfigPath();

  console.log(`Global config: ${getConfigPath()}`);
  if (projectPath) {
    console.log(`Project config: ${projectPath}`);
  }
  console.log('');

  // Show resolved config
  console.log('Resolved configuration:');
  const masked = {
    ...resolved,
    apiKey: resolved.apiKey
      ? resolved.apiKey.slice(0, 12) + '...' + resolved.apiKey.slice(-4)
      : undefined,
  };

  if (!masked.host && !masked.apiKey && !masked.appId) {
    console.log('  (no configuration set)');
    console.log('\nRun:');
    console.log('  guuey config set endpoint <url>');
    console.log('  guuey apps create --name "My App"');
    return;
  }

  for (const [k, v] of Object.entries(masked)) {
    if (v) console.log(`  ${k}: ${v}`);
  }

  // Show the canonical overlay settings if present.
  if (project) {
    console.log(
      `\nProject settings (${projectPath ? basename(projectPath) : 'guuey.json'}):`,
    );
    if (project.appId) console.log(`  appId: ${project.appId}`);
    if (project.workspaceId)
      console.log(`  workspaceId: ${project.workspaceId}`);
    if (project.agent.framework)
      console.log(`  agent.framework: ${project.agent.framework}`);
    if (project.agent.model)
      console.log(`  agent.model: ${project.agent.model}`);
    if (project.agent.deploy) {
      const parts: string[] = [];
      if (project.agent.deploy.size) parts.push(`size=${project.agent.deploy.size}`);
      if (project.agent.deploy.region) parts.push(`region=${project.agent.deploy.region}`);
      if (parts.length > 0) console.log(`  agent.deploy: ${parts.join(', ')}`);
    }
    if (project.app?.slug) console.log(`  app.slug: ${project.app.slug}`);
  }
}

/**
 * Handle `guuey config unset <key>`.
 * Removes a configuration value from the global config file.
 *
 * @param key - Config key to remove (`endpoint`, `api-key`, or `app-id`)
 */
export function configUnset(key: string): void {
  const configKey = ALLOWED_KEYS[key];
  if (!configKey) {
    out.error(
      `Unknown config key "${key}". Valid keys: ${Object.keys(ALLOWED_KEYS).join(', ')}`,
    );
    process.exit(1);
  }

  const config = loadConfig();
  delete config[configKey];
  saveConfig(config);
  out.success(`Unset ${key}`);
}

/**
 * Initialize a `guuey.json` in the current directory.
 *
 * Writes the canonical `GuueyJsonV1` overlay shape. If an `--app-id`
 * flag (or a resolved `appId` from env / global config) is present,
 * stamps it as `project.id`. Otherwise writes just the schema pin —
 * `guuey link` / `guuey pull` will later enrich the overlay with
 * project identity.
 */
export function configInit(flags: Record<string, string | true>): void {
  const existing = getProjectConfigPath();
  if (existing) {
    out.error(`Project config already exists: ${existing}`);
    process.exit(1);
  }

  const appIdFlag = flags['app-id'];
  const resolved = resolveConfig();
  const appId =
    typeof appIdFlag === 'string' ? appIdFlag : resolved.appId;

  // Scaffold a minimum-viable guuey.json. The `agent` section is required;
  // we populate sensible defaults the user can edit. `prompts/system.md`
  // is referenced but may not exist yet — `guuey deploy` will fail with
  // a clear error until the user creates it.
  const config: ProjectConfigInput = {
    schema: '1',
    ...(appId ? { appId } : {}),
    agent: {
      framework: 'claude-agent-sdk',
      model: 'claude-sonnet-4-6',
      systemPrompt: { file: 'prompts/system.md' },
    },
  };

  saveProjectConfig(config);
  out.success('Created guuey.json');
}
