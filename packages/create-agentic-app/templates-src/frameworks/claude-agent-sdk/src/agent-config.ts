/**
 * Snapshot + system-prompt + MCP-endpoint resolution shared by both framework
 * overlays. Duplicated verbatim in `templates-src/frameworks/openai-agents-sdk`
 * by design — template code must be self-contained (no cross-overlay imports),
 * so keep the two copies byte-identical when editing either one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGuueyJson, type GuueyAgent } from "@guuey/config";
import type { Invoke } from "@guuey/worker";

/** GUUEY_AGENT_SNAPSHOT (set by the platform pod and by `guuey dev`) wins; guuey.json is the fallback. */
export function loadAgent(invoke: Invoke): GuueyAgent {
  const env = process.env.GUUEY_AGENT_SNAPSHOT;
  if (env) return JSON.parse(env) as GuueyAgent;
  const raw = JSON.parse(readFileSync(join(invoke.fs.app, "guuey.json"), "utf8"));
  return parseGuueyJson(raw).agent;
}

export function systemPrompt(invoke: Invoke, agent: GuueyAgent): string | undefined {
  const sp = agent.systemPrompt;
  if (typeof sp === "string") return sp;
  if (sp?.file) return readFileSync(join(invoke.fs.app, sp.file), "utf8");
  return undefined;
}

/**
 * One resolved MCP endpoint this worker may connect to. `transport` rides
 * alongside `url`/`headers` (not hardcoded to `"http"`) because a federation
 * credential file — `<session>/.guuey/credentials/<name>.json`, shape
 * `{url, transport, headers}` per `@guuey/host`'s `CredentialFile` — may
 * resolve a server onto the `sse` transport arm.
 */
export interface McpEndpoint {
  url: string;
  transport: "http" | "sse";
  headers: Record<string, string>;
}

/** Lowered entries are `external`; federation credentials (if any) arrive as per-session files. */
export function mcpEndpoints(invoke: Invoke, agent: GuueyAgent): Record<string, McpEndpoint> {
  const out: Record<string, McpEndpoint> = {};
  for (const [name, entry] of Object.entries(agent.mcpServers ?? {})) {
    if (entry.kind !== "external") continue; // hosted/proxied are lowered to external before a worker ever runs
    let url = entry.url;
    let transport: "http" | "sse" = entry.transport ?? "http";
    let headers: Record<string, string> = { ...(entry.headers ?? {}) };
    try {
      const cred = JSON.parse(
        readFileSync(join(invoke.fs.session, ".guuey", "credentials", `${name}.json`), "utf8")
      ) as { url: string; transport: "http" | "sse"; headers: Record<string, string> };
      url = cred.url;
      transport = cred.transport;
      headers = cred.headers;
    } catch {
      // no credential file — plain external endpoint; static headers apply
    }
    out[name] = { url, transport, headers };
  }
  return out;
}

/** Fold prior turns into a prompt preamble (v1 keep-it-simple history handling). */
export function withHistory(invoke: Invoke): string {
  if (invoke.history.length === 0) return invoke.input;
  const lines = invoke.history.map(
    (h) => `${h.role === "agent" ? "Assistant" : "User"}: ${h.text}`
  );
  return `<conversation_history>\n${lines.join("\n")}\n</conversation_history>\n\n${invoke.input}`;
}
