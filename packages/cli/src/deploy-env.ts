/**
 * The environment a deploy resolves guuey.json's deploy-time `${env.NAME}`
 * placeholders from (see `@guuey/config` `env-placeholders.ts`): the CLI's
 * own process environment, plus an optional `--env-file <path>`.
 *
 * A name set in both places with different values is refused instead of
 * one silently winning — a shell left exporting one environment's value
 * must never quietly override the file chosen for another.
 */
import { readFileSync } from 'node:fs';
import type { EnvSource } from '@guuey/config';

const LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  // An unquoted value ends at an inline ` #` comment.
  const hash = v.search(/\s#/);
  return (hash === -1 ? v : v.slice(0, hash)).trim();
}

/**
 * Parse a dotenv-style file: `NAME=value` lines, optional `export `, `#`
 * comment lines, single- or double-quoted values (taken literally). A line
 * that is none of those, or a name given twice, throws — naming the line,
 * never a value.
 */
export function parseEnvFileText(text: string, label: string): Map<string, string> {
  const vars = new Map<string, string>();
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const m = LINE_RE.exec(trimmed);
    if (m === null) throw new Error(`${label}:${i + 1}: expected NAME=value`);
    const name = m[1]!;
    if (vars.has(name)) throw new Error(`${label}:${i + 1}: ${name} is set twice`);
    vars.set(name, unquote(m[2]!));
  });
  return vars;
}

/**
 * The variables a deploy reads: `processEnv`, plus the `--env-file` named in
 * `flags` when there is one. Throws on an unreadable or malformed file, and
 * on a name the file and the process environment both set to different
 * values.
 */
export function deployEnv(
  flags: Record<string, string | true> | undefined,
  processEnv: EnvSource,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): EnvSource {
  const file = flags?.['env-file'];
  if (file === undefined) return processEnv;
  if (file === true) throw new Error('--env-file needs a path');
  const fromFile = parseEnvFileText(readFile(file), file);
  const merged: { [name: string]: string | undefined } = { ...processEnv };
  const conflicts: string[] = [];
  for (const [name, value] of fromFile) {
    const current = processEnv[name];
    if (current !== undefined && current !== '' && current !== value) conflicts.push(name);
    merged[name] = value;
  }
  if (conflicts.length > 0) {
    throw new Error(
      `${conflicts.join(', ')} ${conflicts.length === 1 ? 'is' : 'are'} set both in the environment and in ${file} with different values — unset ${conflicts.length === 1 ? 'it' : 'them'} in the shell or drop ${conflicts.length === 1 ? 'it' : 'them'} from the file`,
    );
  }
  return merged;
}

/** The one line a deploy prints about its placeholders: names only, never values. */
export function substitutedLine(names: readonly string[]): string {
  return `  \${env.*} resolved from the environment: ${names.join(', ')}`;
}
