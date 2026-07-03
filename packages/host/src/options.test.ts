import { describe, expect, it } from "vitest";
import type { GuueyAgent } from "@guuey/config";
import { GUUEY_DEFAULT_SYSTEM_PROMPT } from "@guuey/config";
import {
  buildOptions,
  resolveMcpServers,
  withContextPreamble,
  type BuildOptionsContext,
} from "./options.js";

/** Minimal invoke context with no FS layers, no credentials, default env. */
function ctx(over: Partial<BuildOptionsContext> = {}): BuildOptionsContext {
  return {
    input: "hi",
    identity: { userId: "u1", authMode: "anonymous" },
    apiKey: "sk-test",
    listCredentials: () => [],
    ...over,
  };
}

describe("resolveMcpServers — cred-dir mapper", () => {
  it("maps each cred-dir entry to an SdkMcpServer keyed by name", () => {
    const result = resolveMcpServers(
      ctx({
        listCredentials: () => [
          {
            name: "ggui",
            cred: {
              url: "https://mcp.ggui.ai/apps/a",
              transport: "http",
              headers: { authorization: "Bearer t" },
            },
          },
          { name: "ext", cred: { url: "https://x/mcp", transport: "sse" as const, headers: {} as Record<string, string> } },
        ],
      }),
    );
    expect(result).toEqual({
      ggui: {
        type: "http",
        url: "https://mcp.ggui.ai/apps/a",
        headers: { authorization: "Bearer t" },
      },
      ext: { type: "sse", url: "https://x/mcp" },
    });
  });

  it("returns {} for an empty cred dir", () => {
    expect(resolveMcpServers(ctx({ listCredentials: () => [] }))).toEqual({});
  });
});

describe("buildOptions — MCP servers from cred dir", () => {
  it("produces mcpServers keyed by cred-dir names when the broker wrote credentials", () => {
    // The Router wrote ggui + ext to the cred dir; buildOptions surfaces them both.
    const opts = buildOptions(
      {},
      ctx({
        listCredentials: () => [
          {
            name: "ggui",
            cred: {
              url: "https://mcp.ggui.ai/apps/app-default",
              transport: "http",
              headers: { authorization: "Bearer tok" },
            },
          },
        ],
      }),
    );
    expect(opts.mcpServers).toEqual({
      ggui: {
        type: "http",
        url: "https://mcp.ggui.ai/apps/app-default",
        headers: { authorization: "Bearer tok" },
      },
    });
  });

  it("produces an empty mcpServers map when the cred dir is empty (no MCP this turn)", () => {
    const opts = buildOptions({}, ctx());
    expect(opts.mcpServers).toEqual({});
  });
});

describe("buildOptions — allowedTools", () => {
  it("defaults to wildcard mcp__<server> for each cred-dir server name", () => {
    const opts = buildOptions(
      {},
      ctx({
        listCredentials: () => [
          { name: "a", cred: { url: "https://a.example.com", transport: "http", headers: {} } },
          { name: "b", cred: { url: "https://b.example.com", transport: "sse", headers: {} } },
        ],
      }),
    );
    expect(opts.allowedTools).toEqual(["mcp__a", "mcp__b"]);
  });

  it("passes an explicit snapshot allowlist through verbatim", () => {
    const snapshot: GuueyAgent = {
      tools: { allowlist: ["mcp__a__do_thing", "mcp__a__other"] },
    };
    const opts = buildOptions(snapshot, ctx());
    expect(opts.allowedTools).toEqual(["mcp__a__do_thing", "mcp__a__other"]);
  });
});

describe("buildOptions — model + maxTurns + isolation flags", () => {
  it("defaults model to claude-sonnet-5 and maxTurns to 25", () => {
    const opts = buildOptions({}, ctx());
    expect(opts.model).toBe("claude-sonnet-5");
    expect(opts.maxTurns).toBe(25);
  });

  it("honors snapshot.model and snapshot.runtime.maxTurns", () => {
    const snapshot: GuueyAgent = { model: "claude-opus-4-1", runtime: { maxTurns: 7 } };
    const opts = buildOptions(snapshot, ctx());
    expect(opts.model).toBe("claude-opus-4-1");
    expect(opts.maxTurns).toBe(7);
  });

  it("always isolates settings (settingSources: []) and enforces strictMcpConfig", () => {
    const opts = buildOptions({}, ctx());
    expect(opts.settingSources).toEqual([]);
    expect(opts.strictMcpConfig).toBe(true);
  });
});

describe("buildOptions — permissionMode", () => {
  it("omits permissionMode when the snapshot does not set it", () => {
    const opts = buildOptions({}, ctx());
    expect("permissionMode" in opts).toBe(false);
  });

  it("forwards snapshot.claude.permissions.mode", () => {
    const snapshot: GuueyAgent = {
      claude: { permissions: { mode: "acceptEdits" } },
    };
    const opts = buildOptions(snapshot, ctx());
    expect(opts.permissionMode).toBe("acceptEdits");
  });
});

describe("buildOptions — GuueyFS layer binding (from the invoke fs field)", () => {
  const fs = { app: "/fs/app/shared", home: "/fs/home", session: "/fs/session" };

  it("without fs: tools:[] and no cwd/additionalDirectories, no GUUEY_* env", () => {
    const opts = buildOptions({}, ctx());
    expect(opts.tools).toEqual([]);
    expect("cwd" in opts).toBe(false);
    expect("additionalDirectories" in opts).toBe(false);
    expect(opts.env?.GUUEY_HOME_DIR).toBeUndefined();
    expect(opts.env?.GUUEY_APP_DIR).toBeUndefined();
  });

  it("with fs: cwd=session, additionalDirectories=[home,app], file tools + Bash, GUUEY_* env", () => {
    const opts = buildOptions({}, ctx({ fs }));
    expect(opts.cwd).toBe("/fs/session");
    expect(opts.additionalDirectories).toEqual(["/fs/home", "/fs/app/shared"]);
    expect(opts.tools).toEqual(["Read", "Write", "Edit", "Glob", "Grep", "Bash"]);
    expect(opts.allowedTools).toContain("Read");
    expect(opts.env?.GUUEY_HOME_DIR).toBe("/fs/home");
    expect(opts.env?.GUUEY_APP_DIR).toBe("/fs/app/shared");
  });
});

describe("buildOptions — Bash re-enabled prompt-free (Router bwrap is the isolation)", () => {
  const fs = { app: "/fs/app", home: "/fs/home", session: "/fs/session" };

  it("includes Bash in tools + allowedTools when fs is bound", () => {
    const opts = buildOptions({}, ctx({ fs }));
    expect(opts.tools).toContain("Bash");
    expect(opts.allowedTools).toContain("Bash");
  });

  it("omits Bash from tools + allowedTools when fs is NOT bound", () => {
    const opts = buildOptions({}, ctx());
    expect(opts.tools).toEqual([]);
    expect(opts.allowedTools).not.toContain("Bash");
  });

  it("Bash joins an explicit allowlist when fs is bound", () => {
    const snapshot: GuueyAgent = {
      tools: { allowlist: ["mcp__a__do_thing"] },
    };
    const opts = buildOptions(snapshot, ctx({ fs }));
    expect(opts.allowedTools).toEqual([
      "mcp__a__do_thing",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
    ]);
  });

  it("installs an auto-allow canUseTool (prompt-free) when fs is bound and no mode is pinned", async () => {
    const opts = buildOptions({}, ctx({ fs }));
    expect(typeof opts.canUseTool).toBe("function");
    expect("permissionMode" in opts).toBe(false);
    // The callback must auto-allow Bash without prompting (else a headless pod hangs).
    const signal = new AbortController().signal;
    const result = await opts.canUseTool?.("Bash", { command: "ls" }, { signal, toolUseID: "t1", requestId: "req1" });
    expect(result).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
  });

  it("does NOT install canUseTool when fs is NOT bound (purely MCP-driven, nothing to auto-allow)", () => {
    const opts = buildOptions({}, ctx());
    expect("canUseTool" in opts).toBe(false);
  });

  it("respects a pinned claude.permissions.mode instead of auto-allow (operator owns the posture)", () => {
    const snapshot: GuueyAgent = { claude: { permissions: { mode: "acceptEdits" } } };
    const opts = buildOptions(snapshot, ctx({ fs }));
    expect(opts.permissionMode).toBe("acceptEdits");
    // Mode and the auto-allow callback are mutually exclusive.
    expect("canUseTool" in opts).toBe(false);
  });

  it("does NOT set the SDK's own sandbox block (the Router bwrap is the isolation, not a nested bwrap)", () => {
    const opts = buildOptions({}, ctx({ fs }));
    expect("sandbox" in opts).toBe(false);
  });
});

describe("buildOptions — env composition + API key", () => {
  it("injects ANTHROPIC_API_KEY and the snapshot env block", () => {
    const snapshot: GuueyAgent = { env: { FOO: "bar" } };
    const opts = buildOptions(snapshot, ctx({ apiKey: "sk-xyz" }));
    expect(opts.env?.ANTHROPIC_API_KEY).toBe("sk-xyz");
    expect(opts.env?.FOO).toBe("bar");
  });
});

describe("buildOptions — Anthropic second seam (loopback proxy)", () => {
  it("routes the CLI subprocess at the loopback proxy with an opaque token, never a real key", () => {
    const opts = buildOptions(
      {},
      ctx({ baseUrl: "http://127.0.0.1:9911", authToken: "opaque" }),
    );
    expect(opts.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9911");
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe("opaque");
    expect(opts.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("a builder snapshot.env cannot override the base-URL or token", () => {
    const s: GuueyAgent = {
      env: { ANTHROPIC_BASE_URL: "http://evil", ANTHROPIC_AUTH_TOKEN: "attacker" },
    };
    const opts = buildOptions(s, ctx({ baseUrl: "http://127.0.0.1:9911", authToken: "opaque" }));
    expect(opts.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9911");
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe("opaque");
  });

  it("falls back to ANTHROPIC_API_KEY when baseUrl/authToken are absent (local-dev path)", () => {
    const opts = buildOptions({}, ctx({ apiKey: "sk-local" }));
    expect(opts.env?.ANTHROPIC_API_KEY).toBe("sk-local");
    expect(opts.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});

describe("buildOptions — systemPrompt + preamble integration", () => {
  it("uses GUUEY_DEFAULT_SYSTEM_PROMPT when the snapshot omits one", () => {
    const opts = buildOptions({}, ctx());
    expect(opts.systemPrompt).toBe(GUUEY_DEFAULT_SYSTEM_PROMPT);
  });

  it("prepends the history/memory/state preamble when context is present", () => {
    const opts = buildOptions(
      { systemPrompt: "SYS" },
      ctx({
        history: [{ role: "user", text: "hi" }],
        priorMemory: [{ key: "name", value: "Ada" }],
        priorState: { step: 2 },
      }),
    );
    expect(typeof opts.systemPrompt).toBe("string");
    const sp = opts.systemPrompt as string;
    expect(sp).toContain("<conversation_history>");
    expect(sp).toContain("<thread_memory>");
    expect(sp).toContain("Ada");
    expect(sp).toContain("<working_state>");
    expect(sp.endsWith("SYS")).toBe(true);
  });

  it("rejects an unresolved {file} systemPrompt loudly", () => {
    const snapshot = { systemPrompt: { file: "prompts/system.md" } } satisfies GuueyAgent;
    expect(() => buildOptions(snapshot, ctx())).toThrow(/resolved string/);
  });
});

describe("withContextPreamble", () => {
  it("renders all three sections when history + memory + state are present", () => {
    const out = withContextPreamble(
      "SYS",
      [{ role: "user", text: "hi" }],
      [{ key: "name", value: "Ada" }],
      { step: 2 },
    );
    expect(out).toContain("<conversation_history>");
    expect(out).toContain("<thread_memory>");
    expect(out).toContain("Ada");
    expect(out).toContain("<working_state>");
    expect(out).toContain('"step": 2');
    expect(out.endsWith("SYS")).toBe(true);
  });

  it("omits empty sections", () => {
    expect(withContextPreamble("SYS", undefined, [], undefined)).toBe("SYS");
    const out2 = withContextPreamble("SYS", undefined, [{ key: "k", value: "v" }], undefined);
    expect(out2).toContain("<thread_memory>");
    expect(out2).not.toContain("<working_state>");
    expect(out2).not.toContain("<conversation_history>");
  });
});
