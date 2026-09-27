/**
 * guuey#1908 — the scaffold's secret helper (templates-src/core/scripts/lib/
 * secret-prompt.mjs) and the model-key step on top of it: a hidden prompt that
 * restores the terminal on every path and never returns half-typed or
 * escape-mangled text, an atomic 0600 .env.local write that keeps every other
 * line, and a git-ignore check in the project's real repository that refuses
 * when git cannot answer.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHidden, writeEnvLocalVar, ensureEnvLocalIgnored } from "../templates-src/core/scripts/lib/secret-prompt.mjs";
import { ensureModelKey, devPreflight, isInteractiveTerminal } from "../templates-src/core/scripts/lib/model-key.mjs";

// git runs in some cases (a real repository per case): an explicit budget (guuey#867)
vi.setConfig({ testTimeout: 30_000 });
// hermetic git: a developer's global excludes or commit signing must not change what these cases see
vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");

const dirs = [];
function tmp(prefix = "caa-secret-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake terminal: a stream with isTTY and a setRawMode that records every call. */
function fakeTty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.rawCalls = [];
  input.setRawMode = (on) => {
    input.rawCalls.push(on);
    input.isRaw = on;
    return input;
  };
  let written = "";
  const output = { write: (s) => { written += s; } };
  return { input, output, written: () => written };
}
const mode = (p) => statSync(p).mode & 0o777;
const tick = () => new Promise((r) => setImmediate(r));

describe("readHidden", () => {
  it("returns the typed line, echoes none of it, and restores raw mode", async () => {
    const t = fakeTty();
    const p = readHidden({ question: "KEY: ", input: t.input, output: t.output });
    t.input.write("sk-secret-123\r");
    expect(await p).toBe("sk-secret-123");
    expect(t.written()).toBe("KEY: \n");
    expect(t.input.rawCalls).toEqual([true, false]);
  });

  it("backspace deletes; a pasted chunk ends at its line break", async () => {
    const t = fakeTty();
    const p = readHidden({ question: "", input: t.input, output: t.output });
    t.input.write("sk-abx\u007fc\rTRAILING");
    expect(await p).toBe("sk-abc");
  });

  it("arrow keys, Home/End, Delete and Alt+key add nothing to the text", async () => {
    const t = fakeTty();
    const p = readHidden({ question: "", input: t.input, output: t.output });
    t.input.write("sk-\u001b[Dab\u001b[3~c\u001bOHd\u001bxe\r");
    expect(await p).toBe("sk-abcde");
  });

  it("a multi-byte character split across two reads decodes whole", async () => {
    const t = fakeTty();
    const p = readHidden({ question: "", input: t.input, output: t.output });
    const bytes = Buffer.from("pässword\r", "utf8");
    t.input.write(bytes.subarray(0, 2));
    await tick();
    t.input.write(bytes.subarray(2));
    expect(await p).toBe("pässword");
  });

  it("an empty answer is a skip (null)", async () => {
    const t = fakeTty();
    const p = readHidden({ question: "", input: t.input, output: t.output });
    t.input.write("\r");
    expect(await p).toBeNull();
    expect(t.input.rawCalls).toEqual([true, false]);
  });

  it("Ctrl-D is a skip even after typing: a half-typed secret is never returned", async () => {
    const t = fakeTty();
    const p = readHidden({ question: "", input: t.input, output: t.output });
    t.input.write("sk-par\u0004");
    expect(await p).toBeNull();
    expect(t.input.rawCalls).toEqual([true, false]);
  });

  it("the input ending mid-line is a skip, and raw mode is restored", async () => {
    const t = fakeTty();
    const p = readHidden({ question: "", input: t.input, output: t.output });
    t.input.write("sk-par");
    await tick();
    t.input.end();
    expect(await p).toBeNull();
    expect(t.input.rawCalls).toEqual([true, false]);
  });

  it("Ctrl-C restores raw mode BEFORE the interrupt runs", async () => {
    const t = fakeTty();
    const seenAtInterrupt = [];
    const p = readHidden({ question: "", input: t.input, output: t.output, onInterrupt: () => seenAtInterrupt.push(t.input.isRaw) });
    t.input.write("sk-par\u0003");
    expect(await p).toBeNull();
    expect(seenAtInterrupt).toEqual([false]);
  });

  it("an input error rejects and still restores raw mode", async () => {
    const t = fakeTty();
    const p = readHidden({ question: "", input: t.input, output: t.output });
    t.input.emit("error", new Error("tty gone"));
    await expect(p).rejects.toThrow("tty gone");
    expect(t.input.rawCalls).toEqual([true, false]);
  });

  it("never prompts a non-terminal", async () => {
    const input = new PassThrough();
    let written = "";
    expect(await readHidden({ question: "KEY: ", input, output: { write: (s) => { written += s; } } })).toBeNull();
    expect(written).toBe("");
  });
});

describe("writeEnvLocalVar", () => {
  it("creates .env.local at mode 0600", () => {
    const root = tmp();
    writeEnvLocalVar(root, "ANTHROPIC_API_KEY", "sk-new");
    expect(readFileSync(join(root, ".env.local"), "utf8")).toBe("ANTHROPIC_API_KEY=sk-new\n");
    expect(mode(join(root, ".env.local"))).toBe(0o600);
  });

  it("replaces only that key in an existing 0644 file, keeps every other byte, and tightens it to 0600", () => {
    const root = tmp();
    const before = "# my settings\r\nOTHER=keep me\r\nANTHROPIC_API_KEY=\r\nLAST=1";
    writeFileSync(join(root, ".env.local"), before);
    chmodSync(join(root, ".env.local"), 0o644);
    expect(writeEnvLocalVar(root, "ANTHROPIC_API_KEY", "sk-new").action).toBe("replaced");
    expect(readFileSync(join(root, ".env.local"), "utf8")).toBe("# my settings\r\nOTHER=keep me\r\nANTHROPIC_API_KEY=sk-new\r\nLAST=1");
    expect(mode(join(root, ".env.local"))).toBe(0o600);
  });

  it("appends when absent (adding a line break first when the file lacks one) and replaces every duplicate", () => {
    const root = tmp();
    writeFileSync(join(root, ".env.local"), "OTHER=1");
    expect(writeEnvLocalVar(root, "OPENAI_API_KEY", "sk-o").action).toBe("added");
    expect(readFileSync(join(root, ".env.local"), "utf8")).toBe("OTHER=1\nOPENAI_API_KEY=sk-o\n");
    const dup = tmp();
    writeFileSync(join(dup, ".env.local"), "K=old1\nK=old2\n");
    writeEnvLocalVar(dup, "K", "new");
    expect(readFileSync(join(dup, ".env.local"), "utf8")).toBe("K=new\nK=new\n");
  });

  it("a symlinked .env.local is written through to its file; the link stays a link", () => {
    const root = tmp();
    const real = join(tmp("caa-real-"), "secrets.env");
    writeFileSync(real, "OTHER=1\n");
    symlinkSync(real, join(root, ".env.local"));
    writeEnvLocalVar(root, "K", "v");
    expect(lstatSync(join(root, ".env.local")).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("OTHER=1\nK=v\n");
    expect(mode(real)).toBe(0o600);
  });

  it("clears a temporary file an interrupted write left, and leaves none of its own", () => {
    const root = tmp();
    writeFileSync(join(root, ".env.local.123.456.tmp"), "K=stale-secret\n");
    writeEnvLocalVar(root, "K", "v");
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a value with a line break or a bad name, and changes nothing", () => {
    const root = tmp();
    writeEnvLocalVar(root, "K", "v");
    expect(() => writeEnvLocalVar(root, "K", "a\nB=c")).toThrow(/line break/);
    expect(() => writeEnvLocalVar(root, "BAD NAME", "v")).toThrow(/not an environment variable name/);
    expect(readFileSync(join(root, ".env.local"), "utf8")).toBe("K=v\n");
  });
});

const git = (root, ...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
function repo() {
  const root = tmp("caa-repo-");
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  return root;
}
const gitignored = (root, p) => {
  try {
    git(root, "check-ignore", "-q", p);
    return true;
  } catch {
    return false;
  }
};

describe("ensureEnvLocalIgnored (judged in the project's real repository)", () => {
  it("a repository that already ignores .env.local and the temporary file is left alone", () => {
    const root = repo();
    writeFileSync(join(root, ".gitignore"), ".env.local\n.env.local.*.tmp\n");
    expect(ensureEnvLocalIgnored(root)).toEqual({ ok: true, added: false });
  });

  it("a repository missing either gets the lines, checked again: both .env.local and a write's temporary file end up ignored", () => {
    const root = repo();
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.env.local\n");
    expect(ensureEnvLocalIgnored(root)).toEqual({ ok: true, added: true });
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules/\n.env.local\n.env.local.*.tmp\n");
    expect(gitignored(root, ".env.local")).toBe(true);
    expect(gitignored(root, ".env.local.123.456.tmp")).toBe(true);
  });

  it("a tracked .env.local stays unignored even with the lines: refused, naming the fix, and .gitignore is not appended twice", () => {
    const root = repo();
    writeFileSync(join(root, ".env.local"), "K=committed\n");
    git(root, "add", ".env.local");
    git(root, "commit", "-q", "-m", "oops");
    const r = ensureEnvLocalIgnored(root);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/already tracked\? `git rm --cached \.env\.local`/);
    ensureEnvLocalIgnored(root);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".env.local\n.env.local.*.tmp\n");
  });

  it("when git cannot answer (a broken .git), it refuses rather than guess from .gitignore text", () => {
    const root = tmp();
    writeFileSync(join(root, ".git"), "gitdir: /nonexistent/repo\n");
    writeFileSync(join(root, ".gitignore"), ".env.local\n.env.local.*.tmp\n");
    const r = ensureEnvLocalIgnored(root);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/could not ask git whether \.env\.local is ignored/);
  });

  it("outside a repository the project's .gitignore must list both (added when missing)", () => {
    const root = tmp();
    expect(ensureEnvLocalIgnored(root)).toEqual({ ok: true, added: true });
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".env.local\n.env.local.*.tmp\n");
    expect(ensureEnvLocalIgnored(root)).toEqual({ ok: true, added: false });
  });
});

describe("ensureModelKey", () => {
  const guueyJson = (framework) => JSON.stringify({ schema: "1", agent: { mode: "declarative", framework } });

  it("a key already set anywhere the agent reads is present, and nothing is asked", async () => {
    const root = tmp();
    writeFileSync(join(root, "guuey.json"), guueyJson("claude-agent-sdk"));
    const r = await ensureModelKey({ root, interactive: true, env: { ANTHROPIC_API_KEY: "sk-env" } });
    expect(r).toEqual({ status: "present", varName: "ANTHROPIC_API_KEY" });
  });

  it("at a terminal: asks (hidden), saves 0600 in an ignored .env.local, never prints the key", async () => {
    const root = repo();
    writeFileSync(join(root, "guuey.json"), guueyJson("openai-agents-sdk"));
    const t = fakeTty();
    const logs = [];
    const p = ensureModelKey({ root, interactive: true, input: t.input, output: t.output, log: (l) => logs.push(l), env: {} });
    await tick();
    t.input.write("sk-typed-secret\r");
    expect(await p).toEqual({ status: "written", varName: "OPENAI_API_KEY" });
    expect(readFileSync(join(root, ".env.local"), "utf8")).toBe("OPENAI_API_KEY=sk-typed-secret\n");
    expect(mode(join(root, ".env.local"))).toBe(0o600);
    expect(gitignored(root, ".env.local")).toBe(true);
    expect(t.written() + logs.join("\n")).not.toContain("sk-typed-secret");
  });

  it("a value the file would otherwise misread is quoted, and reads back exactly as typed", async () => {
    const root = repo();
    writeFileSync(join(root, "guuey.json"), guueyJson("claude-agent-sdk"));
    const t = fakeTty();
    const p = ensureModelKey({ root, interactive: true, input: t.input, output: t.output, log: () => {}, env: {} });
    await tick();
    t.input.write('"quoted-key"\r');
    expect((await p).status).toBe("written");
    expect(readFileSync(join(root, ".env.local"), "utf8")).toBe('ANTHROPIC_API_KEY=""quoted-key""\n');
  });

  it("a blank answer (spaces) is a skip, not a saved empty key", async () => {
    const root = tmp();
    writeFileSync(join(root, "guuey.json"), guueyJson("claude-agent-sdk"));
    const t = fakeTty();
    const p = ensureModelKey({ root, interactive: true, input: t.input, output: t.output, log: () => {}, env: {} });
    await tick();
    t.input.write("   \r");
    expect((await p).status).toBe("skipped");
    expect(existsSync(join(root, ".env.local"))).toBe(false);
  });

  it("when the key could not be kept out of git, it is never asked for", async () => {
    const root = repo();
    writeFileSync(join(root, "guuey.json"), guueyJson("claude-agent-sdk"));
    writeFileSync(join(root, ".env.local"), "OTHER=1\n");
    git(root, "add", ".env.local");
    git(root, "commit", "-q", "-m", "tracked");
    const t = fakeTty();
    const r = await ensureModelKey({ root, interactive: true, input: t.input, output: t.output, log: () => {}, env: {} });
    expect(r.status).toBe("refused");
    expect(r.message).toMatch(/^Not saving ANTHROPIC_API_KEY to \.env\.local: /);
    expect(t.written()).toBe("");
    expect(t.input.rawCalls).toEqual([]);
  });

  it("skipped at the prompt, or not at a terminal: missing, with the one line, and nothing written", async () => {
    const root = tmp();
    writeFileSync(join(root, "guuey.json"), guueyJson("google-adk"));
    const t = fakeTty();
    const p = ensureModelKey({ root, interactive: true, input: t.input, output: t.output, log: () => {}, env: {} });
    await tick();
    t.input.write("\r");
    const skipped = await p;
    expect(skipped.status).toBe("skipped");
    expect(skipped.message).toBe("Missing GEMINI_API_KEY — set it in your shell environment or in .env.local at the project root.");
    const headless = await ensureModelKey({ root, interactive: false, env: {} });
    expect(headless.status).toBe("missing");
    expect(readdirSync(root)).not.toContain(".env.local");
  });
});

describe("devPreflight and isInteractiveTerminal", () => {
  it("a key typed at the prompt lets dev proceed (the 'written' branch)", async () => {
    const root = repo();
    writeFileSync(join(root, "guuey.json"), JSON.stringify({ schema: "1", agent: { mode: "declarative" } }));
    const t = fakeTty();
    const p = devPreflight({ root, interactive: true, input: t.input, output: t.output, log: () => {}, env: {} });
    await tick();
    t.input.write("sk-typed\r");
    expect(await p).toEqual({ proceed: true });
  });

  it("a skip stops dev with the one line", async () => {
    const root = tmp();
    writeFileSync(join(root, "guuey.json"), JSON.stringify({ schema: "1", agent: { mode: "declarative" } }));
    expect(await devPreflight({ root, interactive: false, env: {} })).toEqual({
      proceed: false,
      message: "Missing ANTHROPIC_API_KEY — set it in your shell environment or in .env.local at the project root.",
    });
  });

  it("a terminal is interactive unless CI is set; a non-terminal never is", () => {
    const tty = { isTTY: true, setRawMode: () => {} };
    expect(isInteractiveTerminal(tty, {})).toBe(true);
    expect(isInteractiveTerminal(tty, { CI: "true" })).toBe(false);
    expect(isInteractiveTerminal({ isTTY: false }, {})).toBe(false);
  });
});
