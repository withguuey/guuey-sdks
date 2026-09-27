#!/usr/bin/env node
// pnpm dev — boots the whole local stack. Ctrl-C tears everything down.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devPreflight, isInteractiveTerminal } from "./lib/model-key.mjs";

// The model key is checked FIRST, before the first build and before any
// service starts: without it the agent would exit and take every other
// service down with it. At a terminal it is asked for (hidden) and saved to
// .env.local; otherwise (no terminal, or CI) the run stops here with the
// one-line fix.
const preflight = await devPreflight({
  root: join(dirname(fileURLToPath(import.meta.url)), ".."),
  interactive: isInteractiveTerminal(),
});
if (!preflight.proceed) {
  console.error(`✗ ${preflight.message}`);
  process.exit(1);
}

const procs = [];
function boot(name, command, args, opts = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  const prefix = `[${name}]`.padEnd(9);
  child.stdout.on("data", (d) => process.stdout.write(String(d).replace(/^/gm, prefix)));
  child.stderr.on("data", (d) => process.stderr.write(String(d).replace(/^/gm, prefix)));
  child.on("exit", (code) => {
    if (code !== 0 && !shuttingDown) shutdown(`${name} exited (${code})`, 1);
  });
  procs.push(child);
}
let shuttingDown = false;
function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${reason} — shutting down`);
  for (const p of procs) p.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown("interrupted"));
process.on("SIGTERM", () => shutdown("terminated"));

// FIRST-BOOT BARRIER (guuey#368): on a fresh scaffold the agent would race
// tsup's first build — no guuey.worker.js yet ⇒ @guuey/host boots
// snapshot-only and NEVER reloads into the worker, so the very first
// `pnpm dev` session silently ran without the worker's behavior. One
// blocking build before anything boots; the watcher takes over after.
if (!existsSync("guuey.worker.js")) {
  console.log("[worker] first build (guuey.worker.js missing)…");
  const first = spawnSync("pnpm", ["exec", "tsup"], { stdio: "inherit" });
  if (first.status !== 0) {
    console.error("[worker] first build failed — fix the error above and re-run PNPM_PLACEHOLDER dev");
    process.exit(first.status ?? 1);
  }
}
boot("worker", "pnpm", ["exec", "tsup", "--watch"]); // rebuilds guuey.worker.js on change
// `guuey dev` auto-spawns every `kind: 'colocated'` mcpServers entry itself
// (name→localhost devPort resolution) — the todo MCP is colocated, so it no
// longer needs its own boot() here; a manual second spawn would double-bind
// :6782 and crash with EADDRINUSE.
boot("agent", "pnpm", ["exec", "guuey", "dev", "--serve", "--port", "6790"]);
boot("ggui", "pnpm", ["exec", "ggui", "serve", "--mcp-only", "--dev-allow-all", "--port", "6781"], {
  cwd: "ggui",
});
boot("web", "pnpm", ["--filter", "@agentic-app-template/web", "dev"], {
  env: { ...process.env, PORT: "6890" },
});

console.log("\n  agent  http://localhost:6790   todo-mcp http://localhost:6782");
console.log("  ggui   http://localhost:6781   web      http://localhost:6890\n");
