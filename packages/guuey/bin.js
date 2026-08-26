#!/usr/bin/env node
/**
 * The bare-name forwarder (guuey#449): the real CLI is `@guuey/cli`. This
 * package exists so `npx guuey <command>` resolves OUR code from the
 * registry everywhere — inside a scaffold it was already the pinned local
 * bin; outside one it used to 404 (safe but dead), and an unclaimed bare
 * name was a squat waiting to aim at the funnel's most-typed command.
 *
 * Forwarding is by spawn, not import: `@guuey/cli` ships its entry as a
 * bin (`dist/cli.js`), not an export — resolving it through the package
 * manifest keeps this shim zero-maintenance across CLI releases (the
 * caret dependency tracks minors; the bin path is read at run time).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
// The CLI's exports map doesn't expose ./package.json — resolve the main
// entry and walk UP to the package root instead (stops at the first
// manifest whose name matches, so a hoisted layout resolves correctly).
let dir = dirname(require.resolve("@guuey/cli"));
let manifestPath = "";
for (let i = 0; i < 10; i++) {
  const candidate = join(dir, "package.json");
  if (existsSync(candidate)) {
    const parsed = JSON.parse(readFileSync(candidate, "utf8"));
    if (parsed.name === "@guuey/cli") {
      manifestPath = candidate;
      break;
    }
  }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
if (manifestPath === "") {
  console.error("guuey: could not locate @guuey/cli — reinstall or report this.");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const binRel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.guuey;
if (typeof binRel !== "string") {
  console.error("guuey: @guuey/cli declares no bin — reinstall or report this.");
  process.exit(1);
}
const child = spawn(
  process.execPath,
  [join(dirname(manifestPath), binRel), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
