/**
 * The hello's Claude CLI thread-resume block (guuey#3407 B3; guuey#3550): what a turn passed the SDK, hashed, and on a
 * `resume` what the stored session holds. ONE implementation, used by `@guuey/host`'s Claude framework and by a
 * builder worker that applies `invoke.cliSession` itself (`claude-session.ts`), so a Router compares like with like.
 *
 * Typed STRUCTURALLY over the few option fields it hashes, never over the SDK's own `Options`: this package carries
 * no SDK dependency, and both callers pass the values they actually hand `query()`.
 */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { hashSystemPrompt, hashUserBlocks, hashUserText, sha256OfFields } from "./cli-session-hash.js";
import { measureStoredSession } from "./cli-session-store.js";
import type { AnthropicUserBlock } from "./image-parts.js";
import {
  CLI_SESSION_HASH_VERSION,
  type HelloCliSession,
  type HelloHeaderShas,
  type InvokeCliSession,
} from "./protocol.js";

/** The refusal of a turn whose cwd's real path is longer than the CLI's directory name keeps whole. */
export const CLI_SESSION_PATH_TOO_LONG = "guuey: the session directory's path is too long to resume a CLI session in";
/** The refusal of a turn whose cwd does not exist (or is not a directory), so no stored session can be found under it. */
export const CLI_SESSION_CWD_MISSING = "guuey: the turn's working directory does not exist, so no CLI session can be resumed in it";
/** The refusal of a turn whose message does not end with its own text block. */
export const CLI_SESSION_NO_OWN_TEXT = "guuey: the turn's message must end with its own text block";

/** The agent-configuration fields the hello hashes, as passed to the SDK's `query()` options. */
export interface ClaudeSessionHeader {
  readonly model?: string;
  readonly permissionMode?: string;
  /** Present when the turn hands the SDK a permission callback; only its presence is hashed. */
  readonly canUseTool?: (...args: never[]) => unknown;
  /** The SDK's `tools`: a name list is hashed; any other form (a preset) hashes as no names. */
  readonly tools?: readonly string[] | object;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
}

/** One MCP server as passed to the SDK: only its transport and URL are hashed, never a header. */
export interface ClaudeSessionServer {
  readonly type?: string;
  readonly url?: string;
}

/**
 * The CLI's directory name for a cwd (R7a, measured on 2.1.282 and read in its bundle): the cwd's real path with every
 * character outside `[a-zA-Z0-9]` turned into `-`. `/session` gives `-session`. The CLI shortens a name over 200
 * characters with a hash this package does not reproduce, so such a cwd refuses rather than measuring the wrong file.
 */
export function cliProjectSlug(cwd: string): string {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch (err) {
    // A cwd that is gone is the builder's to see in plain words; every other fault is unexpected and goes up as it is.
    if (err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      throw new Error(CLI_SESSION_CWD_MISSING, { cause: err });
    }
    throw err;
  }
  const slug = real.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length > 200) throw new Error(CLI_SESSION_PATH_TOO_LONG);
  return slug;
}

/**
 * One sha per agent-configuration field passed to the SDK (B-3; all four are `agent-config`-only, B3 v1.8 item 3).
 * Each is a fixed canonical form: sorted names, the MCP servers by name with their transport and URL, never a header.
 */
export function claudeHeaderShas(
  header: ClaudeSessionHeader,
  servers: Readonly<Record<string, ClaudeSessionServer>>,
): HelloHeaderShas {
  const list = (v: readonly string[] | undefined): string[] => [...(v ?? [])].sort();
  const tools = Array.isArray(header.tools) ? (header.tools as readonly string[]) : [];
  return {
    model: sha256OfFields(["model", header.model ?? ""]),
    permissionMode: sha256OfFields(["permissionMode", header.permissionMode ?? (header.canUseTool !== undefined ? "canUseTool" : "")]),
    tools: sha256OfFields([
      "tools", ...list(tools),
      "allowed", ...list(header.allowedTools),
      "disallowed", ...list(header.disallowedTools),
    ]),
    mcpConfig: sha256OfFields([
      "mcp",
      ...Object.keys(servers).sort().flatMap((name) => {
        const s = servers[name];
        return [name, typeof s?.type === "string" ? s.type : "", typeof s?.url === "string" ? s.url : ""];
      }),
    ]),
  };
}

/** What {@link claudeSessionBlock} hashes for one turn. */
export interface ClaudeSessionBlockInput {
  /** The class-level system prompt passed to the SDK: one string (a preset cannot be hashed, so it cannot resume). */
  readonly systemPrompt: string;
  readonly header: ClaudeSessionHeader;
  readonly servers: Readonly<Record<string, ClaudeSessionServer>>;
  /** The turn's user message, every block exactly as passed to the CLI; the last block is the turn's own text. */
  readonly content: readonly AnthropicUserBlock[];
  readonly session: InvokeCliSession;
  /** The CLI's config root (its `CLAUDE_CONFIG_DIR`); the stored session is under `projects/<slug(cwd)>`. */
  readonly configDir: string;
  /** The CLI's cwd for this turn. */
  readonly cwd: string;
}

/** The hello's thread-resume block for one turn, with the stored measures on a `resume`. */
export function claudeSessionBlock(input: ClaudeSessionBlockInput): HelloCliSession {
  const { content, session } = input;
  const own = content[content.length - 1];
  if (own === undefined || own.type !== "text") throw new Error(CLI_SESSION_NO_OWN_TEXT);
  const promptBytes = content.reduce((n, b) => n + (b.type === "text" ? Buffer.byteLength(b.text, "utf8") : 0), 0);
  return {
    hashVersion: CLI_SESSION_HASH_VERSION,
    systemPromptSha256: hashSystemPrompt(input.systemPrompt),
    headerShas: claudeHeaderShas(input.header, input.servers),
    promptSha: hashUserBlocks(content),
    promptBytes,
    lastPromptSha: hashUserText(own.text),
    ...(session.mode === "resume"
      ? { stored: measureStoredSession(join(input.configDir, "projects", cliProjectSlug(input.cwd)), session.id) }
      : {}),
  };
}
