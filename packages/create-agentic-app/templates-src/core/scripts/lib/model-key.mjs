// The model provider key this project's agent needs (ANTHROPIC_API_KEY,
// OPENAI_API_KEY or GEMINI_API_KEY, by guuey.json's framework), checked before
// anything starts. It is resolved by @guuey/config, the same function
// `guuey dev` uses, so a key this check accepts is a key the agent finds.
import { resolveProjectProviderKey, missingProviderKeyMessage, parseEnvLocal } from "@guuey/config";
import { ensureEnvLocalIgnored, readHidden, writeEnvLocalVar } from "./secret-prompt.mjs";

/** Whether this run may ask questions: a real terminal on stdin, and not a CI run. */
export function isInteractiveTerminal(stdin = process.stdin, env = process.env) {
  return stdin.isTTY === true && typeof stdin.setRawMode === "function" && !env.CI;
}

/** The .env.local form of `value` that parses back to exactly `value`. */
function envLocalForm(value) {
  return parseEnvLocal(`K=${value}\n`).K === value ? value : `"${value}"`;
}

/**
 * Resolve the key; when it is missing and `interactive`, ask for it (hidden,
 * skippable) and save it to .env.local. Returns one of:
 *   { status: "present" | "written", varName }
 *   { status: "missing" | "skipped" | "refused", varName, message }
 * "written" means the saved key reads back, through the same resolver the
 * agent uses, exactly as typed. The key itself is never returned, logged or
 * printed.
 */
export async function ensureModelKey({
  root = process.cwd(),
  interactive,
  input = process.stdin,
  output = process.stdout,
  log = (line) => console.log(line),
  env = process.env,
}) {
  const key = resolveProjectProviderKey(root, env);
  if (key.value !== null) return { status: "present", varName: key.varName };
  const message = missingProviderKeyMessage(key.varName);
  if (!interactive) return { status: "missing", varName: key.varName, message };
  // never ask for a secret that could not be kept out of git
  const ignored = ensureEnvLocalIgnored(root);
  if (!ignored.ok) {
    return { status: "refused", varName: key.varName, message: `Not saving ${key.varName} to .env.local: ${ignored.why}. ${message}` };
  }
  if (ignored.added) log("Added .env.local to .gitignore, so the key is never committed.");
  const answer = await readHidden({
    question: `${key.varName} for ${key.framework} (typing is hidden; press Enter to skip): `,
    input,
    output,
  });
  const typed = answer === null ? "" : answer.trim();
  if (typed === "") return { status: "skipped", varName: key.varName, message };
  writeEnvLocalVar(root, key.varName, envLocalForm(typed));
  if (resolveProjectProviderKey(root, env).value !== typed) {
    return {
      status: "refused",
      varName: key.varName,
      message: `${key.varName} was written to .env.local but does not read back as typed; set it there by hand. ${message}`,
    };
  }
  log(`Saved ${key.varName} to .env.local (mode 0600, ignored by git).`);
  return { status: "written", varName: key.varName };
}

/**
 * The check `pnpm dev` runs before anything starts: whether it may proceed,
 * or the one line to print when it may not.
 */
export async function devPreflight(options) {
  const r = await ensureModelKey(options);
  return r.status === "present" || r.status === "written" ? { proceed: true } : { proceed: false, message: r.message };
}
