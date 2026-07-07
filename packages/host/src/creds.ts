/**
 * Framework-neutral credential-file reading, shared by every runner.
 *
 * The Router-side credential broker resolves EVERYTHING (default server,
 * federation, minting, env substitution) and writes one JSON file per MCP
 * server to `<sessionDir>/.guuey/credentials/<server>.json` before each
 * worker spawn. Runners only read and shape — no resolution logic here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fs } from "@guuey/worker";

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
 * Read all credential files the Router broker wrote for this invoke. Returns
 * one `{ name, cred }` per valid `.json` file — malformed files are silently
 * skipped (never crash the turn). Missing directory → empty array (no MCP).
 */
export function listCredentials(fs: Fs): () => Array<{ name: string; cred: CredentialFile }> {
  return () => {
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
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          typeof (parsed as { url?: unknown }).url === "string" &&
          ((parsed as { transport?: unknown }).transport === "http" ||
            (parsed as { transport?: unknown }).transport === "sse")
        ) {
          out.push({ name: file.replace(/\.json$/, ""), cred: parsed as CredentialFile });
        }
      } catch {
        // malformed file → skip (never crash the turn).
      }
    }
    return out;
  };
}
