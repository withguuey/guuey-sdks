import { describe, expect, it } from "vitest";
import { mcpToolPredicateFor, reportToolGateErrors } from "./mcp-tool-gates.js";

/** The kept tools of `candidates` on `server`, or "open" when the gate filters nothing. */
function keptOn(server: string, gates: Parameters<typeof mcpToolPredicateFor>[1], withheld?: Parameters<typeof mcpToolPredicateFor>[2]) {
  const keep = mcpToolPredicateFor(server, gates, withheld);
  if (keep === undefined) return "open";
  return ["render", "consume", "search"].filter((t) => keep(t));
}

describe("mcpToolPredicateFor — the config tool gates, per server, for the frameworks that filter a server's tools (OpenAI, ADK)", () => {
  it("no gates and no withholds → no filter at all (today's catalog)", () => {
    expect(keptOn("ggui", undefined)).toBe("open");
    expect(keptOn("ggui", {})).toBe("open");
    expect(keptOn("ggui", { allowlist: [], denylist: [] })).toBe("open");
  });

  it("allowlist first: <server>.<tool> keeps only those on that server; another server's entries keep nothing here", () => {
    expect(keptOn("ggui", { allowlist: ["ggui.render"] })).toEqual(["render"]);
    expect(keptOn("ggui", { allowlist: ["other.render"] })).toEqual([]);
  });

  it("allowlist: <server>.* keeps that server whole; a bare name keeps that tool on every server", () => {
    expect(keptOn("ggui", { allowlist: ["ggui.*"] })).toBe("open");
    expect(keptOn("ggui", { allowlist: ["search"] })).toEqual(["search"]);
    expect(keptOn("other", { allowlist: ["search", "ggui.render"] })).toEqual(["search"]);
  });

  it("then the denylist subtracts: <server>.<tool>, a bare name on every server, <server>.* the whole server", () => {
    expect(keptOn("ggui", { denylist: ["ggui.consume"] })).toEqual(["render", "search"]);
    expect(keptOn("ggui", { denylist: ["consume"] })).toEqual(["render", "search"]);
    expect(keptOn("ggui", { denylist: ["ggui.*"] })).toEqual([]);
    expect(keptOn("ggui", { denylist: ["other.*", "other.consume"] })).toBe("open");
  });

  it("allowlist, then denylist, then this turn's withholds compose", () => {
    expect(keptOn("ggui", { allowlist: ["ggui.*"], denylist: ["ggui.consume"] }, [{ server: "ggui", tool: "search" }])).toEqual(["render"]);
    expect(keptOn("ggui", undefined, [{ server: "ggui", tool: "consume" }])).toEqual(["render", "search"]);
    expect(keptOn("ggui", undefined, [{ server: "other", tool: "consume" }])).toBe("open");
  });

  it("a malformed entry a stale snapshot slipped through is never matched verbatim: dropped from an allowlist, and in a denylist the server keeps nothing", () => {
    expect(keptOn("ggui", { denylist: ["mcp__ggui__consume"] })).toEqual([]);
    expect(keptOn("ggui", { allowlist: ["mcp__ggui__consume", "ggui.render"] })).toEqual(["render"]);
  });

  it("a built-in name (the Claude host's file tools, Bash) gates only an MCP tool of that name: these frameworks carry no built-ins", () => {
    // Denying one is a no-op for every other tool on the server.
    expect(keptOn("ggui", { denylist: ["Bash", "Read", "Write"] })).toEqual(["render", "consume", "search"]);
    // An allowlist of built-ins alone narrows the server to tools of those names: none here.
    expect(keptOn("ggui", { allowlist: ["Bash"] })).toEqual([]);
  });
});

describe('mcpToolPredicateFor — "no tools", allowlist: ["@none"] (guuey#2262)', () => {
  it('["@none"] keeps nothing on any server', () => {
    expect(keptOn("ggui", { allowlist: ["@none"] })).toEqual([]);
    expect(keptOn("other", { allowlist: [" @none "] })).toEqual([]);
    const keep = mcpToolPredicateFor("ggui", { allowlist: ["@none"] });
    expect(keep?.("@none")).toBe(false);
  });

  it("a mixed list keeps only the real entries; the sentinel is never matched as a tool name", () => {
    expect(keptOn("ggui", { allowlist: ["@none", "ggui.render"] })).toEqual(["render"]);
    expect(keptOn("ggui", { allowlist: ["@none", "ggui.*"] })).toBe("open");
    const keep = mcpToolPredicateFor("ggui", { allowlist: ["@none", "search"] });
    expect(keep?.("@none")).toBe(false);
    expect(keep?.("search")).toBe(true);
  });

  it('"@none" in a denylist subtracts nothing', () => {
    expect(keptOn("ggui", { denylist: ["@none"] })).toBe("open");
  });
});

describe("reportToolGateErrors — an unreadable denylist entry is named on stderr", () => {
  it("writes one [guuey] line per unreadable denylist entry, and nothing for readable gates", () => {
    const lines: string[] = [];
    reportToolGateErrors({ denylist: ["mcp__ggui__consume", "ggui.render"] }, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[guuey\] tools\.denylist entry "mcp__ggui__consume" cannot be read/);
    reportToolGateErrors({ allowlist: ["mcp__ggui__consume"], denylist: ["ggui.render"] }, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
  });
});
