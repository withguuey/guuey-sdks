/**
 * Framework-neutral credential-file reading, shared by every worker — the
 * `@guuey/host` runners AND the code-mode workers scaffolded by
 * `@guuey/create-agentic-app` (which is why it lives in the protocol package
 * rather than in the host: both sides read the same broker-written files).
 *
 * The Router-side credential broker resolves EVERYTHING (default server,
 * federation, minting, env substitution); workers only read and shape — no
 * resolution logic here. The files reach a worker in one of two places:
 *
 * - **The servers file**, when the platform sets {@link MCP_SERVERS_FILE_ENV}:
 *   one JSON file ({@link McpServersFile}) holding every server's entry, placed
 *   by the trusted side outside every tree the worker can write. While the
 *   variable is set, and even when it is EMPTY (the platform's "no servers this
 *   turn"), the session directory is never read for credentials: an entry
 *   planted there by an earlier turn is never picked up.
 * - **The session directory**, when the variable is unset (local dev, and every
 *   runtime that predates the servers file): one JSON file per MCP server at
 *   `<sessionDir>/.guuey/credentials/<server>.json`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fs } from "./protocol.js";

/**
 * One parsed credential file. The shape is the broker's §7.1 contract — the
 * worker consumes it verbatim without consulting the snapshot (the broker
 * owns ALL resolution including transport).
 */
export interface CredentialFile {
  /** The resolved MCP URL (may be scoped `<host>/apps/<id>` for federated ggui). */
  url: string;
  /** Transport the broker selected for this server. */
  transport: "http" | "sse";
  /** Headers to forward — typically `{ authorization: 'Bearer <token>' }`. */
  headers: Record<string, string>;
  /** ISO expiry; informational for the worker (the Router refreshes per invoke). */
  expiresAt?: string;
}

/**
 * The environment variable naming the servers file. Set only by the platform.
 * An empty value means "no MCP servers this turn"; it still turns the session
 * directory off.
 */
export const MCP_SERVERS_FILE_ENV = "GUUEY_MCP_SERVERS_FILE";

/**
 * The servers file: every server's entry in one file, each entry the same
 * {@link CredentialFile} the per-server files carry. Unknown keys, at the top
 * and in an entry, are ignored, so a later writer may add fields.
 */
export interface McpServersFile {
  version: 1;
  servers: Array<{ name: string; credential: CredentialFile }>;
}

function isCredentialFile(value: unknown): value is CredentialFile {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { url?: unknown }).url === "string" &&
    ((value as { transport?: unknown }).transport === "http" ||
      (value as { transport?: unknown }).transport === "sse")
  );
}

/**
 * The servers file's entries: invalid or repeated entries are skipped; an
 * unreadable file is no servers. A path that is not absolute is no servers
 * too: it would resolve against the working directory, the session tree.
 */
function readServersFile(path: string): Array<{ name: string; cred: CredentialFile }> {
  if (!path.startsWith("/")) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return []; // no file, or not JSON → no MCP (never crash the turn).
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const servers = (parsed as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) return [];
  const out: Array<{ name: string; cred: CredentialFile }> = [];
  const seen = new Set<string>();
  for (const entry of servers) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const name = (entry as { name?: unknown }).name;
    const credential = (entry as { credential?: unknown }).credential;
    if (typeof name !== "string" || name === "" || seen.has(name) || !isCredentialFile(credential)) continue;
    seen.add(name);
    out.push({ name, cred: credential });
  }
  return out;
}

/** The session directory's entries, one per valid `.json` file. */
function readSessionDir(fs: Fs): Array<{ name: string; cred: CredentialFile }> {
  const dir = join(fs.session, ".guuey", "credentials");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return []; // no cred dir this turn → no MCP.
  }
  const out: Array<{ name: string; cred: CredentialFile }> = [];
  for (const file of names) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (isCredentialFile(parsed)) out.push({ name: file.replace(/\.json$/, ""), cred: parsed });
    } catch {
      // malformed file → skip (never crash the turn).
    }
  }
  return out;
}

/**
 * Read all credential entries the Router broker wrote for this invoke. Returns
 * one `{ name, cred }` per valid entry — malformed entries are silently
 * skipped (never crash the turn). Nothing to read → empty array (no MCP).
 *
 * `env` is read on every call; it defaults to `process.env`.
 */
export function listCredentials(
  fs: Fs,
  env: Readonly<Record<string, string | undefined>> = process.env
): () => Array<{ name: string; cred: CredentialFile }> {
  return () => {
    const serversFile = env[MCP_SERVERS_FILE_ENV];
    return serversFile === undefined ? readSessionDir(fs) : readServersFile(serversFile);
  };
}
