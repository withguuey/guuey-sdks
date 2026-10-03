/**
 * guuey#2120 — the thread snapshot is planned with the rows. A snapshot value
 * the store cannot hold is refused or left out BEFORE any row is written, so
 * the snapshot write after the rows never fails and never freezes the thread.
 *
 * Runs over `withItemSizeLimit(new InMemoryThreadPersistence())`, whose
 * `putSnapshot` rejects what DynamoDB rejects (an unsafe number, an item over
 * 400 KB), so a snapshot the store fails to plan fails here as in production.
 */
import { describe, expect, it } from "vitest";
import type { AgMemoryRecord, AgMessage, AgReduceResult, JsonValue } from "@silverprotocol/core";
import { DYNAMODB_ROW_BUDGET, planSnapshot, STORED_TURN_UNSTORABLE_NUMBER_CODE, ThreadStore, type ThreadRow } from "./index.js";
import { InMemoryThreadPersistence } from "./in-memory.js";
import { withItemSizeLimit } from "./testing/contract-suite.js";

function threadRow(id: string): ThreadRow {
  const now = "2026-10-03T00:00:00.000Z";
  return {
    id,
    userId: "g_abc",
    appId: "app_1",
    servingRegion: "us-east-1",
    title: "New thread",
    status: "active",
    pinned: false,
    lastSeq: 0,
    lastMessageAt: now,
    lastMessagePreview: "",
    threadMode: "single",
    createdAt: now,
    updatedAt: now,
  };
}

async function setup(limited = true) {
  const mem = new InMemoryThreadPersistence();
  const store = new ThreadStore(limited ? withItemSizeLimit(mem) : mem);
  await mem.createThread(threadRow("t1"));
  return { mem, store };
}

/** The issue's trigger: a JSON number past 2^53, as `JSON.parse` hands it over. */
const UNSAFE = Number("12345678901234567890");

function answer(turnId: string, text: string): AgMessage {
  return { id: `m_${turnId}`, role: "assistant", turnId, threadId: "t1", content: [{ type: "text", text }] };
}

function mem(key: string, value: JsonValue, turnId: string): AgMemoryRecord {
  return { scope: "thread", key, value, turnId };
}

function fold(turnId: string, state: JsonValue | undefined, memory: AgMemoryRecord[] = [], text = "ok"): AgReduceResult {
  return {
    messages: [answer(turnId, text)],
    artifacts: [],
    memory,
    turns: [{ turnId, threadId: "t1", finishReason: "stop" }],
    ...(state !== undefined ? { state } : {}),
  };
}

/** One turn the way the pod runs it: seeded from the stored snapshot, then persisted. */
async function turn(store: ThreadStore, turnId: string, state: JsonValue | undefined, memory: AgMemoryRecord[] = []) {
  const prior = await store.getSnapshot("t1");
  return store.appendFold({
    threadId: "t1",
    userId: "g_abc",
    fold: fold(turnId, state, memory),
    clientMessageIdBase: `cmid_${turnId}`,
    ...(prior?.workingState !== undefined ? { priorWorkingState: prior.workingState } : {}),
    ...(prior?.threadMemory.length ? { priorThreadMemory: prior.threadMemory } : {}),
    ...(prior?.carriedThreadMemory?.length ? { carriedThreadMemory: prior.carriedThreadMemory } : {}),
  });
}

describe("ThreadStore.appendFold plans the snapshot with the rows (guuey#2120)", () => {
  it("a state carrying Number('12345678901234567890') lands its rows AND a snapshot, and the next turn sees a state", async () => {
    const { mem, store } = await setup();
    await turn(store, "turn1", { step: 1 });

    const res = await turn(store, "turn2", { step: 2, id: UNSAFE });
    expect(res.messageSeqs).toEqual([2]);
    expect(res.unstorable).toBeUndefined();
    expect(res.refusedSnapshot).toEqual({ state: "number", memoryNumber: 0, memorySize: 0, notWritten: false });

    const snap = await store.getSnapshot("t1");
    expect(snap?.workingState).toEqual({ step: 1 });
    expect(snap?.lastTurnId).toBe("turn2");
    expect(mem.messages.map((m) => m.seq)).toEqual([1, 2]);

    // The thread is not frozen: the next turn reads a state and its own storable update lands.
    const next = await turn(store, "turn3", { step: 3 });
    expect(next.refusedSnapshot).toBeUndefined();
    expect((await store.getSnapshot("t1"))?.workingState).toEqual({ step: 3 });
  });

  it("a first turn whose state cannot be stored writes a snapshot without a state", async () => {
    const { store } = await setup();
    const res = await turn(store, "turn1", { id: UNSAFE }, [mem("k", "v", "turn1")]);
    expect(res.refusedSnapshot?.state).toBe("number");
    const snap = await store.getSnapshot("t1");
    expect(snap).toBeDefined();
    expect(snap?.workingState).toBeUndefined();
    expect(snap?.threadMemory).toEqual([mem("k", "v", "turn1")]);
  });

  it("leaves out a thread-memory record carrying a number the store cannot hold, and keeps the rest", async () => {
    const { store } = await setup();
    const res = await turn(store, "turn1", { step: 1 }, [mem("bad", { tiny: 1e-131 }, "turn1"), mem("good", 7, "turn1")]);
    expect(res.refusedSnapshot).toEqual({ memoryNumber: 1, memorySize: 0, notWritten: false });
    const snap = await store.getSnapshot("t1");
    expect(snap?.threadMemory).toEqual([mem("good", 7, "turn1")]);
    expect(snap?.workingState).toEqual({ step: 1 });
  });

  it("refuses a state over the row budget and keeps the prior one", async () => {
    const { store } = await setup();
    await turn(store, "turn1", { step: 1 });
    const res = await turn(store, "turn2", { blob: "x".repeat(500_000) });
    expect(res.refusedSnapshot).toEqual({ state: "size", memoryNumber: 0, memorySize: 0, notWritten: false });
    expect((await store.getSnapshot("t1"))?.workingState).toEqual({ step: 1 });
  });

  it("over the budget, leaves out this turn's largest memory records, never one stored unchanged", async () => {
    const { store } = await setup();
    await turn(store, "turn1", { step: 1 }, [mem("kept", "small", "turn1")]);
    const prior = await store.getSnapshot("t1");
    const res = await turn(store, "turn2", { step: 1 }, [
      ...(prior?.threadMemory ?? []),
      mem("big", "y".repeat(300_000), "turn2"),
      mem("bigger", "z".repeat(320_000), "turn2"),
    ]);
    expect(res.refusedSnapshot).toEqual({ memoryNumber: 0, memorySize: 1, notWritten: false });
    const keys = (await store.getSnapshot("t1"))?.threadMemory.map((r) => r.key);
    expect(keys).toEqual(["kept", "big"]);
  });

  it("keeps a small new state over a larger prior one, and leaves out only the one record it must", async () => {
    const { store } = await setup();
    await turn(store, "turn1", { blob: "p".repeat(300_000) });
    const res = await turn(store, "turn2", { blob: "n".repeat(10_000) }, [
      mem("big", "y".repeat(200_000), "turn2"),
      mem("next", "z".repeat(195_000), "turn2"),
    ]);
    expect(res.refusedSnapshot).toEqual({ memoryNumber: 0, memorySize: 1, notWritten: false });
    const snap = await store.getSnapshot("t1");
    expect(snap?.workingState).toEqual({ blob: "n".repeat(10_000) });
    expect(snap?.threadMemory.map((r) => r.key)).toEqual(["next"]);
  });

  it("writes no snapshot when it cannot fit even so: the prior snapshot stands and the rows land", async () => {
    const { mem: db, store } = await setup();
    await turn(store, "turn1", { step: 1 });
    const res = await store.appendFold({
      threadId: "t1",
      userId: "g_abc",
      fold: fold("turn2", { step: 1 }),
      clientMessageIdBase: "cmid_turn2",
      priorWorkingState: { step: 1 },
      carriedThreadMemory: ["c".repeat(400_000)],
    });
    expect(res.messageSeqs).toEqual([2]);
    expect(res.refusedSnapshot).toEqual({ memoryNumber: 0, memorySize: 0, notWritten: true });
    expect(db.snapshots.get("t1")?.lastTurnId).toBe("turn1");
  });

  it("the one-failure-row path writes the planned snapshot too", async () => {
    const { mem: db, store } = await setup();
    const f = fold("turn1", { id: UNSAFE });
    // A number outside any tool-call value (a tool result): the turn is stored as its one failure row.
    f.messages[0] = {
      ...f.messages[0]!,
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "found" }], structuredContent: { id: UNSAFE } }],
    };
    const res = await store.appendFold({
      threadId: "t1",
      userId: "g_abc",
      fold: f,
      clientMessageIdBase: "cmid_turn1",
      unstorableNotice: { text: "not stored" },
    });
    expect(res.unstorable?.reason).toBe("number");
    expect(res.refusedSnapshot?.state).toBe("number");
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]!.content).toMatchObject({ error: { code: STORED_TURN_UNSTORABLE_NUMBER_CODE } });
    expect(db.snapshots.get("t1")?.lastTurnId).toBe("turn1");
  });

  it("skipSnapshot still writes no snapshot", async () => {
    const { mem: db, store } = await setup();
    const res = await store.appendFold({
      threadId: "t1",
      userId: "g_abc",
      fold: fold("turn1", { id: UNSAFE }),
      clientMessageIdBase: "cmid_turn1",
      skipSnapshot: true,
    });
    expect(res.refusedSnapshot).toBeUndefined();
    expect(db.snapshots.size).toBe(0);
  });

  it("a binding with no row budget stores the snapshot as the fold made it", async () => {
    const { mem: db, store } = await setup(false);
    const res = await turn(store, "turn1", { id: UNSAFE });
    expect(res.refusedSnapshot).toBeUndefined();
    expect(db.snapshots.get("t1")?.workingState).toEqual({ id: UNSAFE });
  });
});

describe("planSnapshot", () => {
  const base = { threadId: "t1", userId: "g_abc", updatedAt: "2026-10-03T00:00:00.000Z", threadMemory: [] };

  it("returns the row as it is when everything fits", () => {
    const row = { ...base, workingState: { a: 1 } };
    expect(planSnapshot({ row }, DYNAMODB_ROW_BUDGET)).toEqual({ row });
  });

  it("leaves out a carried element carrying an unfit number", () => {
    const row = { ...base, carriedThreadMemory: [{ n: -1e-200 }, "ok"] };
    const planned = planSnapshot({ row }, DYNAMODB_ROW_BUDGET);
    expect(planned.row?.carriedThreadMemory).toEqual(["ok"]);
    expect(planned.refusal).toEqual({ memoryNumber: 1, memorySize: 0, notWritten: false });
  });

  it("does not report a size refusal of a state equal to the prior one", () => {
    const row = { ...base, workingState: { a: 1 }, carriedThreadMemory: ["c".repeat(400_000)] };
    const planned = planSnapshot({ row, priorWorkingState: { a: 1 } }, DYNAMODB_ROW_BUDGET);
    expect(planned).toEqual({ row: undefined, refusal: { memoryNumber: 0, memorySize: 0, notWritten: true } });
  });
});
