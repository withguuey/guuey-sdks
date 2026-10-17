// guuey#2139 test fixture: run by the real Claude CLI's Bash tool. Reports, as
// booleans and counts only (never values), what this tool child and its
// ancestors hold. Every synthetic secret in these tests starts with
// SENTINEL-2139-, so no sentinel value is passed in or written out.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";

const PREFIX = "SENTINEL-2139-";
const reportPath = process.argv[2];
const linux = process.platform === "linux";

function parentOf(pid) {
  if (linux) {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(after[1]);
  }
  return Number(execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
}

function argvOf(pid) {
  if (linux) return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
  return execFileSync("/bin/ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8" });
}

const ancestors = [];
let pid = process.ppid;
for (let depth = 0; depth < 8 && pid > 1; depth++) {
  const argv = argvOf(pid);
  ancestors.push({ pid, argv });
  if (/claude-agent-sdk[^ ]*\/claude( |$)/.test(argv)) break;
  pid = parentOf(pid);
}
const cli = ancestors.find((a) => /claude-agent-sdk[^ ]*\/claude( |$)/.test(a.argv));

const envValues = Object.values(process.env).filter((v) => typeof v === "string");
const report = {
  childSentinelCount: envValues.filter((v) => v.includes(PREFIX)).length,
  childHasAnthropicCredentialName: "ANTHROPIC_AUTH_TOKEN" in process.env || "ANTHROPIC_API_KEY" in process.env,
  childHasKeyFdName: "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR" in process.env,
  cliFound: cli !== undefined,
  cliArgvSentinelCount: cli ? cli.argv.split(PREFIX).length - 1 : -1,
  ancestorArgvSentinelCount: ancestors.reduce((n, a) => n + a.argv.split(PREFIX).length - 1, 0),
  linux,
};
if (linux && cli) {
  report.cliInitialEnvSentinelCount = readFileSync(`/proc/${cli.pid}/environ`, "utf8").split(PREFIX).length - 1;
  const fd3 = `/proc/${cli.pid}/fd/3`;
  report.cliFd3IsRegularFile = existsSync(fd3) && readlinkSync(fd3).startsWith("/");
  report.childInitialEnvSentinelCount = readFileSync("/proc/self/environ", "utf8").split(PREFIX).length - 1;
}
writeFileSync(reportPath, JSON.stringify(report));
