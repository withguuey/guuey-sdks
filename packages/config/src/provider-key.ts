/**
 * The model provider key a project's agent needs, resolved ONE way.
 *
 * `guuey dev` checks the key before it boots the agent, and the scaffolded
 * project's own `bootstrap` / `dev` scripts check it before anything starts.
 * They must agree: a key one of them accepts and the other cannot find brings
 * back the failure the check exists to prevent. So both read it here, with the
 * same precedence (the shell environment, then `.env.local` at the project
 * root) and the same `.env.local` parsing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGuueyJsonFile } from './loader.js';
import type { AgentFramework } from './agent.js';

/** The environment variable each framework's model key rides on. */
export const PROVIDER_KEY_ENV_VAR: Record<AgentFramework, string> = {
  'claude-agent-sdk': 'ANTHROPIC_API_KEY',
  'openai-agents-sdk': 'OPENAI_API_KEY',
  'google-adk': 'GEMINI_API_KEY',
  // `vanilla` runs the bare Anthropic Messages API loop
  vanilla: 'ANTHROPIC_API_KEY',
};

/**
 * Where environment variables are read from: `process.env` by default. Typed
 * without Node's globals so this package's public declarations need no
 * `@types/node`.
 */
export type EnvSource = { readonly [name: string]: string | undefined };

/** A `guuey.json` with no `agent.framework` runs this one. */
export const DEFAULT_AGENT_FRAMEWORK: AgentFramework = 'claude-agent-sdk';

/**
 * Minimal `.env.local` parser: `KEY=VALUE` lines, `#` comments and blank lines
 * skipped, surrounding whitespace trimmed (so CRLF line ends read the same),
 * and one pair of matching quotes stripped from the value. Not a general
 * dotenv implementation: no multiline values, no `${VAR}` interpolation, no
 * `export ` prefix. The scaffolded `.env.example` only ever needs flat pairs.
 */
export function parseEnvLocal(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export interface ProviderKeyResolution {
  framework: AgentFramework;
  /** The environment variable the key rides on. */
  varName: string;
  /** The key, or null when neither source holds a non-empty value. Never log it. */
  value: string | null;
  /** Where the key was found. */
  source: 'env' | 'env-local' | null;
}

/**
 * The key for `framework`: a non-empty value in `env` wins; otherwise a
 * non-empty value in `<projectRoot>/.env.local`; otherwise none.
 */
export function resolveProviderKey(
  projectRoot: string,
  framework: AgentFramework,
  env: EnvSource = process.env,
): ProviderKeyResolution {
  const varName = PROVIDER_KEY_ENV_VAR[framework];
  const fromEnv = env[varName];
  if (typeof fromEnv === 'string' && fromEnv !== '') return { framework, varName, value: fromEnv, source: 'env' };
  const envLocalPath = join(projectRoot, '.env.local');
  if (existsSync(envLocalPath)) {
    const fromFile = parseEnvLocal(readFileSync(envLocalPath, 'utf8'))[varName];
    if (fromFile) return { framework, varName, value: fromFile, source: 'env-local' };
  }
  return { framework, varName, value: null, source: null };
}

/**
 * The key for the project at `projectRoot`, reading its framework from
 * `guuey.json#agent.framework` (default {@link DEFAULT_AGENT_FRAMEWORK}).
 * Throws what {@link readGuueyJsonFile} throws for a missing or invalid file.
 */
export function resolveProjectProviderKey(
  projectRoot: string,
  env: EnvSource = process.env,
): ProviderKeyResolution {
  const doc = readGuueyJsonFile(join(projectRoot, 'guuey.json'));
  return resolveProviderKey(projectRoot, doc.agent.framework ?? DEFAULT_AGENT_FRAMEWORK, env);
}

/** The one line every check prints when the key is missing. */
export function missingProviderKeyMessage(varName: string): string {
  return `Missing ${varName} — set it in your shell environment or in .env.local at the project root.`;
}
