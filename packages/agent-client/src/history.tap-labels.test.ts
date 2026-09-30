/**
 * guuey#2031 — the history mapper carries a card-action user row's tap labels,
 * under the READER contract (shape only), in both rolling-release orders:
 *
 *  - an OLDER read plane serves the doorbell row without the field: the mapped
 *    message has no `tapLabels` key (the planner draws the continuation row);
 *  - a read plane that projects the stored labels serves them: the mapped
 *    message carries them, entry for entry;
 *  - a value no writer could have produced, or labels on an agent row, map to
 *    nothing — never a guess.
 *
 * The rows are SYNTHETIC (`fixtures/history-rows.card-tap.synthetic.json`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { threadHistoryRowsToMessages, type ThreadHistoryRow } from "./history.js";

const FIXTURE: { rows: ThreadHistoryRow[] } = JSON.parse(
  readFileSync(new URL("./fixtures/history-rows.card-tap.synthetic.json", import.meta.url), "utf8"),
);

function mapped(seq: number) {
  const row = FIXTURE.rows.find((r) => r.seq === seq);
  if (row === undefined) throw new Error(`fixture: no row ${seq}`);
  return threadHistoryRowsToMessages([row])[0];
}

describe("threadHistoryRowsToMessages — tap labels on a card-action user row", () => {
  it("a read plane that projects the labels: the user message carries them, nulls in place", () => {
    expect(mapped(7)).toMatchObject({ role: "user", seq: 7, tapLabels: ["What are your opening hours?", null] });
  });

  it("an older read plane (no field): the same doorbell row maps exactly as before, with no tapLabels key", () => {
    const message = mapped(5);
    expect(message).toMatchObject({ role: "user", seq: 5 });
    expect(Object.keys(message ?? {})).not.toContain("tapLabels");
  });

  it("a malformed value, or labels on an agent row, map to nothing", () => {
    expect(Object.keys(mapped(9) ?? {})).not.toContain("tapLabels");
    expect(mapped(10)).toMatchObject({ role: "assistant" });
    expect(Object.keys(mapped(10) ?? {})).not.toContain("tapLabels");
  });

  it("the reader is shape-only: a label longer than today's writer bound is still carried", () => {
    const long = "a".repeat(300);
    const [message] = threadHistoryRowsToMessages([{ seq: 1, at: "x", kind: "text", authorRole: "user", text: "<ggui_directive", tapLabels: [long] }]);
    expect(message?.tapLabels).toEqual([long]);
  });

  it("the whole synthetic thread maps in order, the text of every row unchanged", () => {
    const messages = threadHistoryRowsToMessages(FIXTURE.rows);
    expect(messages.map((m) => m.text)).toEqual(FIXTURE.rows.map((r) => r.text));
  });
});
