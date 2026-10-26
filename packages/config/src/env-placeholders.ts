/**
 * Deploy-time `${env.NAME}` placeholders in an AUTHORED `guuey.json`.
 *
 * One manifest has to serve several apps (dev, staging, production) whose
 * own MCP server and own identity provider differ per environment. The
 * manifest names the variable; the CLI fills it in from the environment it
 * runs in, right before it sends anything:
 *
 *   "url": "${env.PRODUCT_MCP_URL}"
 *   "userAuthConfig": { "issuerUrl": "${env.PRODUCT_ISSUER_URL}", "audience": "${env.PRODUCT_AUDIENCE}" }
 *
 * The syntax is the one `headers` already use. What differs is WHO resolves
 * it, and that is fixed per field:
 *
 * - {@link ENV_PLACEHOLDER_FIELDS} — the CLI, at deploy / apply / dev time,
 *   from its own process environment. The platform only ever receives the
 *   resolved value: the stored snapshot, the reconcile body and the pod
 *   config hold a plain URL / issuer / audience, so no server or pod reads
 *   this grammar.
 * - `agent.mcpServers.<name>.headers.*` — the hosted agent, at call time,
 *   from the environment the platform gives it (`agent.env`, plus the app's
 *   variables and secrets: which processes in the agent receive those, and
 *   when, is listed at
 *   https://docs.guuey.com/concepts-byok/#the-custody-table; a secret's
 *   name is declared in `agent.secrets`). The CLI never touches these, so a
 *   secret value never passes through a builder's shell or a deploy log.
 * - Anywhere else in `app.access`, `app.page` or `mcpResourceUrl` a
 *   placeholder is refused: nothing would resolve it.
 *
 * A variable is either a deploy-time value or a pod secret, never both: a
 * name declared in `agent.secrets` is refused in a deploy-time field.
 *
 * The wire schema ({@link GuueyJsonV1}) is deliberately NOT widened. The
 * authored form is validated by {@link parseAuthoredGuueyJson}, which the
 * file helpers in `loader.ts` use; whatever reaches a server passes the
 * strict schema after {@link resolveEnvPlaceholders}.
 */
import { GuueyJsonV1, safeParseGuueyJson } from './schema.js';
import type { EnvSource } from './provider-key.js';

/** The fields whose `${env.NAME}` placeholders the CLI resolves before sending. */
export const ENV_PLACEHOLDER_FIELDS = [
  'agent.mcpServers.<name>.url',
  'app.access.userAuthConfig.issuerUrl',
  'app.access.userAuthConfig.audience',
] as const;

/** The name grammar is the `headers` one (`agent.ts` ENV_REF_GLOBAL). */
const TOKEN_RE = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
const MARK = '${env.';
/** Whole-value placeholder in a url → a URL that parses and can never be real. */
const STAND_IN_URL = 'https://env-placeholder.invalid';
const STAND_IN_PART = 'env-placeholder';

/** A placeholder problem: the message names fields and variables, never a value. */
export class EnvPlaceholderError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(
      `guuey.json \${env.NAME} placeholders could not be resolved:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    this.name = 'EnvPlaceholderError';
    this.problems = problems;
  }
}

/** One deploy-time field holding a placeholder: where it is, and its authored text. */
interface EnvSlot {
  readonly path: string;
  readonly value: string;
}

function tokenNames(value: string): string[] {
  return [...value.matchAll(TOKEN_RE)].map((m) => m[1]!);
}

function isMalformed(value: string): boolean {
  return value.replace(TOKEN_RE, '').includes(MARK);
}

/** Every deploy-time field of a parsed document that carries `${env.`. */
function envSlots(doc: GuueyJsonV1): EnvSlot[] {
  const slots: EnvSlot[] = [];
  for (const [name, entry] of Object.entries(doc.agent.mcpServers ?? {})) {
    if (entry !== false && entry.kind === 'external' && entry.url.includes(MARK)) {
      slots.push({ path: `agent.mcpServers.${name}.url`, value: entry.url });
    }
  }
  const auth = doc.app?.access?.userAuthConfig;
  if (auth !== undefined && auth !== null) {
    if (auth.issuerUrl.includes(MARK)) slots.push({ path: 'app.access.userAuthConfig.issuerUrl', value: auth.issuerUrl });
    if (auth.audience.includes(MARK)) slots.push({ path: 'app.access.userAuthConfig.audience', value: auth.audience });
  }
  return slots;
}

/** Fields where a placeholder would never be resolved by anyone. */
function refusedPlaceholderPaths(doc: GuueyJsonV1): string[] {
  const refused: string[] = [];
  for (const [name, entry] of Object.entries(doc.agent.mcpServers ?? {})) {
    if (entry !== false && entry.kind === 'external' && entry.mcpResourceUrl?.includes(MARK) === true) {
      refused.push(`agent.mcpServers.${name}.mcpResourceUrl`);
    }
  }
  (doc.app?.access?.allowedDomains ?? []).forEach((domain, i) => {
    if (domain.includes(MARK)) refused.push(`app.access.allowedDomains[${i}]`);
  });
  const page = doc.app?.page;
  if (page?.ctaUrl?.includes(MARK) === true) refused.push('app.page.ctaUrl');
  if (page?.identityEndpointUrl?.includes(MARK) === true) refused.push('app.page.identityEndpointUrl');
  return refused;
}

/** The variable names a document's deploy-time fields read, sorted and unique. */
export function envPlaceholderNames(doc: GuueyJsonV1): string[] {
  return [...new Set(envSlots(doc).flatMap((s) => tokenNames(s.value)))].sort();
}

/** Raw JSON before validation — its shape is exactly what is being checked. */
type JsonObject = { readonly [key: string]: unknown };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function standInUrl(url: string): string {
  const whole = /^\$\{env\.[A-Za-z_][A-Za-z0-9_]*\}$/.test(url);
  return whole ? STAND_IN_URL : url.replace(TOKEN_RE, STAND_IN_PART);
}

/**
 * Replace every external server's placeholder url with a stand-in that the
 * strict schema checks as a URL. Returns the authored urls by server name.
 */
function withUrlStandIns(raw: unknown): { standIn: unknown; authoredUrls: Map<string, string> } {
  const authoredUrls = new Map<string, string>();
  if (!isJsonObject(raw) || !isJsonObject(raw.agent) || !isJsonObject(raw.agent.mcpServers)) {
    return { standIn: raw, authoredUrls };
  }
  const servers: { [name: string]: unknown } = {};
  for (const [name, entry] of Object.entries(raw.agent.mcpServers)) {
    if (isJsonObject(entry) && typeof entry.url === 'string' && entry.url.includes(MARK)) {
      authoredUrls.set(name, entry.url);
      servers[name] = { ...entry, url: standInUrl(entry.url) };
    } else {
      servers[name] = entry;
    }
  }
  if (authoredUrls.size === 0) return { standIn: raw, authoredUrls };
  return { standIn: { ...raw, agent: { ...raw.agent, mcpServers: servers } }, authoredUrls };
}

/**
 * Parse an AUTHORED `guuey.json` (a file on disk, or a document about to be
 * written to one): the strict {@link GuueyJsonV1} schema, plus `${env.NAME}`
 * in the {@link ENV_PLACEHOLDER_FIELDS}. The placeholders come back verbatim,
 * so a read-modify-write keeps them. A malformed placeholder in those fields,
 * or any placeholder in a field nothing resolves, throws.
 */
export function parseAuthoredGuueyJson(raw: unknown): GuueyJsonV1 {
  const { standIn, authoredUrls } = withUrlStandIns(raw);
  const doc = GuueyJsonV1.parse(standIn);
  if (authoredUrls.size > 0 && doc.agent.mcpServers !== undefined) {
    const servers = { ...doc.agent.mcpServers };
    for (const [name, url] of authoredUrls) {
      const entry = servers[name];
      if (entry !== undefined && entry !== false && entry.kind === 'external') servers[name] = { ...entry, url };
    }
    doc.agent = { ...doc.agent, mcpServers: servers };
  }
  const problems: string[] = [];
  for (const slot of envSlots(doc)) {
    if (isMalformed(slot.value)) {
      problems.push(`${slot.path}: malformed placeholder — write \${env.NAME} (letters, digits and _; not starting with a digit)`);
    }
  }
  for (const path of refusedPlaceholderPaths(doc)) {
    problems.push(
      `${path}: \${env.NAME} is resolved only in ${ENV_PLACEHOLDER_FIELDS.join(', ')} (by the CLI) and in mcpServers headers (secrets, by the agent)`,
    );
  }
  if (problems.length > 0) throw new EnvPlaceholderError(problems);
  return doc;
}

/**
 * Substitute every deploy-time placeholder from `env` and return the document
 * the platform receives, re-validated against the strict wire schema. A
 * document without placeholders is returned as the same object.
 *
 * Fails, naming every problem at once, when a variable is unset or empty, is
 * also declared in `agent.secrets`, or carries a placeholder of its own, or
 * when the substituted field is not valid. Errors and `substituted` carry
 * variable names, never values.
 */
export function resolveEnvPlaceholders(
  doc: GuueyJsonV1,
  env: EnvSource,
): { doc: GuueyJsonV1; substituted: string[] } {
  const names = envPlaceholderNames(doc);
  if (names.length === 0) return { doc, substituted: [] };

  const secrets = new Set(doc.agent.secrets ?? []);
  const problems: string[] = [];
  for (const name of names) {
    const value = env[name];
    if (secrets.has(name)) {
      problems.push(
        `${name} is declared in agent.secrets — a secret is filled in by the hosted agent in mcpServers headers, never by the CLI at deploy time; give the deploy-time value its own variable name`,
      );
    } else if (value === undefined || value === '') {
      problems.push(`${name} is not set in the environment (an empty value counts as unset)`);
    } else if (value.includes('${')) {
      problems.push(`${name} holds a placeholder of its own — its value must be the final text`);
    }
  }
  if (problems.length > 0) throw new EnvPlaceholderError(problems);

  const substitute = (value: string): string => value.replace(TOKEN_RE, (_, name: string) => env[name]!);
  const resolved: GuueyJsonV1 = JSON.parse(JSON.stringify(doc));
  for (const entry of Object.values(resolved.agent.mcpServers ?? {})) {
    if (entry !== false && entry.kind === 'external') entry.url = substitute(entry.url);
  }
  const auth = resolved.app?.access?.userAuthConfig;
  if (auth !== undefined && auth !== null) {
    auth.issuerUrl = substitute(auth.issuerUrl);
    auth.audience = substitute(auth.audience);
  }

  const parsed = safeParseGuueyJson(resolved);
  if (!parsed.success) {
    const fieldProblems = parsed.error.issues.map((issue) => {
      const path = issue.path.map(String).join('.');
      const slot = envSlots(doc).find((s) => s.path === path);
      const from = slot === undefined ? '' : ` (after substituting ${tokenNames(slot.value).join(', ')})`;
      return `${path || '(root)'}: ${issue.message}${from}`;
    });
    throw new EnvPlaceholderError(fieldProblems);
  }
  return { doc: parsed.data, substituted: names };
}
