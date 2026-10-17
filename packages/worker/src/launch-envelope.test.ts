/**
 * guuey#2139: the private launch envelope, read by a
 * real child process on a real descriptor 5 (a socketpair from Node's stdio
 * `pipe`, a FIFO-less regular file, or nothing). Synthetic sentinels only; the
 * child reports booleans, and no report or error text carries payload bytes.
 */
import { spawn, type StdioOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable, type Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import {
  LAUNCH_ENVELOPE_FD_ENV,
  LAUNCH_ENVELOPE_MAX_BYTES,
  LaunchEnvelopeError,
  encodeLaunchEnvelope,
  parseLaunchEnvelope,
} from "./launch-envelope.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/read-envelope.mjs", import.meta.url));
const LINUX = process.platform === "linux";
const sentinel = (): string => `SENTINEL-2139-${randomBytes(12).toString("hex")}`;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

interface Report {
  ok: boolean;
  present?: boolean;
  hasModel?: boolean;
  matches?: boolean;
  markerLeft?: boolean;
  grandchildSeesEnvelope?: boolean;
  errorName?: string;
  errorMessage?: string;
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the fixture with `fd5` as its descriptor 5 and `write` driving the
 * parent's end (when fd 5 is a pipe). Resolves with the child's report and
 * everything it printed, so a test can count sentinels in the output.
 */
function runReader(opts: {
  fd5: "pipe" | "ignore" | number;
  marker?: string;
  env?: NodeJS.ProcessEnv;
  write?: (channel: Writable) => void;
}): Promise<{ report: Report; output: string }> {
  const stdio: StdioOptions = ["ignore", "pipe", "pipe", "ignore", "ignore", opts.fd5];
  const child = spawn(process.execPath, [FIXTURE], {
    stdio,
    env: {
      PATH: process.env.PATH ?? "",
      ...(opts.marker !== undefined ? { [LAUNCH_ENVELOPE_FD_ENV]: opts.marker } : {}),
      ...opts.env,
    },
  });
  const channels: ReadonlyArray<Writable | Readable | null | undefined> = child.stdio;
  const channel = channels[5];
  if (opts.fd5 === "pipe") {
    if (!(channel instanceof Writable)) throw new Error("fd 5 is not a writable pipe");
    channel.on("error", () => undefined);
    opts.write?.(channel);
  }
  let out = "";
  let err = "";
  child.stdout?.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr?.setEncoding("utf8").on("data", (d: string) => (err += d));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => {
      try {
        resolve({ report: JSON.parse(out) as Report, output: out + err });
      } catch {
        reject(new Error(`fixture printed no report (stderr: ${err.slice(0, 400)})`));
      }
    });
  });
}

describe("parseLaunchEnvelope / encodeLaunchEnvelope", () => {
  it("round-trips a model capability and refuses every malformed shape without echoing it", () => {
    const token = sentinel();
    const line = encodeLaunchEnvelope({ v: 1, model: { wire: "anthropic", token } }).toString("utf8");
    expect(parseLaunchEnvelope(line)).toEqual({ v: 1, model: { wire: "anthropic", token } });
    expect(parseLaunchEnvelope('{"v":1}\n')).toEqual({ v: 1 });
    const bad = [
      "",
      "\n",
      `{"v":1,"model":{"wire":"anthropic","token":"${token}"`,
      `{"v":2,"model":{"wire":"anthropic","token":"${token}"}}`,
      `{"v":1,"model":{"wire":"bedrock","token":"${token}"}}`,
      `{"v":1,"model":{"wire":"anthropic","token":"${token}","extra":1}}`,
      `{"v":1,"model":{"wire":"anthropic","token":"${token}"},"env":{}}`,
      `{"v":1,"model":{"wire":"anthropic","token":"${token} x"}}`,
      `{"v":1}\n{"v":1}\n`,
      "[]",
    ];
    for (const text of bad) {
      let caught: unknown;
      try {
        parseLaunchEnvelope(text);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(LaunchEnvelopeError);
      expect(caught instanceof Error && caught.message.includes(token)).toBe(false);
    }
  });
});

describe("readLaunchEnvelope in a real child (guuey#2139)", () => {
  it("reads the capability from fd 5, closes the descriptor, deletes the marker", async () => {
    const token = sentinel();
    const { report, output } = await runReader({
      fd5: "pipe",
      marker: "5",
      env: { EXPECT_SHA256: sha256(token) },
      write: (c) => c.end(encodeLaunchEnvelope({ v: 1, model: { wire: "openai", token } })),
    });
    expect(report).toMatchObject({ ok: true, present: true, hasModel: true, matches: true, markerLeft: false });
    expect(output.includes(token)).toBe(false);
  });

  it.skipIf(!LINUX)(
    "a child started after the read does not hold the envelope socket at fd 5 (Linux /proc; macOS has no procfs and closes inherited descriptors on spawn)",
    async () => {
      const token = sentinel();
      const { report } = await runReader({
        fd5: "pipe",
        marker: "5",
        env: { EXPECT_SHA256: sha256(token) },
        write: (c) => c.end(encodeLaunchEnvelope({ v: 1, model: { wire: "anthropic", token } })),
      });
      expect(report.ok).toBe(true);
      expect(report.grandchildSeesEnvelope).toBe(false);
    },
  );

  const refusals: Array<{ name: string; payload: (token: string) => string | Buffer; reason: RegExp }> = [
    { name: "an empty payload", payload: () => "", reason: /empty payload/ },
    { name: "a truncated payload", payload: (t) => `{"v":1,"model":{"wire":"anthropic","token":"${t}"`, reason: /not complete JSON/ },
    { name: "an unknown member", payload: (t) => `{"v":1,"model":{"wire":"anthropic","token":"${t}"},"x":1}\n`, reason: /unknown member/ },
    { name: "another version", payload: (t) => `{"v":2,"model":{"wire":"anthropic","token":"${t}"}}\n`, reason: /version/ },
    {
      name: "an oversized payload",
      payload: (t) => Buffer.concat([Buffer.from(`{"v":1,"model":{"wire":"anthropic","token":"${t}"}}`), Buffer.alloc(LAUNCH_ENVELOPE_MAX_BYTES, 0x20)]),
      reason: /size limit/,
    },
  ];
  for (const refusal of refusals) {
    it(`refuses ${refusal.name}, naming the reason without the payload`, async () => {
      const token = sentinel();
      const { report, output } = await runReader({
        fd5: "pipe",
        marker: "5",
        write: (c) => c.end(refusal.payload(token)),
      });
      expect(report.ok).toBe(false);
      expect(report.errorName).toBe("LaunchEnvelopeError");
      expect(report.errorMessage).toMatch(refusal.reason);
      expect(output.includes(token)).toBe(false);
    });
  }

  it("a launcher that writes but never ends fails the read at the deadline", async () => {
    const token = sentinel();
    const started = Date.now();
    let held: Writable | undefined;
    const { report, output } = await runReader({
      fd5: "pipe",
      marker: "5",
      env: { READ_DEADLINE_MS: "300" },
      write: (c) => {
        held = c;
        c.write(encodeLaunchEnvelope({ v: 1, model: { wire: "anthropic", token } }));
      },
    });
    held?.destroy();
    expect(report.ok).toBe(false);
    expect(report.errorMessage).toMatch(/no EOF within 300 ms/);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(output.includes(token)).toBe(false);
  });

  it("refuses a marker that names another descriptor", async () => {
    const { report } = await runReader({ fd5: "pipe", marker: "6", write: (c) => c.end() });
    expect(report.ok).toBe(false);
    expect(report.errorMessage).toMatch(/must name fd 5/);
  });

  it("refuses a regular file at fd 5", async () => {
    const dir = mkdtempSync(join(tmpdir(), "envelope-file-"));
    dirs.push(dir);
    const path = join(dir, "payload");
    writeFileSync(path, '{"v":1}\n');
    const fd = openSync(path, "r");
    try {
      const { report } = await runReader({ fd5: fd, marker: "5" });
      expect(report.ok).toBe(false);
      expect(report.errorMessage).toMatch(/not a socket or FIFO/);
    } finally {
      closeSync(fd);
    }
  });

  it("with the marker absent there is no envelope", async () => {
    const { report } = await runReader({ fd5: "ignore" });
    expect(report).toMatchObject({ ok: true, present: false });
  });
});
