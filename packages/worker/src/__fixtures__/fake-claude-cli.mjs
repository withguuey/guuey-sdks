// guuey#2139 test fixture: stands in for the Claude CLI. Reads its key from the
// descriptor named by CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR to the newline, the
// way the pinned CLI's socket branch does, then reports booleans on stdout and,
// when asked, echoes the key on stderr (the redaction test's input).
import { createHash } from "node:crypto";
import { closeSync, fstatSync, readSync } from "node:fs";

const fd = Number(process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR);
const isSocket = fstatSync(fd).isSocket();
const chunks = [];
const buf = Buffer.alloc(256);
for (;;) {
  const n = readSync(fd, buf, 0, buf.length, null);
  if (n === 0) break;
  chunks.push(Buffer.from(buf.subarray(0, n)));
  if (buf.subarray(0, n).includes(10)) break;
}
closeSync(fd);
const key = Buffer.concat(chunks).toString("utf8").trim();
if (process.env.ECHO_KEY_TO_STDERR === "1") process.stderr.write(`debug: using key ${key}\n`);
const values = Object.values(process.env);
process.stdout.write(
  JSON.stringify({
    keyFdIsSocket: isSocket,
    keyMatches: createHash("sha256").update(key).digest("hex") === process.env.EXPECT_SHA256,
    envCarriesKey: values.some((v) => typeof v === "string" && v.includes(key)),
    hasIpc: typeof process.send === "function",
  }),
);
