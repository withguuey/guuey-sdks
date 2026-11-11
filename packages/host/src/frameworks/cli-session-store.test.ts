import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashSystemPrompt, hashUserBlocks, hashUserText } from "./cli-session-hash.js";
import { measureStoredSession } from "./cli-session-store.js";

/**
 * Session files shaped as the pinned CLI (2.1.282) writes them, per R7h's measures and its compaction read: synthetic
 * text only, built here rather than copied, so no machine path rides into the package.
 */
const ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const SYS = "the class-level system prompt";
const LEAD = ["<turn_context>\nPlatform data for this turn.\n", "<turn_directive>\n</turn_directive>"];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-session-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Entry = { [key: string]: unknown };
const write = (lines: readonly (Entry | string)[]): void => {
  writeFileSync(join(dir, `${ID}.jsonl`), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
};
const userContent = (text: string) => [...LEAD.map((t) => ({ type: "text", text: t })), { type: "text", text }];
const prompt = (uuid: string, parentUuid: string | null, text: string): Entry => ({
  type: "user", uuid, parentUuid, isSidechain: false, message: { role: "user", content: userContent(text) },
});
const attachment = (uuid: string, parentUuid: string, extra: Entry = {}): Entry => ({ type: "attachment", uuid, parentUuid, attachment: { type: "x", ...extra } });
const assistant = (uuid: string, parentUuid: string, text: string): Entry => ({ type: "assistant", uuid, parentUuid, message: { role: "assistant", content: [{ type: "text", text }] } });
const toolResult = (uuid: string, parentUuid: string): Entry => ({ type: "user", uuid, parentUuid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "1\n2\n" }] } });
const lastPrompt = (text: string, leafUuid: string): Entry => ({ type: "last-prompt", lastPrompt: text, leafUuid, sessionId: ID });
const bookkeeping: Entry[] = [{ type: "queue-operation", operation: "enqueue" }, { type: "atis-latch" }, { type: "cost-state" }, { type: "mode", mode: "default" }];
const promptSha = (text: string) => hashUserBlocks(userContent(text).map((b) => ({ type: "text" as const, text: b.text })));

/** Two turns, the second with a tool call: one walk. */
const twoTurns: Entry[] = [
  ...bookkeeping,
  prompt("u1", null, "turn one"),
  attachment("a1", "u1", { systemPrompt: [SYS] }),
  assistant("r1", "a1", "reply one"),
  lastPrompt("turn one", "r1"),
  prompt("u2", "r1", "turn two"),
  assistant("c2", "u2", "calling"),
  toolResult("t2", "c2"),
  attachment("a2", "t2", { systemPrompt: [SYS] }),
  assistant("r2", "a2", "reply two"),
  lastPrompt("turn two", "r2"),
];

/** The same thread compacted during turn three, as the compaction read measured it. */
const compacted: Entry[] = [
  ...twoTurns,
  lastPrompt("turn three", "a3"),
  prompt("u3", "r2", "turn three"),
  attachment("a3", "u3"),
  { ...prompt("u3", "r2", "turn three"), slug: "s" },
  { ...attachment("a3", "u3"), slug: "s" },
  { type: "system", subtype: "compact_boundary", uuid: "b1", parentUuid: null, logicalParentUuid: "a3", content: "Conversation compacted" },
  attachment("a4", "b1"),
  { type: "user", uuid: "s1", parentUuid: "a4", isCompactSummary: true, message: { role: "user", content: "summary" } },
  assistant("r3", "s1", "reply three"),
  attachment("a5", "r3"),
  lastPrompt("turn three", "a5"),
];

describe("measureStoredSession: a session the pinned CLI wrote", () => {
  it("one walk: every prompt in order, every stored system prompt and last prompt, nothing unclassified", () => {
    write(twoTurns);
    mkdirSync(join(dir, ID, "tool-results"), { recursive: true });
    writeFileSync(join(dir, ID, "tool-results", "b1.txt"), "out");
    const m = measureStoredSession(dir, ID);
    expect(m.readError).toBeUndefined();
    expect(m.walks).toEqual([{ fromLastPromptLeaf: true, promptShas: [promptSha("turn one"), promptSha("turn two")], compactSummaries: 0, boundary: "none" }]);
    expect(m.systemPromptShas).toEqual([hashSystemPrompt(SYS), hashSystemPrompt(SYS)]);
    expect(m.lastPromptShas).toEqual([hashUserText("turn one"), hashUserText("turn two")]);
    expect(m.entries).toEqual([ID, `${ID}/tool-results`, `${ID}/tool-results/b1.txt`, `${ID}.jsonl`]);
    expect({ u: m.unclassified, c: m.corrupt, d: m.benignDuplicates, p: m.filePromptEntries, s: m.fileCompactSummaries }).toEqual({ u: 0, c: 0, d: 0, p: 2, s: 0 });
  });

  it("a compaction: two walks, the summary walk rooted at the boundary with no prompt, two benign duplicates", () => {
    write(compacted);
    const m = measureStoredSession(dir, ID);
    expect(m.unclassified).toBe(0);
    expect(m.corrupt).toBe(0);
    expect(m.benignDuplicates).toBe(2);
    const pre = m.walks.find((w) => w.boundary === "none");
    const summary = m.walks.find((w) => w.boundary !== "none");
    expect(m.walks).toHaveLength(2);
    expect(pre).toEqual({ fromLastPromptLeaf: false, promptShas: ["turn one", "turn two", "turn three"].map(promptSha), compactSummaries: 0, boundary: "none" });
    expect(summary).toEqual({ fromLastPromptLeaf: true, promptShas: [], compactSummaries: 1, boundary: "links-other-leaf" });
    expect(m.lastPromptShas).toEqual(["turn one", "turn two", "turn three", "turn three"].map(hashUserText));
    expect({ p: m.filePromptEntries, s: m.fileCompactSummaries }).toEqual({ p: 3, s: 1 });
  });
});

describe("measureStoredSession: the session file cannot be read", () => {
  it("missing", () => {
    expect(measureStoredSession(dir, ID)).toMatchObject({ readError: "missing", walks: [], systemPromptShas: [] });
  });
  it("a link, never followed, and listed as a link", () => {
    writeFileSync(join(dir, "elsewhere.jsonl"), JSON.stringify(prompt("u1", null, "x")) + "\n");
    symlinkSync(join(dir, "elsewhere.jsonl"), join(dir, `${ID}.jsonl`));
    const m = measureStoredSession(dir, ID);
    expect(m.readError).toBe("link");
    expect(m.entries).toContain(`${ID}.jsonl@link`);
  });
  it("a directory", () => {
    mkdirSync(join(dir, `${ID}.jsonl`));
    expect(measureStoredSession(dir, ID).readError).toBe("not-regular");
  });
});

describe("measureStoredSession: what it cannot vouch for is counted, never dropped", () => {
  it("D1: a duplicate uuid with an equal message but another parent is unclassified, not benign", () => {
    write([...twoTurns, { ...prompt("u2", "u1", "turn two") }]);
    const m = measureStoredSession(dir, ID);
    expect({ u: m.unclassified, d: m.benignDuplicates }).toEqual({ u: 1, d: 0 });
  });

  it("D1: a duplicate with an edited message is unclassified", () => {
    write([...twoTurns, prompt("u2", "r1", "turn two, edited")]);
    expect(measureStoredSession(dir, ID).unclassified).toBe(1);
  });

  it("D1: a re-serialized duplicate (key order, escapes) adding only slug is benign", () => {
    const again = '{"slug":"s","message":{"content":[' + userContent("turn two").map((b) => `{"text":${JSON.stringify(b.text)},"type":"text"}`).join(",") + '],"role":"user"},"isSidechain":false,"parentUuid":"r1","uuid":"u2","type":"user"}';
    write([...twoTurns, again]);
    expect(measureStoredSession(dir, ID)).toMatchObject({ unclassified: 0, benignDuplicates: 1 });
  });

  it("D2: a second compaction boundary, or one that is not a walk's root, is unclassified", () => {
    write([...compacted, { type: "system", subtype: "compact_boundary", uuid: "b2", parentUuid: "r3", logicalParentUuid: "a3" }]);
    expect(measureStoredSession(dir, ID).unclassified).toBeGreaterThanOrEqual(2);
  });

  it("D3: a prompt on a branch whose parent names no entry counts in the file and is corrupt (wire v1.3)", () => {
    write([...twoTurns, prompt("x9", "nowhere", "forged")]);
    const m = measureStoredSession(dir, ID);
    expect(m.filePromptEntries).toBe(3);
    expect({ c: m.corrupt, u: m.unclassified }).toEqual({ c: 1, u: 0 });
  });

  it("runtime C-1: a 2-cycle and a self-parent are corrupt, and the walk ends (mutant: no visited set)", () => {
    write([...twoTurns, prompt("x1", "x2", "loop one"), prompt("x2", "x1", "loop two")]);
    const loop = measureStoredSession(dir, ID);
    expect(loop.corrupt).toBeGreaterThanOrEqual(1);
    expect(loop.walks).toHaveLength(1);
    write([...twoTurns, prompt("y1", "y1", "own parent")]);
    expect(measureStoredSession(dir, ID).corrupt).toBeGreaterThanOrEqual(1);
  });

  it("a leaf whose chain runs into a loop: that walk stops at the revisited uuid and is corrupt", () => {
    write([...twoTurns, prompt("z1", "z2", "loop one"), prompt("z2", "z1", "loop two"), prompt("z3", "z1", "below the loop")]);
    const m = measureStoredSession(dir, ID);
    expect(m.corrupt).toBeGreaterThanOrEqual(1);
    expect(m.walks).toHaveLength(2);
  });

  it("an unknown line type and a system line of another subtype are unclassified; an unparseable line is corrupt", () => {
    write([...twoTurns, { type: "telemetry" }, { type: "system", subtype: "note", uuid: "n1", parentUuid: null }, "{not json"]);
    expect(measureStoredSession(dir, ID)).toMatchObject({ unclassified: 2, corrupt: 1 });
  });

  it("a user entry with an unhashable block is unclassified", () => {
    write([...twoTurns, { type: "user", uuid: "d1", parentUuid: "r2", message: { role: "user", content: [{ type: "document", source: {} }] } }]);
    expect(measureStoredSession(dir, ID).unclassified).toBe(1);
  });

  it("a stored system prompt that is not exactly one string is unclassified", () => {
    write([...twoTurns, attachment("a9", "r2", { systemPrompt: [SYS, "second"] })]);
    expect(measureStoredSession(dir, ID).unclassified).toBe(1);
  });
});
