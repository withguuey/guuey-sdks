/**
 * The golden corpus for the Python host's credentials reader (`../python/guuey_host/creds.py`, guuey#3494).
 *
 * Each case describes a small tree: what `GUUEY_MCP_SERVERS_FILE` names (or that it is unset or empty), the
 * session's `.guuey/credentials` folder, and any other environment variables. This file lays the tree out in a
 * temp directory, runs the real `@guuey/worker` `listCredentials` over it, and records the case together with
 * what the JavaScript reader returned. The Python tests (`../python/tests/test_creds.py`) rebuild the same tree
 * from the recorded case and must return exactly the same entries, in the same order.
 *
 * The reader never throws: every case's answer is a list of entries, empty when there is nothing to read.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { listCredentials, MCP_SERVERS_FILE_ENV, type CredentialFile } from "@guuey/worker";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** File content: UTF-8 text, or raw bytes (base64) for content that is not valid UTF-8. */
type Content = { kind: "text"; text: string } | { kind: "bytes"; base64: string };
/** One thing placed at a path. A symlink points at a fresh file outside the tree holding `target`. */
type TreeNode = Content | { kind: "directory" } | { kind: "symlink"; target: Content } | { kind: "dangling-symlink" };

/** What the servers-file variable holds. */
type ServersFileEnv =
  | { kind: "unset" }
  | { kind: "empty" }
  /** An absolute path to `<root>/control/mcp-servers.json`, holding `node`. */
  | { kind: "file"; node: TreeNode }
  /** The same path with a trailing `/`. */
  | { kind: "file-trailing-slash"; node: TreeNode }
  /** An absolute path to a file that does not exist. */
  | { kind: "missing" }
  /** A relative path, from the process's working directory, that names `<session>/planted-servers.json`. */
  | { kind: "relative-to-session-file"; content: Content }
  /** This exact value. */
  | { kind: "literal"; value: string };

/** The session's `.guuey/credentials`: absent, a regular file, or a folder holding `entries` by file name. */
type SessionCredentials =
  | { kind: "absent" }
  | { kind: "not-a-directory" }
  | { kind: "folder"; entries: { [fileName: string]: TreeNode } };

interface CaseInput {
  name: string;
  serversFile: ServersFileEnv;
  session: SessionCredentials;
  /** Other environment variables, never the servers-file variable itself. */
  env: { [name: string]: string };
}

interface GoldenCase extends CaseInput {
  expected: Array<{ name: string; cred: CredentialFile }>;
}

const text = (value: string): Content => ({ kind: "text", text: value });
const json = (value: Json): Content => text(JSON.stringify(value));
/** Raw bytes: strings are UTF-8, number arrays are literal bytes. */
const bytes = (...parts: Array<string | number[]>): Content => ({
  kind: "bytes",
  base64: Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf8") : Buffer.from(p)))).toString("base64"),
});

const GOOD: { [key: string]: Json } = { url: "https://relay.example/_executor/mcp/abc", transport: "http", headers: { authorization: "Bearer cap" } };
const SECOND: Json = { url: "https://b.example/mcp", transport: "sse", headers: {}, expiresAt: "2026-01-01T00:00:00.000Z" };
const ATTACKER: Json = { url: "https://attacker.example/mcp", transport: "http", headers: { authorization: "Bearer planted" } };
const servers = (...entries: Json[]): Content => json({ version: 1, servers: entries });
const file = (node: TreeNode): ServersFileEnv => ({ kind: "file", node });

/** A session folder an earlier turn planted: it must never be read while the servers-file variable is set. */
const PLANTED: SessionCredentials = { kind: "folder", entries: { "planted.json": json(ATTACKER) } };
/** Values in the variables the retired legacy env lane read, and MCP-named variables found elsewhere in the tree. */
const LEGACY_ENV: { [name: string]: string } = {
  ANTHROPIC_AUTH_TOKEN: "env-legacy-anthropic-token",
  OPENAI_API_KEY: "env-legacy-openai-key",
  GUUEY_BUILDER_KEY_LANE: "legacy-env",
  GUUEY_MCP_URL: "https://env-legacy.example/mcp",
};

const SERVERS_FILE_CASES: CaseInput[] = [
  { name: "two valid entries, keyed by the entry's name", serversFile: file(servers({ name: "myMcp", credential: GOOD }, { name: "Linear Tools", credential: SECOND })), session: { kind: "absent" }, env: {} },
  { name: "the planted session folder is never read while the variable is set", serversFile: file(servers({ name: "ggui", credential: GOOD })), session: PLANTED, env: {} },
  { name: "an empty value is no servers, the planted folder included", serversFile: { kind: "empty" }, session: PLANTED, env: {} },
  { name: "a missing file is no servers, never the session folder", serversFile: { kind: "missing" }, session: PLANTED, env: {} },
  { name: "a relative path naming a planted file is no servers", serversFile: { kind: "relative-to-session-file", content: servers({ name: "planted", credential: ATTACKER }) }, session: PLANTED, env: {} },
  { name: "a bare file name is no servers", serversFile: { kind: "literal", value: "mcp-servers.json" }, session: PLANTED, env: {} },
  { name: "a dot-relative path is no servers", serversFile: { kind: "literal", value: "./mcp-servers.json" }, session: PLANTED, env: {} },
  { name: "a path that is a directory is no servers", serversFile: file({ kind: "directory" }), session: PLANTED, env: {} },
  { name: "a path with a trailing slash is no servers", serversFile: { kind: "file-trailing-slash", node: servers({ name: "ggui", credential: GOOD }) }, session: PLANTED, env: {} },
  { name: "a symlink to a valid file is followed", serversFile: file({ kind: "symlink", target: servers({ name: "ggui", credential: GOOD }) }), session: PLANTED, env: {} },
  { name: "a dangling symlink is no servers", serversFile: file({ kind: "dangling-symlink" }), session: PLANTED, env: {} },
  { name: "an empty file is no servers", serversFile: file(text("")), session: PLANTED, env: {} },
  { name: "a whitespace-only file is no servers", serversFile: file(text(" \n\t\r ")), session: PLANTED, env: {} },
  { name: "not JSON is no servers", serversFile: file(text("{ not json")), session: PLANTED, env: {} },
  { name: "JSON null is no servers", serversFile: file(text("null")), session: PLANTED, env: {} },
  { name: "a top-level array is no servers", serversFile: file(json([{ name: "a", credential: GOOD }])), session: PLANTED, env: {} },
  { name: "a top-level string is no servers", serversFile: file(json("servers")), session: PLANTED, env: {} },
  { name: "servers missing is no servers", serversFile: file(json({ version: 1 })), session: PLANTED, env: {} },
  { name: "servers as an object is no servers", serversFile: file(json({ version: 1, servers: { a: GOOD } })), session: PLANTED, env: {} },
  { name: "servers null is no servers", serversFile: file(json({ version: 1, servers: null })), session: PLANTED, env: {} },
  { name: "an empty servers list is no servers", serversFile: file(servers()), session: PLANTED, env: {} },
  {
    name: "malformed and repeated entries are skipped, unknown keys kept verbatim, version not checked",
    serversFile: file(
      json({
        version: 2,
        later: "field",
        servers: [
          { name: "good", credential: { ...GOOD, later: true }, extra: 1 },
          { name: "good", credential: { url: "https://second.example", transport: "http", headers: {} } },
          { name: "", credential: GOOD },
          { name: 7, credential: GOOD },
          { name: null, credential: GOOD },
          { credential: GOOD },
          { name: "no-credential" },
          { name: "credential-null", credential: null },
          { name: "credential-array", credential: [GOOD] },
          { name: "credential-string", credential: "https://a.example" },
          { name: "no-url", credential: { transport: "http", headers: {} } },
          { name: "url-number", credential: { url: 7, transport: "http", headers: {} } },
          { name: "url-null", credential: { url: null, transport: "http", headers: {} } },
          { name: "bad-transport", credential: { url: "https://c.example", transport: "grpc", headers: {} } },
          { name: "upper-transport", credential: { url: "https://c.example", transport: "HTTP", headers: {} } },
          { name: "no-transport", credential: { url: "https://c.example", headers: {} } },
          ["not", "an", "entry"],
          null,
          "string-entry",
          42,
        ],
      })
    ),
    session: PLANTED,
    env: {},
  },
  {
    name: "only url and transport are checked: headers and expiresAt pass through as written",
    serversFile: file(
      servers(
        { name: "no-headers", credential: { url: "https://a.example", transport: "http" } },
        { name: "headers-number", credential: { url: "https://a.example", transport: "sse", headers: 5 } },
        { name: "headers-array", credential: { url: "https://a.example", transport: "http", headers: ["x"] } },
        { name: "header-values-mixed", credential: { url: "https://a.example", transport: "http", headers: { a: "b", n: 1, z: null } } },
        { name: "expires-number", credential: { url: "https://a.example", transport: "http", headers: {}, expiresAt: 12 } },
        { name: "empty-url", credential: { url: "", transport: "http", headers: {} } }
      )
    ),
    session: PLANTED,
    env: {},
  },
  {
    name: "names a file name could not carry are kept as written",
    serversFile: file(
      servers(
        { name: "../escape", credential: GOOD },
        { name: "with space", credential: GOOD },
        { name: "slash/name", credential: GOOD },
        { name: "ünïcødé ✓", credential: GOOD },
        { name: ".json", credential: GOOD },
        { name: " ", credential: GOOD }
      )
    ),
    session: PLANTED,
    env: {},
  },
  { name: "repeated top-level keys: the last one wins", serversFile: file(text('{"servers":[],"servers":[{"name":"last","credential":{"url":"https://a.example","transport":"http","headers":{}}}]}')), session: PLANTED, env: {} },
  { name: "repeated keys inside a credential: the last one wins", serversFile: file(text('{"servers":[{"name":"a","credential":{"url":"https://a.example","transport":"grpc","headers":{},"transport":"sse"}}]}')), session: PLANTED, env: {} },
  { name: "a lone surrogate escape in a name is kept", serversFile: file(text('{"servers":[{"name":"a\\ud800b","credential":{"url":"https://a.example","transport":"http","headers":{}}}]}')), session: PLANTED, env: {} },
  { name: "escaped characters decode", serversFile: file(text('{"servers":[{"name":"t\\u00e9st\\n\\"q\\"","credential":{"url":"https:\\/\\/a.example","transport":"\\u0068ttp","headers":{}}}]}')), session: PLANTED, env: {} },
  { name: "a byte-order mark is not JSON", serversFile: file(text('﻿{"servers":[{"name":"a","credential":{"url":"https://a.example","transport":"http","headers":{}}}]}')), session: PLANTED, env: {} },
  { name: "NaN is not JSON", serversFile: file(text('{"servers":[{"name":"a","credential":{"url":"https://a.example","transport":"http","headers":{},"n":NaN}}]}')), session: PLANTED, env: {} },
  { name: "Infinity is not JSON", serversFile: file(text('{"servers":[{"name":"a","credential":{"url":"https://a.example","transport":"http","headers":{},"n":Infinity}}]}')), session: PLANTED, env: {} },
  { name: "-Infinity is not JSON", serversFile: file(text('{"servers":[{"name":"a","credential":{"url":"https://a.example","transport":"http","headers":{},"n":-Infinity}}]}')), session: PLANTED, env: {} },
  { name: "a trailing comma is not JSON", serversFile: file(text('{"servers":[{"name":"a","credential":{"url":"https://a.example","transport":"http","headers":{}}},]}')), session: PLANTED, env: {} },
  { name: "single quotes are not JSON", serversFile: file(text("{'servers':[]}")), session: PLANTED, env: {} },
  { name: "trailing content is not JSON", serversFile: file(text('{"servers":[]} x')), session: PLANTED, env: {} },
  { name: "a leading form feed is not JSON whitespace", serversFile: file(text('\f{"servers":[]}')), session: PLANTED, env: {} },
  { name: "a leading no-break space is not JSON whitespace", serversFile: file(text(' {"servers":[]}')), session: PLANTED, env: {} },
  { name: "a raw control character in a string is not JSON", serversFile: file(text('{"servers":[{"name":"a\u0001","credential":{"url":"https://a.example","transport":"http","headers":{}}}]}')), session: PLANTED, env: {} },
  { name: "a leading-zero number is not JSON", serversFile: file(text('{"version":01,"servers":[]}')), session: PLANTED, env: {} },
  { name: "JSON whitespace around the document is fine", serversFile: file(text(' \r\n\t{"servers":[{"name":"a","credential":{"url":"https://a.example","transport":"http","headers":{}}}]} \r\n\t')), session: PLANTED, env: {} },
  { name: "numbers in unknown keys pass through", serversFile: file(text('{"servers":[{"name":"a","credential":{"url":"https://a.example","transport":"http","headers":{},"f":1.5,"e":2e3,"neg":-7,"z":0}}]}')), session: PLANTED, env: {} },
  { name: "an invalid UTF-8 byte reads as U+FFFD", serversFile: file(bytes('{"servers":[{"name":"a', [0xff], 'b","credential":{"url":"https://a.example","transport":"http","headers":{}}}]}')), session: PLANTED, env: {} },
  { name: "an encoded surrogate in a name", serversFile: file(bytes('{"servers":[{"name":"a', [0xed, 0xa0, 0x80], 'b","credential":{"url":"https://a.example","transport":"http","headers":{}}}]}')), session: PLANTED, env: {} },
  { name: "an overlong encoding in a name", serversFile: file(bytes('{"servers":[{"name":"a', [0xc0, 0xaf], 'b","credential":{"url":"https://a.example","transport":"http","headers":{}}}]}')), session: PLANTED, env: {} },
  { name: "a truncated four-byte sequence in a name", serversFile: file(bytes('{"servers":[{"name":"a', [0xf0, 0x9f], 'b","credential":{"url":"https://a.example","transport":"http","headers":{}}}]}')), session: PLANTED, env: {} },
  { name: "legacy env variables change nothing when the file is valid", serversFile: file(servers({ name: "ggui", credential: GOOD })), session: PLANTED, env: LEGACY_ENV },
  { name: "legacy env variables change nothing when the file is missing", serversFile: { kind: "missing" }, session: PLANTED, env: LEGACY_ENV },
  { name: "legacy env variables change nothing when the value is empty", serversFile: { kind: "empty" }, session: PLANTED, env: LEGACY_ENV },
  { name: "legacy env variables change nothing when the file is malformed", serversFile: file(text("{ not json")), session: PLANTED, env: LEGACY_ENV },
];

const SESSION_DIR_CASES: CaseInput[] = [
  { name: "no credentials folder is no servers", serversFile: { kind: "unset" }, session: { kind: "absent" }, env: {} },
  { name: "an empty credentials folder is no servers", serversFile: { kind: "unset" }, session: { kind: "folder", entries: {} }, env: {} },
  { name: "a credentials path that is a regular file is no servers", serversFile: { kind: "unset" }, session: { kind: "not-a-directory" }, env: {} },
  {
    name: "one entry per valid .json file, keyed by the file name stem",
    serversFile: { kind: "unset" },
    session: { kind: "folder", entries: { "ggui.json": json({ url: "https://mcp.example/apps/app_123", transport: "http", headers: { authorization: "Bearer tok" } }), "guuey-memory.json": json({ url: "http://127.0.0.1:9111/mcp", transport: "sse", headers: {}, expiresAt: "2026-07-29T00:00:00.000Z" }) } },
    env: {},
  },
  {
    name: "entries come back in byte order of their file names",
    serversFile: { kind: "unset" },
    session: { kind: "folder", entries: { "b.json": json(GOOD), "a.json": json(GOOD), "B.json": json(GOOD), "_.json": json(GOOD), "a-b.json": json(GOOD), "aa.json": json(GOOD), "0.json": json(GOOD) } },
    env: {},
  },
  {
    name: "files not ending in .json are ignored",
    serversFile: { kind: "unset" },
    session: { kind: "folder", entries: { "ggui.json": json(GOOD), "README.txt": text("not a credential"), ".keep": text(""), "upper.JSON": json(GOOD), "backup.json.bak": json(GOOD), "nojson": json(GOOD) } },
    env: {},
  },
  {
    name: "malformed files are skipped",
    serversFile: { kind: "unset" },
    session: {
      kind: "folder",
      entries: {
        "good.json": json(GOOD),
        "not-json.json": text("{ this is not json"),
        "array.json": json([GOOD]),
        "null.json": text("null"),
        "empty.json": text(""),
        "no-url.json": json({ transport: "http", headers: {} }),
        "bad-transport.json": json({ url: "https://c.example", transport: "grpc", headers: {} }),
        "bom.json": text('﻿{"url":"https://a.example","transport":"http","headers":{}}'),
        "nan.json": text('{"url":"https://a.example","transport":"http","headers":{},"n":NaN}'),
        "servers-shape.json": servers({ name: "x", credential: GOOD }),
      },
    },
    env: {},
  },
  {
    name: "unknown keys and unchecked fields pass through verbatim",
    serversFile: { kind: "unset" },
    session: { kind: "folder", entries: { "extra.json": json({ url: "https://a.example", transport: "sse", later: { nested: [1, "two", null] } }), "headers-number.json": json({ url: "https://a.example", transport: "http", headers: 3 }) } },
    env: {},
  },
  {
    name: "odd file names: a bare .json, a doubled extension, a leading dot",
    serversFile: { kind: "unset" },
    session: { kind: "folder", entries: { ".json": json(GOOD), "a.json.json": json(GOOD), ".hidden.json": json(GOOD), "with space.json": json(GOOD) } },
    env: {},
  },
  {
    name: "a folder named like a credential is skipped",
    serversFile: { kind: "unset" },
    session: { kind: "folder", entries: { "dir.json": { kind: "directory" }, "good.json": json(GOOD) } },
    env: {},
  },
  {
    name: "a symlinked credential is followed, a dangling one skipped",
    serversFile: { kind: "unset" },
    session: { kind: "folder", entries: { "linked.json": { kind: "symlink", target: json(GOOD) }, "dangling.json": { kind: "dangling-symlink" } } },
    env: {},
  },
  {
    name: "an invalid UTF-8 byte in a credential file reads as U+FFFD",
    serversFile: { kind: "unset" },
    session: { kind: "folder", entries: { "bytes.json": bytes('{"url":"https://a.example/', [0xff], '","transport":"http","headers":{}}') } },
    env: {},
  },
  {
    name: "legacy env variables change nothing with no credentials folder",
    serversFile: { kind: "unset" },
    session: { kind: "absent" },
    env: LEGACY_ENV,
  },
  {
    name: "legacy env variables change nothing next to a valid folder",
    serversFile: { kind: "unset" },
    session: { kind: "folder", entries: { "ggui.json": json(GOOD) } },
    env: LEGACY_ENV,
  },
];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "guuey-creds-golden-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeContent(path: string, content: Content): void {
  writeFileSync(path, content.kind === "text" ? Buffer.from(content.text, "utf8") : Buffer.from(content.base64, "base64"));
}

function place(path: string, node: TreeNode, targets: string): void {
  switch (node.kind) {
    case "text":
    case "bytes":
      writeContent(path, node);
      return;
    case "directory":
      mkdirSync(path);
      return;
    case "symlink": {
      const target = join(mkdtempSync(join(targets, "t-")), "target");
      writeContent(target, node.target);
      symlinkSync(target, path);
      return;
    }
    case "dangling-symlink":
      symlinkSync(join(targets, "absent-target"), path);
      return;
  }
}

/** Lay `c` out under `root` and run the real reader over it. */
function run(c: CaseInput): GoldenCase {
  if (MCP_SERVERS_FILE_ENV in c.env) throw new Error(`case "${c.name}": the servers-file variable belongs in serversFile`);
  const targets = join(root, "targets");
  const session = join(root, "session");
  mkdirSync(targets);
  mkdirSync(session);
  const credentials = join(session, ".guuey", "credentials");
  switch (c.session.kind) {
    case "absent":
      break;
    case "not-a-directory":
      mkdirSync(join(session, ".guuey"));
      writeFileSync(credentials, "", "utf8");
      break;
    case "folder":
      mkdirSync(credentials, { recursive: true });
      for (const [fileName, node] of Object.entries(c.session.entries)) place(join(credentials, fileName), node, targets);
      break;
  }
  const env: { [name: string]: string } = { ...c.env };
  const control = join(root, "control");
  const sf = c.serversFile;
  switch (sf.kind) {
    case "unset":
      break;
    case "empty":
      env[MCP_SERVERS_FILE_ENV] = "";
      break;
    case "file":
    case "file-trailing-slash": {
      mkdirSync(control);
      const path = join(control, "mcp-servers.json");
      place(path, sf.node, targets);
      env[MCP_SERVERS_FILE_ENV] = sf.kind === "file" ? path : `${path}/`;
      break;
    }
    case "missing":
      env[MCP_SERVERS_FILE_ENV] = join(root, "absent", "mcp-servers.json");
      break;
    case "relative-to-session-file": {
      const planted = join(session, "planted-servers.json");
      writeContent(planted, sf.content);
      env[MCP_SERVERS_FILE_ENV] = relative(process.cwd(), planted);
      break;
    }
    case "literal":
      env[MCP_SERVERS_FILE_ENV] = sf.value;
      break;
  }
  const expected = listCredentials({ app: join(root, "app"), home: join(root, "home"), session }, env)();
  return { ...c, expected };
}

function serialize(cases: GoldenCase[]): string {
  const names = new Set(cases.map((c) => c.name));
  if (names.size !== cases.length) throw new Error("golden case names must be unique");
  return `${JSON.stringify({ source: "@guuey/worker listCredentials (oss/packages/worker/src/creds.ts)", cases }, null, 2)}\n`;
}

describe("golden corpus: @guuey/worker listCredentials", () => {
  it("the servers file (GUUEY_MCP_SERVERS_FILE set)", async () => {
    const cases: GoldenCase[] = [];
    for (const c of SERVERS_FILE_CASES) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root);
      cases.push(run(c));
    }
    // The planted session folder never reaches a result while the variable is set.
    expect(JSON.stringify(cases.map((c) => c.expected))).not.toContain("attacker.example");
    await expect(serialize(cases)).toMatchFileSnapshot("../python/golden/creds/servers-file.json");
  });

  it("the session folder (GUUEY_MCP_SERVERS_FILE unset)", async () => {
    const cases: GoldenCase[] = [];
    for (const c of SESSION_DIR_CASES) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root);
      cases.push(run(c));
    }
    await expect(serialize(cases)).toMatchFileSnapshot("../python/golden/creds/session-dir.json");
  });
});
