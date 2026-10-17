// guuey#2139 test fixture: read the launch envelope the way a worker does and
// report booleans only (never a payload byte). Loaded with Node's type
// stripping straight from the source module.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import { readLaunchEnvelope } from "../launch-envelope.ts";

const linux = process.platform === "linux";
const before = linux && existsSync("/proc/self/fd/5") ? readlinkSync("/proc/self/fd/5") : undefined;
const report = {};
try {
  const deadlineMs = process.env.READ_DEADLINE_MS ? Number(process.env.READ_DEADLINE_MS) : undefined;
  const envelope = await readLaunchEnvelope(deadlineMs !== undefined ? { deadlineMs } : {});
  report.ok = true;
  report.present = envelope !== undefined;
  report.hasModel = envelope?.model !== undefined;
  report.matches =
    envelope?.model !== undefined &&
    createHash("sha256").update(envelope.model.token).digest("hex") === process.env.EXPECT_SHA256;
  report.markerLeft = "GUUEY_LAUNCH_ENVELOPE_FD" in process.env;
  if (linux && before !== undefined) {
    // A child started now must not see the envelope socket at fd 5.
    const seen = execFileSync(process.execPath, ["-e", "const fs=require('fs');process.stdout.write(fs.existsSync('/proc/self/fd/5')?fs.readlinkSync('/proc/self/fd/5'):'')"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    report.grandchildSeesEnvelope = seen === before;
  }
} catch (error) {
  report.ok = false;
  report.errorName = error instanceof Error ? error.name : "unknown";
  report.errorMessage = error instanceof Error ? error.message : String(error);
}
process.stdout.write(JSON.stringify(report));
