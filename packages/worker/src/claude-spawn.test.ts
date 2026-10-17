/**
 * guuey#2139: the Claude CLI spawner. Refusals are
 * pinned with a recording spawn function (nothing launched); delivery and
 * redaction run a real child that stands in for the CLI. Synthetic sentinels
 * only; no assertion prints one.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_FORBIDDEN_ENV,
  CLAUDE_KEY_FD_ENV,
  ClaudeSpawnRefusedError,
  makeClaudeSpawner,
  redactSecrets,
  type ClaudeSpawnRequest,
} from "./claude-spawn.js";

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-claude-cli.mjs", import.meta.url));
const sentinel = (): string => `SENTINEL-2139-${randomBytes(12).toString("hex")}`;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function request(over: Partial<ClaudeSpawnRequest> = {}): ClaudeSpawnRequest {
  return { command: "/bin/false", args: ["--output-format", "stream-json"], env: { PATH: "/usr/bin" }, signal: new AbortController().signal, ...over };
}

/** A spawn function that records its call and never launches anything. */
type SpawnCall = { command: string; args: readonly string[]; options: SpawnOptions };
function recordingSpawn(): { calls: SpawnCall[]; fn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess } {
  const calls: SpawnCall[] = [];
  const fn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    calls.push({ command, args, options });
    throw new Error("recording spawn: nothing is launched");
  };
  return { calls, fn };
}

function refusal(run: () => unknown): ClaudeSpawnRefusedError | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ClaudeSpawnRefusedError) return error;
    throw error;
  }
  return undefined;
}

describe("makeClaudeSpawner refusals", () => {
  for (const name of CLAUDE_FORBIDDEN_ENV) {
    it(`refuses an environment naming ${name}, before any spawn`, () => {
      const rec = recordingSpawn();
      const spawner = makeClaudeSpawner({ key: sentinel(), spawnFn: rec.fn });
      const error = refusal(() => spawner(request({ env: { PATH: "/usr/bin", [name]: "1" } })));
      expect(error?.message).toContain(name);
      expect(rec.calls).toHaveLength(0);
    });
  }

  it("refuses an environment value carrying the key or a registered MCP header value, naming only the variable", () => {
    const key = sentinel();
    const header = sentinel();
    const rec = recordingSpawn();
    const spawner = makeClaudeSpawner({ key, secrets: [header], spawnFn: rec.fn });
    for (const value of [key, `prefix-${header}`]) {
      const error = refusal(() => spawner(request({ env: { PATH: "/usr/bin", SOME_VAR: value } })));
      expect(error?.message).toContain("SOME_VAR");
      expect(error?.message.includes(key) || error?.message.includes(header)).toBe(false);
    }
    expect(rec.calls).toHaveLength(0);
  });

  it("refuses an argument carrying an MCP header value, and arguments that already carry --mcp-config", () => {
    const key = sentinel();
    const header = sentinel();
    const rec = recordingSpawn();
    const spawner = makeClaudeSpawner({ key, secrets: [header], spawnFn: rec.fn });
    expect(refusal(() => spawner(request({ args: ["--x", JSON.stringify({ authorization: `Bearer ${header}` })] })))?.message).toContain(
      "an argument contains a secret",
    );
    expect(refusal(() => spawner(request({ args: ["--mcp-config", "{}"] })))?.message).toContain("--mcp-config");
    expect(refusal(() => spawner(request({ args: ["--mcp-config=/tmp/x.json"] })))?.message).toContain("--mcp-config");
    expect(rec.calls).toHaveLength(0);
  });

  it("spawns with plain pipes only (no 'ipc'), the key descriptor variable, and no key in argv or env", () => {
    const key = sentinel();
    const rec = recordingSpawn();
    const spawner = makeClaudeSpawner({ key, spawnFn: rec.fn });
    expect(() => spawner(request())).toThrow("recording spawn");
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0];
    expect(call?.options.stdio).toEqual(["pipe", "pipe", "pipe", "pipe"]);
    expect(JSON.stringify(call?.options.stdio)).not.toContain("ipc");
    expect(call?.options.env?.[CLAUDE_KEY_FD_ENV]).toBe("3");
    expect(Object.values(call?.options.env ?? {}).some((v) => v?.includes(key))).toBe(false);
    expect(call?.args.some((a) => a.includes(key))).toBe(false);
  });

  it("refuses a key that would not survive the newline-framed descriptor read", () => {
    expect(() => makeClaudeSpawner({ key: "" })).toThrow(ClaudeSpawnRefusedError);
    expect(() => makeClaudeSpawner({ key: "a\nb" })).toThrow(ClaudeSpawnRefusedError);
  });
});

describe("makeClaudeSpawner delivery (real child)", () => {
  async function runFake(echo: boolean): Promise<{ report: Record<string, boolean>; sink: string[]; key: string }> {
    const key = sentinel();
    const sink: string[] = [];
    const spawner = makeClaudeSpawner({ key, stderr: (line) => sink.push(line) });
    const child = spawner(
      request({
        command: process.execPath,
        args: [FAKE_CLI],
        env: { PATH: process.env.PATH ?? "", EXPECT_SHA256: sha256(key), ...(echo ? { ECHO_KEY_TO_STDERR: "1" } : {}) },
      }),
    );
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    return { report: JSON.parse(out) as Record<string, boolean>, sink, key };
  }

  it("hands the key over on a socket descriptor; the child's environment does not carry it; no IPC channel", async () => {
    const { report } = await runFake(false);
    expect(report).toEqual({ keyFdIsSocket: true, keyMatches: true, envCarriesKey: false, hasIpc: false });
  });

  it("redacts the key from every stderr line before the sink sees it", async () => {
    const { sink, key } = await runFake(true);
    expect(sink.some((line) => line.includes("[redacted]"))).toBe(true);
    expect(sink.some((line) => line.includes(key))).toBe(false);
  });

  it("redactSecrets replaces every occurrence of every secret", () => {
    expect(redactSecrets("a S1 b S2 c S1", ["S1", "S2"])).toBe("a [redacted] b [redacted] c [redacted]");
  });
});
