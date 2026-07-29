import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCredentials } from "./creds.js";
import type { Fs } from "./protocol.js";

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
    expect(listCredentials(fsFor(session))()).toEqual([]);
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
    const got = listCredentials(fs)().sort((a, b) => a.name.localeCompare(b.name));
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
    expect(listCredentials(fs)().map((c) => c.name)).toEqual(["ggui"]);
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
    expect(listCredentials(fs)().map((c) => c.name)).toEqual(["good"]);
  });

  it("is a thunk — each call re-reads the directory (per-invoke broker writes)", () => {
    const session = mkdtempSync(join(root, "session-"));
    const dir = join(session, ".guuey", "credentials");
    const read = listCredentials(fsFor(session));
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
