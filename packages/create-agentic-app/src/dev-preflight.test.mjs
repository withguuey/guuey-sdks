/**
 * guuey#1908 — `pnpm dev` (templates-src/core/scripts/dev.mjs) checks the
 * model key BEFORE anything starts. Run for real against a temp project with a
 * fake `pnpm` first on PATH that records every invocation: with no key and no
 * terminal the run stops with the one-line fix and starts NOTHING (not even
 * the first build); with the key in the shell or in .env.local every service
 * starts. The key is resolved by the project's @guuey/config, linked in.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// every case spawns the real dev.mjs and a fake pnpm per service: an explicit budget (guuey#867)
vi.setConfig({ testTimeout: 60_000 });

const here = dirname(fileURLToPath(import.meta.url));
const coreScripts = join(here, "..", "templates-src", "core", "scripts");
const configPkg = join(here, "..", "..", "config");

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FAKE_PNPM = `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.DEV_TEST_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`;

function project({ framework, envLocal }) {
  const root = mkdtempSync(join(tmpdir(), "caa-dev-"));
  dirs.push(root);
  cpSync(coreScripts, join(root, "scripts"), { recursive: true });
  // dev.mjs boots ggui with cwd "ggui"; a scaffold always has that directory
  mkdirSync(join(root, "ggui"));
  writeFileSync(join(root, "guuey.json"), JSON.stringify({ schema: "1", agent: { mode: "declarative", framework } }));
  if (envLocal !== undefined) writeFileSync(join(root, ".env.local"), envLocal);
  mkdirSync(join(root, "node_modules", "@guuey"), { recursive: true });
  symlinkSync(configPkg, join(root, "node_modules", "@guuey", "config"), "dir");
  const bin = join(root, ".bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), FAKE_PNPM);
  chmodSync(join(bin, "pnpm"), 0o755);
  return { root, bin, log: join(root, "pnpm.log") };
}

/** Run dev.mjs with NO terminal on stdin and ONLY the environment given (no inherited provider keys). */
function runDev(p, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = { PATH: `${p.bin}:${process.env.PATH}`, HOME: p.root, DEV_TEST_LOG: p.log, ...extraEnv };
    const child = spawn(process.execPath, [join(p.root, "scripts", "dev.mjs")], { cwd: p.root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const invocations = (p) => (existsSync(p.log) ? readFileSync(p.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

describe("pnpm dev: the model key before anything starts", () => {
  it("precondition: the linked @guuey/config is built (the resolver the preflight imports)", () => {
    expect(existsSync(join(configPkg, "dist", "provider-key.js"))).toBe(true);
  });

  it("no key, no terminal: stops with the one-line fix and starts nothing, not even the first build", async () => {
    const p = project({ framework: "claude-agent-sdk" });
    const r = await runDev(p);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("✗ Missing ANTHROPIC_API_KEY — set it in your shell environment or in .env.local at the project root.");
    expect(invocations(p)).toEqual([]);
    // no terminal means no prompt and no writes: neither .env.local nor .gitignore appears
    expect(existsSync(join(p.root, ".env.local"))).toBe(false);
    expect(existsSync(join(p.root, ".gitignore"))).toBe(false);
  });

  it("the key of ANOTHER framework does not count: an openai project with only ANTHROPIC_API_KEY stops", async () => {
    const p = project({ framework: "openai-agents-sdk" });
    const r = await runDev(p, { ANTHROPIC_API_KEY: "sk-ant" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("✗ Missing OPENAI_API_KEY");
    expect(invocations(p)).toEqual([]);
  });

  it("the key in the shell: the first build and every service start", async () => {
    const p = project({ framework: "claude-agent-sdk" });
    const r = await runDev(p, { ANTHROPIC_API_KEY: "sk-ant" });
    expect(r.code).toBe(0);
    const calls = invocations(p).map((a) => a.join(" "));
    expect(calls).toContain("exec tsup");
    expect(calls).toContain("exec tsup --watch");
    expect(calls.some((c) => c.startsWith("exec guuey dev --serve"))).toBe(true);
    expect(calls.some((c) => c.startsWith("exec ggui serve"))).toBe(true);
    expect(calls.some((c) => c.startsWith("--filter") && c.endsWith(" dev"))).toBe(true);
  });

  it("the key in .env.local only: every service starts", async () => {
    const p = project({ framework: "google-adk", envLocal: 'GEMINI_API_KEY="g-key"\n' });
    const r = await runDev(p);
    expect(r.code).toBe(0);
    expect(invocations(p).some((a) => a.join(" ").startsWith("exec guuey dev --serve"))).toBe(true);
  });
});
