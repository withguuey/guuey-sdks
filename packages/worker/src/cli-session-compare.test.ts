import { describe, expect, it } from "vitest";
import { compareStoredSession, type CliSessionRecord } from "./cli-session-compare.js";
import type { HelloStoredMeasures } from "./protocol.js";

const ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const OTHER = "11111111-1111-4111-8111-111111111111";
const HI = "b".repeat(64);
const EARLIER = "c".repeat(64);
const RECORD: CliSessionRecord = { id: ID, lastPromptSha: HI };

function stored(over: Partial<HelloStoredMeasures> = {}): HelloStoredMeasures {
  return {
    systemPromptShas: ["a".repeat(64)],
    walks: [],
    lastPromptShas: [EARLIER, HI],
    sessionIds: [ID],
    entries: [`${ID}.jsonl`],
    unclassified: 0,
    corrupt: 0,
    benignDuplicates: 0,
    filePromptEntries: 2,
    fileCompactSummaries: 0,
    ...over,
  };
}

describe("compareStoredSession", () => {
  it("vouches for an intact file of this session whose last prompt is the recorded one", () => {
    expect(compareStoredSession(RECORD, stored())).toEqual({ ok: true });
  });

  it("refuses another session's file even when its last prompt is byte-equal (the equal-prompt case, cto D1)", () => {
    expect(compareStoredSession(RECORD, stored({ sessionIds: [OTHER] }))).toEqual({ ok: false, reason: "other-session" });
    expect(compareStoredSession(RECORD, stored({ sessionIds: [ID, OTHER] }))).toEqual({ ok: false, reason: "other-session" });
  });

  it("refuses a file whose own identity was not measured (an older host, or a file with no session id)", () => {
    const { sessionIds: _ids, ...older } = stored();
    expect(compareStoredSession(RECORD, older)).toEqual({ ok: false, reason: "no-session-ids" });
    expect(compareStoredSession(RECORD, stored({ sessionIds: [] }))).toEqual({ ok: false, reason: "no-session-ids" });
  });

  it("refuses a file cut short or rolled back: its last prompt is an earlier one", () => {
    expect(compareStoredSession(RECORD, stored({ lastPromptShas: [EARLIER] }))).toEqual({ ok: false, reason: "last-prompt-differs" });
    expect(compareStoredSession(RECORD, stored({ lastPromptShas: [] }))).toEqual({ ok: false, reason: "no-last-prompt" });
  });

  it.each([
    ["unreadable", { readError: "missing" as const }],
    ["corrupt", { corrupt: 1 }],
    ["unclassified", { unclassified: 2 }],
  ])("refuses a %s file before anything else", (reason, over) => {
    expect(compareStoredSession(RECORD, stored(over))).toEqual({ ok: false, reason });
  });
});
