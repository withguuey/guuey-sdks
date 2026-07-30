/**
 * Source-text parser for the CLI's cliApi wire-type SYNC GUARDS
 * (`commands/wire-sync.test.ts`).
 *
 * ## Why the CLI mirrors wire types at all
 *
 * `@guuey-private/cli-wire` is the one source for cliApi's `/v1/*` request
 * and response shapes — the Lambda handlers import from it, and so does the
 * console (`apps/platform`). `@guuey/cli` cannot: it is a PUBLISHED npm
 * package and cli-wire is `private: true`, so a runtime dependency edge onto
 * it would publish a package nobody can install. Adding it as a devDependency
 * would leave an unresolvable `workspace:*` in the published manifest. So the
 * CLI keeps hand-written mirrors and pins them, the same way the repo already
 * pins `@guuey/host`'s constant mirrors and the `MCP_BILLING_ROUTE` route
 * string (guuey#33).
 *
 * ## What the guards compare, and what they do not
 *
 * FIELD NAMES and OPTIONALITY, parsed from both sides' source text. Not field
 * TYPES — and that is deliberate, not laziness: the CLI widens several of
 * them on purpose (`hostingStatus: string` where the wire says
 * `McpHostingStatus`, spec §4, so an unrecognised future status prints
 * verbatim instead of failing to compile). A type-equality guard would fail
 * on those by design and get suppressed, which is worse than no guard.
 *
 * Field-name drift is the bug class that has actually bitten: `apps.ts`'s
 * `AppSummary` read `.name` where the wire sends `displayName`, and rendered
 * an empty Name column in `guuey apps list` (S5). That is exactly what these
 * guards catch.
 *
 * Source text rather than an import because there is nothing importable —
 * see above. The guards read cli-wire's `.ts` files off disk and skip
 * themselves when `backend/` is absent (a consumer's `node_modules` copy);
 * the monorepo CI always has it, and the monorepo is the only place a
 * divergence can be introduced.
 */

/** One declared member of an interface: its name and whether it is optional. */
export interface WireField {
  name: string;
  optional: boolean;
}

/** Strip `//` line and block comments so their contents never parse as members. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * The text between the braces of `interface <name> { … }`, brace-matched so a
 * nested object type (`latestBuild?: { … }`) does not end the body early.
 * Throws rather than returning empty: a guard that silently compares nothing
 * is the tautology this whole file exists to avoid.
 */
function interfaceBody(source: string, name: string): string {
  const header = new RegExp(`(?:export\\s+)?interface\\s+${name}\\b[^{]*\\{`).exec(source);
  if (header === null) {
    throw new Error(`interface ${name} not found in source`);
  }
  let depth = 1;
  const start = header.index + header[0].length;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i);
    }
  }
  throw new Error(`interface ${name} has no closing brace`);
}

/**
 * Split an interface body into its top-level members. Members are `;`- or
 * `,`-separated; separators nested inside `{}` / `()` / `[]` / `<>` belong to
 * a member's TYPE, not to the member list, so depth is tracked across all
 * four bracket kinds.
 */
function topLevelMembers(body: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '{' || char === '(' || char === '[' || char === '<') depth += 1;
    else if (char === '}' || char === ')' || char === ']' || char === '>') depth -= 1;
    if ((char === ';' || char === ',') && depth === 0) {
      members.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  members.push(current);
  return members.filter((member) => member.trim().length > 0);
}

/**
 * The declared fields of `interface <name>` in `source`, sorted by name so
 * two sides compare independently of declaration order.
 */
export function parseInterfaceFields(source: string, name: string): WireField[] {
  const members = topLevelMembers(interfaceBody(stripComments(source), name));
  const fields: WireField[] = [];
  for (const member of members) {
    const match = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\??)\s*:/.exec(member);
    if (match === null) {
      throw new Error(`unparsed member in interface ${name}: ${member.trim()}`);
    }
    fields.push({ name: match[1], optional: match[2] === '?' });
  }
  return fields.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The string literals of a `type X = 'a' | 'b';` union or a
 * `const X = ['a', 'b'] as const;` array, in declaration order.
 */
export function parseStringLiterals(source: string, name: string): string[] {
  const stripped = stripComments(source);
  const union = new RegExp(`(?:export\\s+)?type\\s+${name}\\s*=([^;]*);`).exec(stripped);
  const array = new RegExp(
    `(?:export\\s+)?const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]\\s*as const;`,
  ).exec(stripped);
  const declaration = array?.[1] ?? union?.[1];
  if (declaration === undefined) {
    throw new Error(`no literal union or const array named ${name} in source`);
  }
  return [...declaration.matchAll(/'([^']*)'/g)].map((match) => match[1]);
}
