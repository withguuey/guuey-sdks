/**
 * @guuey/fs — a tiny dev-guidance helper for the GuueyFS 3-layer contract every
 * hosted guuey agent runs inside. `homeDir()`/`appDir()`/`sessionDir()` just read
 * the env vars the Router already injects (`GUUEY_HOME_DIR`/`GUUEY_APP_DIR`) plus
 * `process.cwd()` — there is no wrapper API, no adapter, no storage abstraction.
 * Plain `node:fs` on the three paths IS the contract. See README.md and
 * docs/superpowers/specs/2026-07-20-guueyfs-slice4-design.md §6.
 */

export { ENV_HOME_DIR, ENV_APP_DIR, homeDir, appDir, sessionDir } from "./roots.js";
