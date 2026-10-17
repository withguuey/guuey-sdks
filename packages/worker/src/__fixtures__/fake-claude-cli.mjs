// guuey#2139 test fixture: stands in for the Claude CLI. Reads its credential
// from the descriptor named by CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR (or
// CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR) to the newline, the way the pinned
// CLI's socket branch does, then reports booleans on stdout. When asked, it
// echoes the key on stderr, or echoes the first line of its stdin on stderr
// (the redaction tests' inputs: a value it was handed privately, never on
// argv or in env).
import { createHash } from "node:crypto";
import { closeSync, fstatSync, readSync } from "node:fs";

const keyVar = process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR !== undefined
  ? "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR"
  : "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR";
const fd = Number(process.env[keyVar]);
const isSocket = fstatSync(fd).isSocket();

function readLine(from) {
  const chunks = [];
  const buf = Buffer.alloc(256);
  for (;;) {
    const n = readSync(from, buf, 0, buf.length, null);
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    if (buf.subarray(0, n).includes(10)) break;
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

const key = readLine(fd);
closeSync(fd);
if (process.env.ECHO_KEY_TO_STDERR === "1") process.stderr.write(`debug: using key ${key}\n`);
if (process.env.ECHO_STDIN_TO_STDERR === "1") process.stderr.write(`error: upstream refused credential ${readLine(0)}\n`);
const values = Object.values(process.env);
process.stdout.write(
  JSON.stringify({
    keyVar,
    keyFdIsSocket: isSocket,
    keyMatches: createHash("sha256").update(key).digest("hex") === process.env.EXPECT_SHA256,
    envCarriesKey: values.some((v) => typeof v === "string" && v.includes(key)),
    hasIpc: typeof process.send === "function",
  }),
);
