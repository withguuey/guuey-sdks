// The forwarder's smoke: `guuey --help` through the shim exits 0 and prints
// the real CLI's help (proves resolution + spawn + argv forwarding).
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const bin = join(dirname(fileURLToPath(import.meta.url)), "bin.js");
execFile(process.execPath, [bin, "--help"], { timeout: 30_000 }, (err, stdout, stderr) => {
  if (err) {
    console.error("forwarder smoke FAILED:", err.message, stderr.slice(0, 300));
    process.exit(1);
  }
  if (!/guuey|Usage/i.test(stdout + stderr)) {
    console.error("forwarder smoke FAILED: help output unrecognizable");
    process.exit(1);
  }
  console.log("forwarder smoke ok");
});
