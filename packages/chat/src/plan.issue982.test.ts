/**
 * guuey#982 — the Playground's turn-1 answer rendered AFTER the turn-2 user
 * bubble. Real shapes from dev (QA, thread 4da2f0c1…, app qa-637-door):
 * both turns' SSE captures replayed through the REAL `invokeTurn` into ONE
 * `@silverprotocol/core` Reducer (session continuity), the flat side built
 * from the REAL persisted rows through the REST history mapping. Every
 * phase the live hook can be in is planned and its slot layout asserted:
 * user bubbles and assistant slots must alternate 1:1 in conversational
 * order — a third assistant slot against two users IS the founder's DOM.
 *
 * RED on the pre-#982 seam at phase P6 (persisted rows of the in-flight
 * turn already on the flat side while the fold still holds it live):
 * `u0 a0[text,text] u1 a1[…turn-1 tools/text…] a2[text]`. The `layout`
 * helper stays for the next investigator — print it when a phase fails.
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

const rowsJson = JSON.parse(readFileSync(join(CAPTURES, "issue982-messages.json"), "utf8")) as { rows: Parameters<typeof threadHistoryRowsToMessages>[0] };
const ROWS = rowsJson.rows;
const rowsUpTo = (seq: number) => ROWS.filter((r) => r.seq <= seq);
const U1: TranscriptMessage = { role: "user", text: ROWS[0]!.text ?? "", clientMessageId: "cm-1" };
const U2: TranscriptMessage = { role: "user", text: "Reply with exactly: ack", clientMessageId: "cm-2" };

function inputs(over: Partial<TranscriptInputs> & Pick<TranscriptInputs, "messages" | "result" | "status">): TranscriptInputs {
  return { assistantText: "", statusElapsedMs: 0, activeTool: null, error: null, prompts: [], ...over };
}

/** `u0 a0[tool,tool,text] u1 a1[text]` — slots in item order, assistant content by kind. */
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
const assistantSlots = (items: DisplayItem[]) =>
  Array.from(new Set(items.map((i) => /^a(\d+)\./.exec(i.key)?.[1]).filter((s): s is string => s !== undefined)));

describe("guuey#982 — two real turns, every hook phase", async () => {
  const t1 = await replay("issue982-turn1.sse.txt");
  const t2 = await replay("issue982-turn2.sse.txt");
  const calm = calmPolicy();

  const phases: Array<{ name: string; build: () => TranscriptInputs }> = [
    { name: "P1 live only: optimistic u1,u2 + fold(t1,t2), ready", build: () => { const f = { reducer: new Reducer(), assistantText: "" }; pushTurn(f, t1); pushTurn(f, t2); return inputs({ messages: [U1, U2], result: f.reducer.result(), status: "ready" }); } },
    { name: "P2 history adopted after t1 (rows 1..9) + optimistic u2, fold(t1) only, t2 thinking", build: () => { const f = { reducer: new Reducer(), assistantText: "" }; pushTurn(f, t1); return inputs({ messages: [...threadHistoryRowsToMessages(rowsUpTo(9)), U2], historyCards: threadHistoryRowsToCards(rowsUpTo(9)), result: f.reducer.result(), status: "thinking" }); } },
    { name: "P3 history adopted after t1 + optimistic u2, fold(t1,t2), ready", build: () => { const f = { reducer: new Reducer(), assistantText: "" }; pushTurn(f, t1); pushTurn(f, t2); return inputs({ messages: [...threadHistoryRowsToMessages(rowsUpTo(9)), U2], historyCards: threadHistoryRowsToCards(rowsUpTo(9)), result: f.reducer.result(), status: "ready" }); } },
    { name: "P4 full history (rows 1..11) + fold(t1,t2), ready", build: () => { const f = { reducer: new Reducer(), assistantText: "" }; pushTurn(f, t1); pushTurn(f, t2); return inputs({ messages: threadHistoryRowsToMessages(ROWS), historyCards: threadHistoryRowsToCards(ROWS), result: f.reducer.result(), status: "ready" }); } },
    { name: "P5 full history + fold(t1,t2 WITHOUT turn.done), ready (stream cut, status back)", build: () => { const f = { reducer: new Reducer(), assistantText: "" }; pushTurn(f, t1); pushTurn(f, t2, { dropTurnDone: true }); return inputs({ messages: threadHistoryRowsToMessages(ROWS), historyCards: threadHistoryRowsToCards(ROWS), result: f.reducer.result(), status: "ready" }); } },
    { name: "P6 full history + fold(t1, t2 without turn.done), thinking (the race: rows landed, stream not yet done)", build: () => { const f = { reducer: new Reducer(), assistantText: "" }; pushTurn(f, t1); pushTurn(f, t2, { dropTurnDone: true }); return inputs({ messages: threadHistoryRowsToMessages(ROWS), historyCards: threadHistoryRowsToCards(ROWS), result: f.reducer.result(), status: "thinking" }); } },
    { name: "P7 history adopted after t1 + optimistic u2, fold(t1) + t2 live, ABORTED", build: () => { const f = { reducer: new Reducer(), assistantText: "" }; pushTurn(f, t1); pushTurn(f, t2, { dropTurnDone: true }); return inputs({ messages: [...threadHistoryRowsToMessages(rowsUpTo(9)), U2], historyCards: threadHistoryRowsToCards(rowsUpTo(9)), result: f.reducer.result(), status: "ready", aborted: true }); } },
    { name: "P8 reload: history rows only, no fold", build: () => inputs({ messages: threadHistoryRowsToMessages(ROWS), historyCards: threadHistoryRowsToCards(ROWS), result: null, status: "ready" }) },
  ];

  it.each(phases)("$name — one assistant slot per user, in order", ({ build }) => {
    const plan = planTranscript(build(), calm);
    const lay = layout(plan.items);
    const u = users(plan.items);
    const a = assistantSlots(plan.items);
    expect(u, lay).toEqual(["u0", "u1"]);
    expect(a.length, lay).toBeLessThanOrEqual(2);
    // Conversational order: u0 … (a0) … u1 … (a1) — nothing of slot 0 after u1.
    const idxU1 = plan.items.findIndex((i) => i.key === "u1");
    const lastA0 = plan.items.reduce((acc, i, idx) => (/^a0\./.test(i.key) ? idx : acc), -1);
    expect(lastA0, lay).toBeLessThan(idxU1);
  });
});
