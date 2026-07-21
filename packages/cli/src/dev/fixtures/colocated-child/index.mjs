// `colocated-dev.test.ts` fixture — a minimal "colocated MCP dev server"
// stand-in. Writes a `started` marker (containing the PORT env it was
// given) so the test can assert `spawnColocatedDev` set PORT correctly,
// then writes a `stopped` marker on SIGTERM so the test can assert
// `stop()` actually terminates the child.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const markerDir = process.env.FIXTURE_MARKER_DIR;

if (markerDir) {
  writeFileSync(join(markerDir, "started"), `PORT=${process.env.PORT ?? ""}`);
}

process.on("SIGTERM", () => {
  if (markerDir) writeFileSync(join(markerDir, "stopped"), "1");
  process.exit(0);
});

// Keep the process alive until SIGTERM (mirrors a real dev server listening).
setInterval(() => {}, 1000);
