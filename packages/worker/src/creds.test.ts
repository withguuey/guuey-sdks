import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { listCredentials, MCP_SERVERS_FILE_ENV, type McpServersFile } from "./creds.js";
import type { Fs } from "./protocol.js";

// The FIFO case spawns a shell writer; vitest's 5 s default is too tight on a 2-vCPU runner.
vi.setConfig({ testTimeout: 30_000 });

let root: string;

function fsFor(session: string): Fs {
  return { app: join(root, "app"), home: join(root, "home"), session };
}

/** Create `<session>/.guuey/credentials` and write `files` into it verbatim. */
function credDir(files: Record<string, string>): Fs {
  const session = mkdtempSync(join(root, "session-"));
  const dir = join(session, ".guuey", "credentials");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, "utf8");
  return fsFor(session);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "guuey-creds-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("listCredentials", () => {
  it("returns [] when the credential directory does not exist (no MCP this turn)", () => {
    const session = mkdtempSync(join(root, "session-"));
    expect(listCredentials(fsFor(session), {})()).toEqual([]);
  });

  it("reads one entry per valid .json file, keyed by filename stem", () => {
    const fs = credDir({
      "ggui.json": JSON.stringify({
        url: "https://mcp.ggui.ai/apps/app_123",
        transport: "http",
        headers: { authorization: "Bearer tok-ggui" },
      }),
      "guuey-memory.json": JSON.stringify({
        url: "http://127.0.0.1:9111/mcp",
        transport: "sse",
        headers: {},
        expiresAt: "2026-07-29T00:00:00.000Z",
      }),
    });
    const got = listCredentials(fs, {})().sort((a, b) => a.name.localeCompare(b.name));
    expect(got).toEqual([
      {
        name: "ggui",
        cred: {
          url: "https://mcp.ggui.ai/apps/app_123",
          transport: "http",
          headers: { authorization: "Bearer tok-ggui" },
        },
      },
      {
        name: "guuey-memory",
        cred: {
          url: "http://127.0.0.1:9111/mcp",
          transport: "sse",
          headers: {},
          expiresAt: "2026-07-29T00:00:00.000Z",
        },
      },
    ]);
  });

  it("ignores non-.json files", () => {
    const fs = credDir({
      "ggui.json": JSON.stringify({ url: "https://a", transport: "http", headers: {} }),
      "README.txt": "not a credential",
      ".keep": "",
    });
    expect(listCredentials(fs, {})().map((c) => c.name)).toEqual(["ggui"]);
  });

  it("skips malformed files without crashing the turn", () => {
    const fs = credDir({
      "good.json": JSON.stringify({ url: "https://a", transport: "http", headers: {} }),
      "not-json.json": "{ this is not json",
      "array.json": JSON.stringify([{ url: "https://b", transport: "http", headers: {} }]),
      "null.json": "null",
      "no-url.json": JSON.stringify({ transport: "http", headers: {} }),
      "bad-transport.json": JSON.stringify({ url: "https://c", transport: "grpc", headers: {} }),
    });
    expect(listCredentials(fs, {})().map((c) => c.name)).toEqual(["good"]);
  });

  it("is a thunk — each call re-reads the directory (per-invoke broker writes)", () => {
    const session = mkdtempSync(join(root, "session-"));
    const dir = join(session, ".guuey", "credentials");
    const read = listCredentials(fsFor(session), {});
    expect(read()).toEqual([]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ggui.json"),
      JSON.stringify({ url: "https://a", transport: "http", headers: {} }),
      "utf8"
    );
    expect(read().map((c) => c.name)).toEqual(["ggui"]);
  });
});

const GOOD = { url: "https://relay.example/_executor/mcp/abc", transport: "http", headers: { authorization: "Bearer cap" } } as const;

/** Write a servers file outside the session tree and return its path. */
function serversFile(content: string): string {
  const dir = mkdtempSync(join(root, "control-"));
  const path = join(dir, "mcp-servers.json");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("listCredentials: the servers file", () => {
  it("reads every entry of the file the platform names, keyed by the entry's name (names a file name could not carry)", () => {
    const file: McpServersFile = {
      version: 1,
      servers: [
        { name: "myMcp", credential: { ...GOOD } },
        { name: "Linear Tools", credential: { url: "https://b", transport: "sse", headers: {}, expiresAt: "2026-01-01T00:00:00.000Z" } },
      ],
    };
    const session = mkdtempSync(join(root, "session-"));
    const got = listCredentials(fsFor(session), { [MCP_SERVERS_FILE_ENV]: serversFile(JSON.stringify(file)) })();
    expect(got).toEqual([
      { name: "myMcp", cred: { ...GOOD } },
      { name: "Linear Tools", cred: { url: "https://b", transport: "sse", headers: {}, expiresAt: "2026-01-01T00:00:00.000Z" } },
    ]);
  });

  it("never reads the session directory while the variable is set: an entry planted there by an earlier turn is not picked up", () => {
    const planted = credDir({ "planted.json": JSON.stringify({ url: "https://attacker", transport: "http", headers: {} }) });
    const file: McpServersFile = { version: 1, servers: [{ name: "ggui", credential: { ...GOOD } }] };
    expect(listCredentials(planted, { [MCP_SERVERS_FILE_ENV]: serversFile(JSON.stringify(file)) })().map((c) => c.name)).toEqual(["ggui"]);
  });

  it("an EMPTY value is the platform's no-servers answer: nothing is read, the planted session directory included", () => {
    const planted = credDir({ "planted.json": JSON.stringify({ url: "https://attacker", transport: "http", headers: {} }) });
    expect(listCredentials(planted, { [MCP_SERVERS_FILE_ENV]: "" })()).toEqual([]);
  });

  it("a missing file is no servers, never a fall back to the session directory", () => {
    const planted = credDir({ "planted.json": JSON.stringify({ url: "https://attacker", transport: "http", headers: {} }) });
    expect(listCredentials(planted, { [MCP_SERVERS_FILE_ENV]: join(root, "absent", "mcp-servers.json") })()).toEqual([]);
  });

  it("a relative path is no servers (it resolves against the working directory, the session tree on a pod)", () => {
    const session = mkdtempSync(join(root, "session-"));
    const plantedFile = join(session, "planted-servers.json");
    writeFileSync(plantedFile, JSON.stringify({ version: 1, servers: [{ name: "planted", credential: { url: "https://attacker", transport: "http", headers: {} } }] }), "utf8");
    // Relative to this process's working directory, the path names the planted file exactly.
    expect(listCredentials(fsFor(session), { [MCP_SERVERS_FILE_ENV]: relative(process.cwd(), plantedFile) })()).toEqual([]);
  });

  it("skips malformed and repeated entries, ignores unknown keys, and treats a malformed file as no servers", () => {
    const session = mkdtempSync(join(root, "session-"));
    const read = (content: string) => listCredentials(fsFor(session), { [MCP_SERVERS_FILE_ENV]: serversFile(content) })();
    const mixed = JSON.stringify({
      version: 2,
      later: "field",
      servers: [
        { name: "good", credential: { ...GOOD, later: true }, extra: 1 },
        { name: "good", credential: { url: "https://second", transport: "http", headers: {} } },
        { name: "", credential: { ...GOOD } },
        { name: 7, credential: { ...GOOD } },
        { name: "no-url", credential: { transport: "http", headers: {} } },
        { name: "bad-transport", credential: { url: "https://c", transport: "grpc", headers: {} } },
        ["not", "an", "entry"],
        null,
      ],
    });
    expect(read(mixed).map((c) => [c.name, c.cred.url])).toEqual([["good", GOOD.url]]);
    expect(read("{ not json")).toEqual([]);
    expect(read("null")).toEqual([]);
    expect(read(JSON.stringify([{ name: "a", credential: GOOD }]))).toEqual([]);
    expect(read(JSON.stringify({ version: 1, servers: { a: GOOD } }))).toEqual([]);
  });

  it("reads the variable on every call (the env is read per invoke, like the directory)", () => {
    const session = mkdtempSync(join(root, "session-"));
    const env: Record<string, string | undefined> = {};
    const read = listCredentials(fsFor(session), env);
    expect(read()).toEqual([]);
    env[MCP_SERVERS_FILE_ENV] = serversFile(JSON.stringify({ version: 1, servers: [{ name: "ggui", credential: GOOD }] }));
    expect(read().map((c) => c.name)).toEqual(["ggui"]);
  });

  it("defaults to process.env", () => {
    const session = mkdtempSync(join(root, "session-"));
    const path = serversFile(JSON.stringify({ version: 1, servers: [{ name: "ggui", credential: GOOD }] }));
    const before = process.env[MCP_SERVERS_FILE_ENV];
    process.env[MCP_SERVERS_FILE_ENV] = path;
    try {
      expect(listCredentials(fsFor(session))().map((c) => c.name)).toEqual(["ggui"]);
    } finally {
      if (before === undefined) delete process.env[MCP_SERVERS_FILE_ENV];
      else process.env[MCP_SERVERS_FILE_ENV] = before;
    }
  });
});

/** mkfifo exists on every macOS and Linux host; only a host without it (Windows) skips. */
const hasMkfifo = process.platform !== "win32" && spawnSync("sh", ["-c", "command -v mkfifo"]).status === 0;

describe("listCredentials: a servers file that is a descriptor (a pipe, read once)", () => {
  it.skipIf(!hasMkfifo)(
    "reads a non-seekable servers file (a FIFO written once) in a single read",
    () => {
      const fifo = join(mkdtempSync(join(root, "control-")), "mcp-servers.json");
      execFileSync("mkfifo", [fifo]);
      const payload = JSON.stringify({ version: 1, servers: [{ name: "ggui", credential: GOOD }] });
      // The writer writes the payload once and closes. Two seconds later it opens
      // the FIFO again and closes it with nothing written: a second read of the
      // drained FIFO, which would otherwise block this thread for good, then gets
      // an empty file, so a second read fails the assertion instead of hanging.
      // A single read finishes long before that; the writer is killed below.
      const writer = spawn("sh", ["-c", 'printf "%s" "$1" > "$0"; sleep 2; : > "$0"', fifo, payload], {
        stdio: "ignore",
      });
      try {
        const session = mkdtempSync(join(root, "session-"));
        const got = listCredentials(fsFor(session), { [MCP_SERVERS_FILE_ENV]: fifo })();
        expect(got).toEqual([{ name: "ggui", cred: { ...GOOD } }]);
      } finally {
        writer.kill("SIGKILL");
      }
    },
    10_000
  );

  it("reads the servers file with one readFileSync and never stats, opens or seeks it", () => {
    const source = readFileSync(new URL("./creds.ts", import.meta.url), "utf8");
    // The only node:fs functions the module takes: no stat, open, read-at-offset or exists.
    const fsImport = /import \{([^}]*)\} from "node:fs";/.exec(source);
    expect(fsImport?.[1].split(",").map((n) => n.trim()).filter((n) => n !== "").sort()).toEqual(["readFileSync", "readdirSync"]);
    expect(source).not.toMatch(/\b(?:f|l)?statSync\b|\bopenSync\b|\breadSync\b|\bexistsSync\b|\baccessSync\b/);
    // readServersFile reads its path exactly once.
    const body = /function readServersFile\([\s\S]*?\n\}\n/.exec(source)?.[0] ?? "";
    expect(body).not.toBe("");
    expect(body.match(/readFileSync\(/g)).toHaveLength(1);
  });
});
