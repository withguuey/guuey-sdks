/**
 * guuey#1101 — after an abort-then-send reply, the RELOADED transcript
 * rendered `u0 → "Bye!" → card → u1`: turn 2's answer before turn 1's card
 * and before its own bubble. Real shapes from dev PIN C (QA, thread
 * 1a0cfa3c…, app 90cd2971… whose brief mandates `ggui_consume`): turn 1
 * streamed and CUT mid-`ggui_consume` (the client's abort), turn 2 sent on
 * ready, and the persisted rows read back through the REST history mapping.
 *
 * The persisted order is RIGHT (u0 → five agent text rows → card → u1 →
 * "Bye!"). The five agent rows of the aborted turn carry NO text, so the
 * history mapping drops them — and the flat seam, which grouped assistant
 * rows by adjacency, then saw ONE assistant group for TWO user turns and
 * paired "Bye!" with u0. The seam is anchored on user turns since #982; the
 * flat grouping must be too: a closed user turn with no assistant rows is
 * an EMPTY slot, never a vanished one.
 *
 * `layout` (from plan.issue982.test.ts) prints the slot picture when a
 * phase fails.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Reducer } from "@silverprotocol/core";
import { invokeTurn, type InvokeTurnEvent } from "@guuey/agent-client";
import { threadHistoryRowsToCards, threadHistoryRowsToMessages } from "@guuey/agent-client";
import { calmPolicy } from "./policy.js";
import { planTranscript } from "./plan.js";
import type { DisplayItem, TranscriptInputs, TranscriptMessage } from "./types.js";

const CAPTURES = join(dirname(fileURLToPath(import.meta.url)), "corpus", "captures");

async function replay(file: string): Promise<InvokeTurnEvent[]> {
  const text = readFileSync(join(CAPTURES, file), "utf8");
  const transport = async function* (): AsyncGenerator<string> {
    for (let at = 0; at < text.length; at += 512) yield text.slice(at, at + 512);
  };
  const events: InvokeTurnEvent[] = [];
  const req = { url: "https://capture.replay.invalid/agent/invoke", body: { input: "replay" }, signal: new AbortController().signal };
  for await (const ev of invokeTurn(req, transport)) events.push(ev);
  return events;
}

interface Fold { reducer: Reducer; assistantText: string }
function pushTurn(fold: Fold, events: InvokeTurnEvent[], opts: { dropTurnDone?: boolean } = {}): void {
  for (const ev of events) {
    if (ev.kind !== "message") continue;
    fold.assistantText = ev.assistantText;
    for (const ag of ev.agEvents) {
      if (opts.dropTurnDone && ag.type === "turn.done") continue;
      fold.reducer.push(ag);
    }
  }
}

const rowsJson = JSON.parse(readFileSync(join(CAPTURES, "issue1101-messages.json"), "utf8")) as { rows: Parameters<typeof threadHistoryRowsToMessages>[0] };
const ROWS = rowsJson.rows;
const rowsUpTo = (seq: number) => ROWS.filter((r) => r.seq <= seq);
const U1: TranscriptMessage = { role: "user", text: ROWS[0]!.text ?? "", clientMessageId: "cm-1" };
const U2: TranscriptMessage = { role: "user", text: "done — just say bye", clientMessageId: "cm-2" };

function inputs(over: Partial<TranscriptInputs> & Pick<TranscriptInputs, "messages" | "result" | "status">): TranscriptInputs {
  return { assistantText: "", statusElapsedMs: 0, activeTool: null, error: null, prompts: [], ...over };
}

function layout(items: DisplayItem[]): string {
  const out: string[] = [];
  let openSlot: string | null = null;
  let kinds: string[] = [];
  const flush = (): void => {
    if (openSlot !== null) out.push(`${openSlot}[${kinds.join(",")}]`);
    openSlot = null;
    kinds = [];
  };
  for (const it of items) {
    if (it.kind === "user") {
      flush();
      out.push(it.key);
      continue;
    }
    if (/^card\./.test(it.key)) {
      flush();
      out.push(it.key);
      continue;
    }
    const slotMatch = /^a(\d+)\./.exec(it.key);
    const slot: string = slotMatch ? `a${slotMatch[1]}` : (openSlot ?? "a?");
    if (slot !== openSlot) {
      flush();
      openSlot = slot;
    }
    kinds.push(it.kind === "tool-group" ? "tools" : it.kind);
  }
  flush();
  return out.join(" ");
}

const users = (items: DisplayItem[]) => items.filter((i) => i.kind === "user").map((i) => i.key);
const idxOf = (items: DisplayItem[], pred: (i: DisplayItem) => boolean) => items.findIndex(pred);

describe("guuey#1101 — abort-then-send, every phase the transcript passes through", async () => {
  const t1 = await replay("issue1101-turn1.sse.txt");
  const t2 = await replay("issue1101-turn2.sse.txt");
  const calm = calmPolicy();

  it("the capture is what the row says: turn 1 has no turn.done (the abort), the aborted turn's persisted agent rows carry no text", () => {
    expect(t1.some((e) => e.kind === "message" && e.agEvents.some((a) => a.type === "turn.done"))).toBe(false);
    expect(t2.some((e) => e.kind === "message" && e.agEvents.some((a) => a.type === "turn.done"))).toBe(true);
    const agentRowsOfTurn1 = ROWS.filter((r) => r.seq >= 2 && r.seq <= 6);
    expect(agentRowsOfTurn1).toHaveLength(5);
    expect(agentRowsOfTurn1.every((r) => r.kind === "text" && (r.text == null || r.text === ""))).toBe(true);
    // The mapping drops them — the premise of the seam rule below.
    expect(threadHistoryRowsToMessages(ROWS).map((m) => m.role)).toEqual(["user", "user", "assistant"]);
  });

  const phases: Array<{ name: string; build: () => TranscriptInputs; card: boolean }> = [
    { name: "P1 live: u1 + fold(t1 cut), ABORTED, ready", card: false, build: () => { const f = { reducer: new Reducer(), assistantText: "" }; pushTurn(f, t1, { dropTurnDone: true }); return inputs({ messages: [U1], result: f.reducer.result(), status: "ready", aborted: true }); } },
    { name: "P2 live: u1,u2 + fold(t1 cut, t2), ready", card: false, build: () => { const f = { reducer: new Reducer(), assistantText: "" }; pushTurn(f, t1, { dropTurnDone: true }); pushTurn(f, t2); return inputs({ messages: [U1, U2], result: f.reducer.result(), status: "ready" }); } },
    { name: "P3 history through turn 1 (rows 1..7) + optimistic u2, fold(t1 cut, t2), ready", card: true, build: () => { const f = { reducer: new Reducer(), assistantText: "" }; pushTurn(f, t1, { dropTurnDone: true }); pushTurn(f, t2); return inputs({ messages: [...threadHistoryRowsToMessages(rowsUpTo(7)), U2], historyCards: threadHistoryRowsToCards(rowsUpTo(7)), result: f.reducer.result(), status: "ready" }); } },
    { name: "P4 full history (rows 1..9) + fold(t1 cut, t2), ready", card: true, build: () => { const f = { reducer: new Reducer(), assistantText: "" }; pushTurn(f, t1, { dropTurnDone: true }); pushTurn(f, t2); return inputs({ messages: threadHistoryRowsToMessages(ROWS), historyCards: threadHistoryRowsToCards(ROWS), result: f.reducer.result(), status: "ready" }); } },
    { name: "P8 reload: history rows only, no fold (QA's DOM)", card: true, build: () => inputs({ messages: threadHistoryRowsToMessages(ROWS), historyCards: threadHistoryRowsToCards(ROWS), result: null, status: "ready" }) },
  ];

  it.each(phases)("$name — one slot per user turn, in order: u0 < (card) < u1 < a1", ({ build, card }) => {
    const built = build();
    const plan = planTranscript(built, calm);
    const lay = layout(plan.items);
    const expectedUsers = built.messages.filter((m) => m.role === "user").map((_, i) => `u${i}`);
    expect(users(plan.items), lay).toEqual(expectedUsers);
    // Live view items are keyed by their scope, history cards by `card.<seq>`
    // — "the card" is the first view item either way.
    const iCard = idxOf(plan.items, (i) => i.kind === "view");
    if (card) expect(iCard, lay).toBeGreaterThan(-1);
    if (expectedUsers.length < 2) return;
    const iU1 = idxOf(plan.items, (i) => i.key === "u1");
    // Nothing of slot 0 after u1 — and slot 0 is turn 1's, never "Bye!".
    const lastA0 = plan.items.reduce((acc, i, idx) => (/^a0\./.test(i.key) ? idx : acc), -1);
    expect(lastA0, lay).toBeLessThan(iU1);
    const bye = idxOf(plan.items, (i) => i.kind === "text" && i.text === "Bye!");
    expect(bye, lay).toBeGreaterThan(iU1);
    if (card) expect(iCard, lay).toBeLessThan(iU1);
  });
});
