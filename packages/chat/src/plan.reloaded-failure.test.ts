/**
 * A reloaded thread draws a failed turn and a framework notice the way the live
 * transcript drew them: as notice rows in their place, never as the agent's
 * words. The rows arrive from `@guuey/agent-client`'s history mapping as
 * `role: "notice"` messages; a failed turn's carries `failure`.
 */
import { describe, expect, it } from "vitest";
import { transcriptInputsFromHistory } from "./history-inputs.js";
import { planTranscript } from "./plan.js";
import { calmPolicy, debugPolicy } from "./policy.js";
import type { AgentMessage } from "@guuey/agent-client";
import type { DisplayItem, NoticeItem } from "./types.js";

// A history read carries agent-client's rows, exactly what the loader maps.
const plan = (messages: AgentMessage[], policy = calmPolicy()) =>
  planTranscript(transcriptInputsFromHistory({ messages }), policy).items;
const kinds = (items: DisplayItem[]) => items.map((i) => (i.kind === "notice" ? `notice:${i.text}` : i.kind));
const notices = (items: DisplayItem[]) => items.filter((i): i is NoticeItem => i.kind === "notice");

describe("reloaded failed turns and notices (guuey#1880 / guuey#1890)", () => {
  it("a withheld reply reloads as its coded notice where the bubble was, in the live error's words, with no Retry", () => {
    const strings = calmPolicy().strings;
    const items = plan([
      { role: "user", text: "tell me", seq: 1 },
      { role: "notice", text: "The reply was withheld.", seq: 2, failure: { code: "CONTENT_BLOCKED" } },
      { role: "user", text: "and now?", seq: 3 },
      { role: "assistant", text: "Here it is.", seq: 4 },
    ]);
    const [n] = notices(items);
    expect(n).toMatchObject({ text: strings.errorContentBlocked, failure: { code: "CONTENT_BLOCKED" } });
    // In its place (after its user turn), and nothing trailing: no error item, so no Retry.
    expect(items.some((i) => i.kind === "error")).toBe(false);
    const order = kinds(items);
    expect(order.indexOf(`notice:${strings.errorContentBlocked}`)).toBeLessThan(order.lastIndexOf("user"));
  });

  it("NO_REPLY gets its own line; a row stored before codes gets the family's; a host's per-code copy still wins", () => {
    const strings = calmPolicy().strings;
    const turn = (failure: { code: string | null }): AgentMessage[] => [
      { role: "user", text: "q", seq: 1 },
      { role: "notice", text: "Something went wrong on our side while writing this reply.", seq: 2, failure },
    ];
    expect(notices(plan(turn({ code: "NO_REPLY" })))[0]!.text).toBe(strings.errorNoReply);
    expect(notices(plan(turn({ code: null })))[0]!.text).toBe(strings.errorTransient);
    const hosted = calmPolicy({ error: { verbatim: false, copyByCode: { NO_REPLY: "Nothing came back." }, verbatimCodes: [] } });
    expect(notices(plan(turn({ code: "NO_REPLY" }), hosted))[0]!.text).toBe("Nothing came back.");
  });

  it("a framework notice reloads as a notice with its source, its own text, and no failure", () => {
    const items = plan([
      { role: "user", text: "q", seq: 1 },
      { role: "notice", text: "safeguards stopped the response above", seq: 2, noticeSource: "framework" },
    ], debugPolicy());
    expect(notices(items)).toEqual([
      expect.objectContaining({ text: "safeguards stopped the response above", source: "framework", sourceLabel: "framework" }),
    ]);
    expect(notices(items)[0]).not.toHaveProperty("failure");
  });

  it("a host that hides notices still sees a failed turn (the live error always shows); a plain notice stays hidden", () => {
    const hidden = calmPolicy({ notice: { show: false } });
    const items = plan([
      { role: "user", text: "q", seq: 1 },
      { role: "notice", text: "safeguards stopped the response above", seq: 2, noticeSource: "framework" },
      { role: "user", text: "q2", seq: 3 },
      { role: "notice", text: "The reply was withheld.", seq: 4, failure: { code: "CONTENT_BLOCKED" } },
    ], hidden);
    expect(notices(items).map((n) => n.failure?.code ?? null)).toEqual(["CONTENT_BLOCKED"]);
  });

  it("RED control: the same rows as an older read plane sent them (no marks) stay assistant bubbles", () => {
    const items = plan([
      { role: "user", text: "tell me", seq: 1 },
      { role: "assistant", text: "The reply was withheld.", seq: 2 },
    ]);
    expect(notices(items)).toEqual([]);
  });
});
