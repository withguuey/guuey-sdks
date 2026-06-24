import { describe, expect, it } from "vitest";
import type { GuueyAgent } from "@guuey/config";
import { GUUEY_DEFAULT_SYSTEM_PROMPT } from "@guuey/config";
import {
  buildOptions,
  withContextPreamble,
  type BuildOptionsContext,
  type CredentialFile,
} from "./options.js";

/** Minimal invoke context with no FS layers, no credentials, default env. */
function ctx(over: Partial<BuildOptionsContext> = {}): BuildOptionsContext {
  return {
    input: "hi",
    identity: { userId: "u1", authMode: "anonymous" },
    apiKey: "sk-test",
    readCredential: () => undefined,
    ...over,
  };
}

describe("buildOptions — MCP server translation", () => {
  it("defaults to the platform ggui server (http) when snapshot omits mcpServers", () => {
    const opts = buildOptions({}, ctx());
    expect(opts.mcpServers).toEqual({
      ggui: { type: "http", url: "https://mcp.ggui.ai" },
    });
  });

  it("maps a colocated entry → stdio SDK shape", () => {
    const snapshot: GuueyAgent = {
      mcpServers: {
        tool: { kind: "colocated", command: "node", args: ["dist/tool.js"] },
      },
    };
    const opts = buildOptions(snapshot, ctx());
    expect(opts.mcpServers).toEqual({
      tool: { type: "stdio", command: "node", args: ["dist/tool.js"] },
    });
  });

  it("maps an external (non-federated) entry → http SDK shape with resolved ${env.NAME} headers", () => {
    const snapshot: GuueyAgent = {
      mcpServers: {
        ext: {
          kind: "external",
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer ${env.MY_TOKEN}" },
        },
      },
    };
    const opts = buildOptions(snapshot, ctx({ env: { MY_TOKEN: "abc123" } }));
    expect(opts.mcpServers).toEqual({
      ext: {
        type: "http",
        url: "https://mcp.example.com",
        headers: { Authorization: "Bearer abc123" },
      },
    });
  });

  it("honors transport: 'sse' on an external entry", () => {
    const snapshot: GuueyAgent = {
      mcpServers: {
        ext: { kind: "external", url: "https://mcp.example.com", transport: "sse" },
      },
    };
    const opts = buildOptions(snapshot, ctx());
    expect(opts.mcpServers).toEqual({
      ext: { type: "sse", url: "https://mcp.example.com" },
    });
  });

  it("throws a descriptive error for a hosted entry", () => {
    const snapshot: GuueyAgent = {
      mcpServers: { h: { kind: "hosted", server: "todo-abc123" } },
    };
    expect(() => buildOptions(snapshot, ctx())).toThrow(/hosted MCP/);
  });

  it("throws a descriptive error for a proxied entry", () => {
    const snapshot: GuueyAgent = {
      mcpServers: { p: { kind: "proxied", connection: "gmail" } },
    };
    expect(() => buildOptions(snapshot, ctx())).toThrow(/proxied/);
  });
});

describe("buildOptions — federated credential reading (F1 binding amendment)", () => {
  const cred: CredentialFile = {
    url: "https://dev.mcp.sandbox.ggui.ai/apps/app-123",
    headers: { authorization: "Bearer minted-token" },
    expiresAt: "2030-01-01T00:00:00Z",
  };

  it("federated ggui server → reads <sessionDir>/.guuey/credentials/<server>.json and uses its url+headers", () => {
    const snapshot: GuueyAgent = {
      mcpServers: {
        ggui: { kind: "external", url: "https://mcp.ggui.ai", federate: true },
      },
    };
    const reads: string[] = [];
    const opts = buildOptions(
      snapshot,
      ctx({
        fs: { app: "/fs/app", home: "/fs/home", session: "/fs/session" },
        readCredential: (server) => {
          reads.push(server);
          return server === "ggui" ? cred : undefined;
        },
      }),
    );
    expect(reads).toContain("ggui");
    expect(opts.mcpServers).toEqual({
      ggui: {
        type: "http",
        url: "https://dev.mcp.sandbox.ggui.ai/apps/app-123",
        headers: { authorization: "Bearer minted-token" },
      },
    });
  });

  it("federated server with ABSENT credential file → server is skipped (no federated MCP this turn)", () => {
    const snapshot: GuueyAgent = {
      mcpServers: {
        ggui: { kind: "external", url: "https://mcp.ggui.ai", federate: true },
      },
    };
    const opts = buildOptions(
      snapshot,
      ctx({
        fs: { app: "/fs/app", home: "/fs/home", session: "/fs/session" },
        readCredential: () => undefined,
      }),
    );
    expect(opts.mcpServers).toEqual({});
  });

  it("a non-federated ggui server is used as declared (never reads a credential)", () => {
    const snapshot: GuueyAgent = {
      mcpServers: {
        ggui: { kind: "external", url: "https://mcp.ggui.ai" },
      },
    };
    let read = false;
    const opts = buildOptions(
      snapshot,
      ctx({
        fs: { app: "/fs/app", home: "/fs/home", session: "/fs/session" },
        readCredential: () => {
          read = true;
          return undefined;
        },
      }),
    );
    expect(read).toBe(false);
    expect(opts.mcpServers).toEqual({
      ggui: { type: "http", url: "https://mcp.ggui.ai" },
    });
  });
});

describe("buildOptions — allowedTools", () => {
  it("defaults to wildcard mcp__<server> for each declared server", () => {
    const snapshot: GuueyAgent = {
      mcpServers: {
        a: { kind: "external", url: "https://a.example.com" },
        b: { kind: "external", url: "https://b.example.com" },
      },
    };
    const opts = buildOptions(snapshot, ctx());
    expect(opts.allowedTools).toEqual(["mcp__a", "mcp__b"]);
  });

  it("passes an explicit allowlist through verbatim", () => {
    const snapshot: GuueyAgent = {
      mcpServers: { a: { kind: "external", url: "https://a.example.com" } },
      tools: { allowlist: ["mcp__a__do_thing", "mcp__a__other"] },
    };
    const opts = buildOptions(snapshot, ctx());
    expect(opts.allowedTools).toEqual(["mcp__a__do_thing", "mcp__a__other"]);
  });
});

describe("buildOptions — model + maxTurns + isolation flags", () => {
  it("defaults model to claude-sonnet-4-6 and maxTurns to 25", () => {
    const opts = buildOptions({}, ctx());
    expect(opts.model).toBe("claude-sonnet-4-6");
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

  it("with fs: cwd=session, additionalDirectories=[home,app], file tools (no Bash), GUUEY_* env", () => {
    const opts = buildOptions({}, ctx({ fs }));
    expect(opts.cwd).toBe("/fs/session");
    expect(opts.additionalDirectories).toEqual(["/fs/home", "/fs/app/shared"]);
    expect(opts.tools).toEqual(["Read", "Write", "Edit", "Glob", "Grep"]);
    expect(opts.tools).not.toContain("Bash");
    expect(opts.allowedTools).toContain("Read");
    expect(opts.env?.GUUEY_HOME_DIR).toBe("/fs/home");
    expect(opts.env?.GUUEY_APP_DIR).toBe("/fs/app/shared");
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
