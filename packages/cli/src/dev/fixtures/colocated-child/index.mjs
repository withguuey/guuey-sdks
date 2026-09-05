// `colocated-dev.test.ts` fixture — a minimal "colocated MCP dev server"
// stand-in. Writes a `started` marker (containing the PORT env it was
// given) so the test can assert `spawnColocatedDev` set PORT correctly,
// LISTENS on that PORT (so `settled` has a real TCP door to probe — the
// same signal the pod supervisor readies a child on), then writes a
// `stopped` marker on SIGTERM so the test can assert `stop()` actually
// terminates the child.
//
// Knobs (env, all optional):
//   FIXTURE_NO_LISTEN=1        never bind — exercises the readiness deadline
//   FIXTURE_CRASH_AFTER_MS=N   exit(1) N ms after listening — exercises
//                              post-ready degradation
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const markerDir = process.env.FIXTURE_MARKER_DIR;

// The SIGTERM handler is installed BEFORE the `started` marker is written
// (guuey#838): a test that calls `stop()` the moment it sees `started` sends
// SIGTERM to this process group at once, and with the handler still
// uninstalled the default disposition kills node without ever writing
// `stopped` — the wait for that marker then runs to its deadline (11/12
// under load, run 9: test 60 s + hook 60 s). With the handler first, a
// `started` marker is a promise this process can honor a stop.
process.on("SIGTERM", () => {
  if (markerDir) writeFileSync(join(markerDir, "stopped"), "1");
  process.exit(0);
});

if (markerDir) {
  writeFileSync(join(markerDir, "started"), `PORT=${process.env.PORT ?? ""}`);
}

if (process.env.FIXTURE_NO_LISTEN === "1") {
  // Keep the process alive without ever listening.
  setInterval(() => {}, 1000);
} else {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("colocated-child-fixture");
  });
  server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
    const crashAfter = Number(process.env.FIXTURE_CRASH_AFTER_MS);
    if (Number.isInteger(crashAfter) && crashAfter > 0) {
      setTimeout(() => process.exit(1), crashAfter);
    }
  });
}
