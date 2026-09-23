/**
 * Who the agent is FOR (guuey#1597, his ruling 2026-09-23), on the CLI's
 * entry paths (guuey#1670). This module holds the question, its two answers,
 * the `--for` flag parser and the prompt's answer parser.
 *
 * The console's create wizard asks the same question first, with the same two
 * answers ("Just for me" / "For my customers", `NewAppForm.tsx`, cut 2). The
 * stored fact is `GuueyApp.builtFor`; the manifest declares it as
 * `app.builtFor` (`@guuey/config` `APP_BUILT_FOR`). An app created without an
 * answer stores nothing and reads `customers` server-side, which is today's
 * behaviour.
 */
import { APP_BUILT_FOR, type AppBuiltFor } from '@guuey/config';

/** The ruled copy (his 2026-09-23 word), the same title the console's first step carries. */
export const BUILT_FOR_QUESTION = 'Is this agent for you, or for your customers?';

/** The two answers, in the console's words and order. */
export const BUILT_FOR_LABEL: { readonly [K in AppBuiltFor]: string } = {
  personal: 'Just for me',
  customers: 'For my customers',
};

/** The deploy prompt's choice lines, printed once before the first ask. */
export const BUILT_FOR_CHOICES = [
  `  ${BUILT_FOR_QUESTION}`,
  `    1) ${BUILT_FOR_LABEL.personal}`,
  `    2) ${BUILT_FOR_LABEL.customers}`,
].join('\n');

/** The ask itself. There is no default: the console's Continue also waits for an answer. */
export const BUILT_FOR_ASK = '  Choose 1 or 2: ';

/** Printed after an answer the parser does not take, before asking again. */
export const BUILT_FOR_RETRY = `  Type 1 (${BUILT_FOR_LABEL.personal.toLowerCase()}) or 2 (${BUILT_FOR_LABEL.customers.toLowerCase()}).`;

export function isAppBuiltFor(value: string): value is AppBuiltFor {
  return (APP_BUILT_FOR as readonly string[]).includes(value);
}

/**
 * `--for <personal|customers>` on `guuey create` and `guuey apps create`.
 * Absent returns `undefined`, so the key is never sent and the answer is never
 * guessed. A valueless or unknown `--for` throws a sentence that names both
 * values.
 */
export function parseBuiltForFlag(value: string | true | undefined): AppBuiltFor | undefined {
  if (value === undefined) return undefined;
  const usage = 'Use --for personal (just for you) or --for customers (for your customers).';
  if (value === true) throw new Error(`--for needs a value. ${usage}`);
  if (isAppBuiltFor(value)) return value;
  throw new Error(`Unknown --for "${value}". ${usage}`);
}

/**
 * The deploy prompt's answer: the choice number, or the stored value's name.
 * Case and surrounding spaces are ignored. Anything else returns `undefined`,
 * and the prompt asks again.
 */
export function parseBuiltForAnswer(answer: string): AppBuiltFor | undefined {
  const a = answer.trim().toLowerCase();
  if (a === '1' || a === 'personal') return 'personal';
  if (a === '2' || a === 'customers') return 'customers';
  return undefined;
}
