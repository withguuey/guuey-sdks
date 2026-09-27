// Ask for a secret and keep it in .env.local, safely. Used by `pnpm bootstrap`
// and `pnpm dev` for the model provider key, and reusable for any other
// secret this project's scripts need to ask for.
//
// - readHidden: reads from a terminal with nothing echoed. An empty answer,
//   Ctrl-D or the end of input is a skip. It never prompts a non-terminal.
// - writeEnvLocalVar: sets one variable in .env.local. Every other line is
//   kept byte for byte, and the file is replaced atomically with mode 0600.
// - ensureEnvLocalIgnored: makes sure git ignores .env.local (and the
//   temporary file a write goes through) before a secret is written.
//
// The secret is never echoed, never passed on a command line, and never
// printed back.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/**
 * Read one line from a terminal without echoing it.
 * Resolves the text typed before Enter, or null when the answer is empty, the
 * user presses Ctrl-D, the input ends, or the input is not a terminal: a
 * half-typed secret is never returned. Ctrl-C calls `onInterrupt` (default:
 * exit 130). Terminal escape sequences (arrow keys, Home, End, Delete) are
 * ignored, never added to the text. The terminal's raw mode is restored on
 * every path.
 */
export function readHidden({ question, input = process.stdin, output = process.stdout, onInterrupt = () => process.exit(130) }) {
  return new Promise((resolve, reject) => {
    if (input.isTTY !== true || typeof input.setRawMode !== "function") {
      resolve(null);
      return;
    }
    const wasRaw = input.isRaw === true;
    const decoder = new StringDecoder("utf8");
    let value = "";
    let escape = null; // null | "esc" | "csi" | "ss3"
    let settled = false;
    const restore = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      try {
        input.setRawMode(wasRaw);
      } finally {
        input.pause();
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      restore();
      output.write("\n");
      resolve(result);
    };
    const onData = (chunk) => {
      try {
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        for (const ch of text) {
          if (escape === "esc") {
            // ESC [ … (CSI) and ESC O x (SS3) run on; ESC x (Alt+x) is just that one character
            escape = ch === "[" ? "csi" : ch === "O" ? "ss3" : null;
            continue;
          }
          if (escape === "csi") {
            if (ch >= "@" && ch <= "~") escape = null; // the final byte ends the sequence
            continue;
          }
          if (escape === "ss3") {
            escape = null;
            continue;
          }
          if (ch === "\u001b") {
            escape = "esc";
            continue;
          }
          if (ch === "\r" || ch === "\n") {
            finish(value === "" ? null : value);
            return;
          }
          if (ch === "\u0004") {
            finish(null);
            return;
          }
          if (ch === "\u0003") {
            finish(null);
            onInterrupt();
            return;
          }
          if (ch === "\u007f" || ch === "\b") {
            value = Array.from(value).slice(0, -1).join("");
            continue;
          }
          if (ch >= " ") value += ch;
        }
      } catch (err) {
        if (!settled) {
          settled = true;
          restore();
        }
        reject(err);
      }
    };
    const onEnd = () => finish(null);
    const onError = (err) => {
      if (settled) return;
      settled = true;
      restore();
      reject(err);
    };
    output.write(question);
    input.setRawMode(true);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}

/** The key of a .env.local line, read the way @guuey/config's parser reads it. */
function lineKey(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  return eq === -1 ? null : trimmed.slice(0, eq).trim();
}

/** The name a write's temporary file takes: `.env.local.<pid>.<ms>.tmp`. */
const TEMP_NAME = /^\.env\.local\.\d+\.\d+\.tmp$/;

/**
 * Set `name=value` in `<root>/.env.local`. Every line whose key is `name` is
 * replaced (the parser keeps the last duplicate, so all of them must agree);
 * every other line is kept byte for byte; the variable is appended when
 * absent. The file is written to a new 0600 file in the same directory,
 * synced, and renamed over the old one, so a crash never truncates it. A
 * symlinked .env.local is written through to the file it points at.
 */
export function writeEnvLocalVar(root, name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`not an environment variable name: ${name}`);
  if (/[\r\n]/.test(value)) throw new Error(`the value for ${name} contains a line break; not writing it`);
  const link = join(root, ".env.local");
  const target = existsSync(link) && lstatSync(link).isSymbolicLink() ? realpathSync(link) : link;
  const dir = dirname(target);
  // a write interrupted before its rename leaves a temporary file; clear any
  for (const f of readdirSync(dir)) if (TEMP_NAME.test(f)) unlinkSync(join(dir, f));
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  const line = `${name}=${value}`;
  let replaced = false;
  let content;
  if (existing === "") {
    content = `${line}\n`;
  } else {
    const next = existing.split("\n").map((l) => {
      if (lineKey(l) !== name) return l;
      replaced = true;
      return l.endsWith("\r") ? `${line}\r` : line;
    });
    content = next.join("\n");
    if (!replaced) content += `${content.endsWith("\n") ? "" : "\n"}${line}\n`;
  }
  const tmp = join(dir, `${basename(link)}.${process.pid}.${Date.now()}.tmp`);
  let renamed = false;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
    renamed = true;
    chmodSync(target, 0o600);
  } finally {
    if (!renamed && existsSync(tmp)) unlinkSync(tmp);
  }
  return { path: target, action: replaced ? "replaced" : "added" };
}

/** The paths a secret can land in: .env.local and the temporary file a write goes through. */
const SECRET_PATHS = [".env.local", ".env.local.0.0.tmp"];
/** The .gitignore lines that cover them. */
const IGNORE_LINES = [".env.local", ".env.local.*.tmp"];

function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0];
}

/** Whether git ignores every secret path, or why it could not say. */
function gitIgnoresAll(root) {
  for (const p of SECRET_PATHS) {
    const r = spawnSync("git", ["check-ignore", "-q", p], { cwd: root, encoding: "utf8" });
    if (r.status === 1) return { ignored: false };
    if (r.status !== 0) return { ignored: false, error: firstLine(r.stderr) || `git check-ignore exited ${r.status}` };
  }
  return { ignored: true };
}

/** Append whichever IGNORE_LINES the project's .gitignore lacks; returns whether it changed. */
function addToGitignore(root) {
  const path = join(root, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const present = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = IGNORE_LINES.filter((l) => !present.has(l) && !present.has(`/${l}`));
  if (missing.length === 0) return false;
  writeFileSync(path, `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);
  return true;
}

/** Whether a `.git` entry exists at `root` or any directory above it. */
function gitEntryAbove(root) {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * Make sure git ignores .env.local, and the temporary file a write goes
 * through, before a secret goes into it, judged in the project's ACTUAL
 * repository with `git check-ignore`. When it does not, the lines are added
 * to the project's .gitignore and checked again; if git still would not ignore
 * them (for example, .env.local is already tracked), the result says so and
 * nothing should be written. A project that is not in a repository must list
 * them in its .gitignore, so a later `git init` never picks the secret up.
 * When git cannot answer (it is missing, or fails for any other reason than
 * "not a repository"), the result is a refusal: an unknown is never treated as
 * ignored.
 */
export function ensureEnvLocalIgnored(root) {
  const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8" });
  const inRepo = probe.status === 0 && probe.stdout.trim() === "true";
  const notARepo = probe.status === 128 && /not a git repository/i.test(probe.stderr ?? "") && !gitEntryAbove(root);
  const gitMissing = probe.error !== undefined && probe.error.code === "ENOENT" && !gitEntryAbove(root);
  if (!inRepo && !notARepo && !gitMissing) {
    const why = probe.error !== undefined ? probe.error.message : firstLine(probe.stderr) || `git rev-parse exited ${probe.status}`;
    return { ok: false, added: false, why: `could not ask git whether .env.local is ignored (${why})` };
  }
  if (inRepo) {
    const first = gitIgnoresAll(root);
    if (first.error) return { ok: false, added: false, why: `could not ask git whether .env.local is ignored (${first.error})` };
    if (first.ignored) return { ok: true, added: false };
    const added = addToGitignore(root);
    const second = gitIgnoresAll(root);
    if (second.ignored) return { ok: true, added };
    return {
      ok: false,
      added,
      why:
        second.error !== undefined
          ? `could not ask git whether .env.local is ignored (${second.error})`
          : "git does not ignore .env.local here, even with it in .gitignore (is it already tracked? `git rm --cached .env.local`)",
    };
  }
  return { ok: true, added: addToGitignore(root) };
}
