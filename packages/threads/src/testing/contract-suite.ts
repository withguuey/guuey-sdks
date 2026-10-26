/**
 * Binding-agnostic behavioral contract for {@link ThreadPersistencePort}.
 * Every binding (in-memory here, guuey's hosted DynamoDB binding, your
 * own store) runs this SAME suite so "works in-memory" and "works on the
 * real thing" mean the same set of guarantees — the `@guuey/state`
 * contract-suite pattern (guuey#107).
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@silverprotocol/core";
import type { ThreadPersistencePort, ThreadRow } from "../rows.js";
import { ThreadClosedError, threadClosure } from "../closed.js";
import { DYNAMODB_ITEM_LIMIT_BYTES, DYNAMODB_ROW_BUDGET, dynamoItemBytes, dynamoNumberFits } from "../item-size.js";
import { DEFAULT_THREAD_TITLE, TITLE_MAX_ATTEMPTS, TITLE_MAX_GENERATIONS, type TitleWrite } from "../title.js";

export interface ThreadPersistenceHarness {
  port: ThreadPersistencePort;
  cleanup?: () => void | Promise<void>;
}

/** What the binding under test claims beyond the required port. */
export interface ThreadPersistenceContractOptions {
  /**
   * The binding implements `closeThread`: the suite then requires it and
   * holds it to the close contract (a closure is recorded once, and a closed
   * thread allocates no seq).
   */
  canClose?: boolean;
  /**
   * The binding implements `writeTitle` (guuey#2612): the suite then requires
   * it and holds it to the title contract — a claim takes its checkpoint and
   * one attempt in one conditional write, a record lands only on the claim it
   * answers, a set title wins, and the per-thread bounds hold.
   */
  canTitle?: boolean;
}

function threadRow(id: string): ThreadRow {
  const now = "2026-08-07T00:00:00.000Z";
  return {
    id,
    userId: "g_contract",
    appId: "app_contract",
    servingRegion: "test-region",
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

async function withHarness(
  make: () => Promise<ThreadPersistenceHarness>,
  fn: (port: ThreadPersistencePort) => Promise<void>,
): Promise<void> {
  const h = await make();
  try {
    await fn(h.port);
  } finally {
    await h.cleanup?.();
  }
}

/**
 * Run the port contract against a binding. `make` must yield a FRESH,
 * empty store per call.
 */
export function runThreadPersistenceContractSuite(
  name: string,
  make: () => Promise<ThreadPersistenceHarness>,
  options: ThreadPersistenceContractOptions = {},
): void {
  describe(`ThreadPersistencePort contract — ${name}`, () => {
    if (options.canClose === true) {
      const closure = { code: "app:CHAT_FULL", message: "This chat is full.", at: "2026-08-07T00:00:05.000Z" };

      it("closeThread records the closure once; a second close is already_closed; a missing thread rejects", async () => {
        await withHarness(make, async (port) => {
          expect(port.closeThread).toBeTypeOf("function");
          if (port.closeThread === undefined) return;
          await port.createThread(threadRow("t1"));
          expect(await port.closeThread("t1", closure)).toBe("closed");
          expect(await port.closeThread("t1", { ...closure, code: "app:OTHER" })).toBe("already_closed");
          const t = await port.getThread("t1");
          expect(t && threadClosure(t)).toEqual(closure);
          // Closing is not archiving: the status the thread had is kept.
          expect(t?.status).toBe("active");
          await expect(port.closeThread("t-missing", closure)).rejects.toThrow();
        });
      });

      it("incrementSeq on a closed thread rejects with ThreadClosedError and allocates no seq", async () => {
        await withHarness(make, async (port) => {
          if (port.closeThread === undefined) throw new Error("canClose binding has no closeThread");
          await port.createThread(threadRow("t1"));
          expect(await port.incrementSeq("t1", "before", "2026-08-07T00:00:01.000Z")).toBe(1);
          await port.closeThread("t1", closure);
          await expect(port.incrementSeq("t1", "after", "2026-08-07T00:00:06.000Z")).rejects.toBeInstanceOf(ThreadClosedError);
          await expect(port.incrementSeq("t1", null, "2026-08-07T00:00:06.000Z")).rejects.toBeInstanceOf(ThreadClosedError);
          const t = await port.getThread("t1");
          expect(t?.lastSeq).toBe(1);
          expect(t?.lastMessagePreview).toBe("before");
        });
      });

      it("incrementSeq on a missing thread still rejects with something other than ThreadClosedError", async () => {
        await withHarness(make, async (port) => {
          const err = await port.incrementSeq("t-missing", "p", "2026-08-07T00:00:01.000Z").catch((e: unknown) => e);
          expect(err).toBeInstanceOf(Error);
          expect(err).not.toBeInstanceOf(ThreadClosedError);
        });
      });
    }

    if (options.canTitle === true) {
      describeTitleContract(make);
    }

    it("creates and point-reads a thread; unknown ids read undefined", async () => {
      await withHarness(make, async (port) => {
        await port.createThread(threadRow("t1"));
        expect((await port.getThread("t1"))?.id).toBe("t1");
        expect(await port.getThread("t-missing")).toBeUndefined();
      });
    });

    it("rejects creating a thread id twice (conditional create)", async () => {
      await withHarness(make, async (port) => {
        await port.createThread(threadRow("t1"));
        await expect(port.createThread(threadRow("t1"))).rejects.toThrow();
      });
    });

    it("incrementSeq is monotonic from 1 and echoes the new value", async () => {
      await withHarness(make, async (port) => {
        await port.createThread(threadRow("t1"));
        expect(await port.incrementSeq("t1", "one", "2026-08-07T00:00:01.000Z")).toBe(1);
        expect(await port.incrementSeq("t1", "two", "2026-08-07T00:00:02.000Z")).toBe(2);
        const t = await port.getThread("t1");
        expect(t?.lastSeq).toBe(2);
        expect(t?.lastMessagePreview).toBe("two");
      });
    });

    it("incrementSeq(null) allocates the seq WITHOUT touching the preview", async () => {
      await withHarness(make, async (port) => {
        await port.createThread(threadRow("t1"));
        await port.incrementSeq("t1", "kept preview", "2026-08-07T00:00:01.000Z");
        expect(await port.incrementSeq("t1", null, "2026-08-07T00:00:02.000Z")).toBe(2);
        const t = await port.getThread("t1");
        expect(t?.lastMessagePreview).toBe("kept preview");
        expect(t?.lastMessageAt).toBe("2026-08-07T00:00:02.000Z");
      });
    });

    it("incrementSeq on a missing thread rejects (conditional update)", async () => {
      await withHarness(make, async (port) => {
        await expect(port.incrementSeq("t-missing", "p", "2026-08-07T00:00:01.000Z")).rejects.toThrow();
      });
    });

    it("putMessage rejects a duplicate (threadId, seq)", async () => {
      await withHarness(make, async (port) => {
        await port.createThread(threadRow("t1"));
        const row = {
          threadId: "t1",
          seq: 1,
          userId: "g_contract",
          clientMessageId: "c1",
          at: "2026-08-07T00:00:01.000Z",
          kind: "text" as const,
          authorRole: "user" as const,
          text: "hello",
        };
        await port.putMessage(row);
        await expect(port.putMessage({ ...row, clientMessageId: "c2" })).rejects.toThrow();
      });
    });

    it("listRecentMessages returns the most-recent `limit` rows in seq-ASC order", async () => {
      await withHarness(make, async (port) => {
        await port.createThread(threadRow("t1"));
        for (let seq = 1; seq <= 5; seq++) {
          await port.putMessage({
            threadId: "t1",
            seq,
            userId: "g_contract",
            clientMessageId: `c${seq}`,
            at: `2026-08-07T00:00:0${seq}.000Z`,
            kind: "text",
            authorRole: seq % 2 ? "user" : "agent",
            text: `m${seq}`,
          });
        }
        const rows = await port.listRecentMessages("t1", 3);
        expect(rows.map((r) => r.seq)).toEqual([3, 4, 5]);
      });
    });

    it("a card row round-trips cardSnapshot + toolName; absence stays absent (guuey#402)", async () => {
      await withHarness(make, async (port) => {
        await port.createThread(threadRow("t1"));
        const base = {
          threadId: "t1",
          userId: "g_contract",
          at: "2026-08-07T00:00:01.000Z",
          kind: "card" as const,
          authorRole: "agent" as const,
          cardSnapshot: { artifactId: "a1", turnId: "turn1", parts: [] },
        };
        await port.putMessage({ ...base, seq: 1, clientMessageId: "c1", toolName: "render" });
        await port.putMessage({ ...base, seq: 2, clientMessageId: "c2" });
        const rows = await port.listRecentMessages("t1", 5);
        expect(rows[0]?.toolName).toBe("render");
        expect(rows[0]?.cardSnapshot).toEqual(base.cardSnapshot);
        // A pre-#402 row must come back WITHOUT the key materialized.
        expect(rows[1] && "toolName" in rows[1]).toBe(false);
      });
    });

    it("findByClientMessageId resolves the idempotency key within its thread only", async () => {
      await withHarness(make, async (port) => {
        await port.createThread(threadRow("t1"));
        await port.createThread(threadRow("t2"));
        await port.putMessage({
          threadId: "t1",
          seq: 1,
          userId: "g_contract",
          clientMessageId: "shared-key",
          at: "2026-08-07T00:00:01.000Z",
          kind: "text",
          authorRole: "user",
          text: "hello",
        });
        expect((await port.findByClientMessageId("t1", "shared-key"))?.seq).toBe(1);
        expect(await port.findByClientMessageId("t2", "shared-key")).toBeUndefined();
        expect(await port.findByClientMessageId("t1", "unknown")).toBeUndefined();
      });
    });

    it("snapshot upsert is full-replace and point-readable", async () => {
      await withHarness(make, async (port) => {
        await port.createThread(threadRow("t1"));
        expect(await port.getSnapshot("t1")).toBeUndefined();
        await port.putSnapshot({
          threadId: "t1",
          userId: "g_contract",
          threadMemory: [{ scope: "thread", key: "k", value: "v1" }],
          workingState: { step: 1 },
          updatedAt: "2026-08-07T00:00:01.000Z",
        });
        await port.putSnapshot({
          threadId: "t1",
          userId: "g_contract",
          threadMemory: [],
          updatedAt: "2026-08-07T00:00:02.000Z",
        });
        const snap = await port.getSnapshot("t1");
        expect(snap?.threadMemory).toEqual([]);
        expect(snap?.workingState).toBeUndefined();
      });
    });

    it("carried thread memory round-trips unchanged beside the readable records", async () => {
      await withHarness(make, async (port) => {
        await port.createThread(threadRow("t1"));
        // Elements this runtime cannot read or does not own: an unknown scope,
        // a record with no value, a readable record of another scope.
        const carried: JsonValue[] = [
          { scope: "team", key: "plan", value: { tier: "pro" } },
          { scope: "thread", key: "orphan" },
          { scope: "user", key: "name", value: "Ada" },
        ];
        await port.putSnapshot({
          threadId: "t1",
          userId: "g_contract",
          threadMemory: [{ scope: "thread", key: "k", value: "v1" }],
          carriedThreadMemory: carried,
          updatedAt: "2026-08-07T00:00:03.000Z",
        });
        const snap = await port.getSnapshot("t1");
        expect(snap?.threadMemory).toEqual([{ scope: "thread", key: "k", value: "v1" }]);
        expect(JSON.stringify(snap?.carriedThreadMemory)).toBe(JSON.stringify(carried));
      });
    });
  });
}

const TITLE_AT = "2026-08-07T00:01:00.000Z";
const OWNER = "g_contract";

function claim(checkpoint: number, at: string = TITLE_AT): TitleWrite {
  return { kind: "claim", checkpoint, at };
}

function record(checkpoint: number, title: string, extra: { sourceSeq?: number; language?: string; at?: string } = {}): TitleWrite {
  return {
    kind: "record",
    checkpoint,
    title,
    sourceSeq: extra.sourceSeq ?? checkpoint,
    ...(extra.language !== undefined ? { language: extra.language } : {}),
    at: extra.at ?? TITLE_AT,
  };
}

function setTitle(title: string | null, userId: string = OWNER, at: string = TITLE_AT): TitleWrite {
  return { kind: "set", userId, title, at };
}

/** The port's `writeTitle`, required: a binding that claims `canTitle` must carry it. */
function titleWriter(port: ThreadPersistencePort): NonNullable<ThreadPersistencePort["writeTitle"]> {
  const write = port.writeTitle;
  if (write === undefined) throw new Error("a canTitle binding has no writeTitle");
  return (threadId, w) => write.call(port, threadId, w);
}

/** The title contract (guuey#2612): every case of the store's title writes. */
function describeTitleContract(make: () => Promise<ThreadPersistenceHarness>): void {
  describe("thread titles (writeTitle)", () => {
    it("a claim sets titleCheckedSeq to its checkpoint and spends one attempt; a claim at a lower or equal checkpoint refuses; the next checkpoint is written", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        expect(await write("t1", claim(8))).toBe("written");
        let t = await port.getThread("t1");
        expect(t?.titleCheckedSeq).toBe(8);
        expect(t?.titleAttempts).toBe(1);
        expect(t?.updatedAt).toBe(TITLE_AT);
        expect(await write("t1", claim(8))).toBe("refused");
        expect(await write("t1", claim(2))).toBe("refused");
        expect(await write("t1", claim(20))).toBe("written");
        t = await port.getThread("t1");
        expect(t?.titleCheckedSeq).toBe(20);
        expect(t?.titleAttempts).toBe(2);
      });
    });

    it("the claim race: two concurrent claims at one checkpoint give exactly one written and one refused, and titleAttempts rises by exactly 1", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        const outcomes = await Promise.all([write("t1", claim(2)), write("t1", claim(2))]);
        expect([...outcomes].sort()).toEqual(["refused", "written"]);
        const t = await port.getThread("t1");
        expect(t?.titleAttempts).toBe(1);
        expect(t?.titleCheckedSeq).toBe(2);
      });
    });

    it("a keep (or any failed call) writes nothing after the claim: the title stays the default", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        expect(await write("t1", claim(2))).toBe("written");
        const t = await port.getThread("t1");
        expect(t?.title).toBe(DEFAULT_THREAD_TITLE);
        expect(t?.titleSource).toBeUndefined();
        expect(t?.titleGenerations).toBeUndefined();
        expect(t?.generatedTitle).toBeUndefined();
      });
    });

    it("the attempt cap holds when every call fails: claims stop at the cap however many checkpoints pass", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        for (let i = 1; i <= TITLE_MAX_ATTEMPTS; i++) expect(await write("t1", claim(i * 10))).toBe("written");
        expect(await write("t1", claim(1000))).toBe("refused");
        expect((await port.getThread("t1"))?.titleAttempts).toBe(TITLE_MAX_ATTEMPTS);
      });
    });

    it("a record lands on its claim: title, generatedTitle, source, seq, language, timestamps, one generation; lastMessageAt untouched", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        await port.incrementSeq("t1", "hello", "2026-08-07T00:00:01.000Z");
        const before = await port.getThread("t1");
        expect(await write("t1", claim(2))).toBe("written");
        expect(await write("t1", record(2, "여행 계획", { sourceSeq: 2, language: "ko" }))).toBe("written");
        const t = await port.getThread("t1");
        expect(t?.title).toBe("여행 계획");
        expect(t?.generatedTitle).toBe("여행 계획");
        expect(t?.titleSource).toBe("generated");
        expect(t?.titleUpdatedAt).toBe(TITLE_AT);
        expect(t?.updatedAt).toBe(TITLE_AT);
        expect(t?.titleSourceSeq).toBe(2);
        expect(t?.titleLanguage).toBe("ko");
        expect(t?.titleGenerations).toBe(1);
        expect(t?.lastMessageAt).toBe(before?.lastMessageAt);
        expect(t?.lastSeq).toBe(before?.lastSeq);
        expect(t?.lastMessagePreview).toBe("hello");
      });
    });

    it("a record without a language leaves the stored titleLanguage as it was", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        await write("t1", claim(2));
        await write("t1", record(2, "First", { language: "ko" }));
        await write("t1", claim(8));
        expect(await write("t1", record(8, "Second"))).toBe("written");
        const t = await port.getThread("t1");
        expect(t?.title).toBe("Second");
        expect(t?.titleLanguage).toBe("ko");
        expect(t?.titleGenerations).toBe(2);
      });
    });

    it("a record consumes its claim: a second record at the same claimed checkpoint refuses and spends no generation (a retried write never counts twice)", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        expect(await write("t1", claim(8))).toBe("written");
        expect(await write("t1", record(8, "First"))).toBe("written");
        expect(await write("t1", record(8, "Again"))).toBe("refused");
        let t = await port.getThread("t1");
        expect(t?.title).toBe("First");
        expect(t?.titleGenerations).toBe(1);
        expect(t?.titleRecordedSeq).toBe(8);
        // The next claim is a fresh one to record against.
        expect(await write("t1", claim(20))).toBe("written");
        expect(await write("t1", record(20, "Second"))).toBe("written");
        t = await port.getThread("t1");
        expect(t?.title).toBe("Second");
        expect(t?.titleGenerations).toBe(2);
        expect(t?.titleRecordedSeq).toBe(20);
      });
    });

    it("the generation cap holds: after the cap no claim is written", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        for (let i = 1; i <= TITLE_MAX_GENERATIONS; i++) {
          expect(await write("t1", claim(i * 10))).toBe("written");
          expect(await write("t1", record(i * 10, `Title ${i}`))).toBe("written");
        }
        expect(await write("t1", claim(1000))).toBe("refused");
        const t = await port.getThread("t1");
        expect(t?.titleGenerations).toBe(TITLE_MAX_GENERATIONS);
        expect(t?.titleAttempts).toBe(TITLE_MAX_GENERATIONS);
        expect(t?.title).toBe(`Title ${TITLE_MAX_GENERATIONS}`);
      });
    });

    it("a record whose checkpoint is no longer the stored claim refuses (a later claim took it)", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        await write("t1", claim(2));
        await write("t1", claim(8));
        expect(await write("t1", record(2, "Slow job"))).toBe("refused");
        expect((await port.getThread("t1"))?.title).toBe(DEFAULT_THREAD_TITLE);
        expect(await write("t1", record(8, "Current job"))).toBe("written");
      });
    });

    it("a record with no claim at all refuses", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        expect(await write("t1", record(2, "Unclaimed"))).toBe("refused");
        expect((await port.getThread("t1"))?.titleGenerations).toBeUndefined();
      });
    });

    it("a set title beats a generation in flight: the record refuses, and later claims refuse while it is pinned", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        expect(await write("t1", claim(2))).toBe("written");
        expect(await write("t1", setTitle("Pinned by me"))).toBe("written");
        expect(await write("t1", record(2, "Generated"))).toBe("refused");
        expect(await write("t1", claim(8))).toBe("refused");
        const t = await port.getThread("t1");
        expect(t?.title).toBe("Pinned by me");
        expect(t?.titleSource).toBe("set");
        expect(t?.titleUpdatedAt).toBe(TITLE_AT);
      });
    });

    it("a set is owner-only: another userId is refused and nothing changes", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        const before = await port.getThread("t1");
        expect(await write("t1", setTitle("Squat", "g_someone_else"))).toBe("refused");
        expect(await write("t1", setTitle(null, "g_someone_else"))).toBe("refused");
        expect(await port.getThread("t1")).toEqual(before);
      });
    });

    it("an unpin restores the last generated title and keeps both lifetime counts", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        await write("t1", claim(2));
        await write("t1", record(2, "Generated one"));
        expect(await write("t1", setTitle("Mine"))).toBe("written");
        expect(await write("t1", setTitle(null, OWNER, "2026-08-07T00:02:00.000Z"))).toBe("written");
        const t = await port.getThread("t1");
        expect(t?.title).toBe("Generated one");
        expect(t?.titleSource).toBe("generated");
        expect(t?.titleUpdatedAt).toBe("2026-08-07T00:02:00.000Z");
        expect(t?.titleAttempts).toBe(1);
        expect(t?.titleGenerations).toBe(1);
        expect(t?.titleCheckedSeq).toBe(2);
      });
    });

    it("an unpin with no generated title resets to the default, clears the checkpoint, and the next generation is accepted", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        await write("t1", claim(2));
        await write("t1", setTitle("Mine"));
        expect(await write("t1", setTitle(null))).toBe("written");
        let t = await port.getThread("t1");
        expect(t?.title).toBe(DEFAULT_THREAD_TITLE);
        expect(t?.titleSource).toBe("default");
        expect(t?.titleCheckedSeq).toBeUndefined();
        expect(t?.titleAttempts).toBe(1);
        expect(await write("t1", claim(2))).toBe("written");
        expect(await write("t1", record(2, "Now generated"))).toBe("written");
        t = await port.getThread("t1");
        expect(t?.title).toBe("Now generated");
        expect(t?.titleSource).toBe("generated");
        expect(t?.titleAttempts).toBe(2);
      });
    });

    it("an unpin that clears the checkpoint makes an in-flight record refuse", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        await write("t1", claim(2));
        await write("t1", setTitle("Mine"));
        await write("t1", setTitle(null));
        expect(await write("t1", record(2, "Late job"))).toBe("refused");
        expect((await port.getThread("t1"))?.title).toBe(DEFAULT_THREAD_TITLE);
      });
    });

    it("an unpin reset reopens a checkpoint, never a second generation from it: claim(8), unpin, claim(8) again, and the first record at 8 to land is the one; the other refuses", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        expect(await write("t1", claim(8))).toBe("written");
        expect(await write("t1", setTitle(null))).toBe("written");
        expect(await write("t1", claim(8))).toBe("written");
        // A record names its checkpoint, not its claimant: the first claimant's
        // late record lands on the second claim, and consumes it.
        expect(await write("t1", record(8, "First claimant, late"))).toBe("written");
        expect(await write("t1", record(8, "Second claimant"))).toBe("refused");
        const t = await port.getThread("t1");
        expect(t?.title).toBe("First claimant, late");
        expect(t?.titleAttempts).toBe(2);
        expect(t?.titleGenerations).toBe(1);
      });
    });

    it("a sealed thread is never titled: a sealed interval or a malformed seal list refuses the claim; an empty list does not", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread({ ...threadRow("sealed"), sealIntervals: [{ fromSeq: 1 }] });
        await port.createThread({ ...threadRow("malformed"), sealIntervals: [{ fromSeq: 0 }] });
        await port.createThread({ ...threadRow("empty"), sealIntervals: [] });
        expect(await write("sealed", claim(2))).toBe("refused");
        expect(await write("malformed", claim(2))).toBe("refused");
        expect(await write("empty", claim(2))).toBe("written");
        expect((await port.getThread("sealed"))?.titleAttempts).toBeUndefined();
      });
    });

    it("an erasing thread is never titled", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread({ ...threadRow("t1"), erasingAt: "2026-08-07T00:00:30.000Z" });
        expect(await write("t1", claim(2))).toBe("refused");
        expect((await port.getThread("t1"))?.titleAttempts).toBeUndefined();
      });
    });

    it("an erasing thread takes no set and no unpin: the owner is refused (the refusal of a missing thread) and nothing changes", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        const ERASING_AT = "2026-08-07T00:00:30.000Z";
        await port.createThread({ ...threadRow("plain"), erasingAt: ERASING_AT });
        await port.createThread({
          ...threadRow("generated"),
          erasingAt: ERASING_AT,
          title: "Generated one",
          titleSource: "set",
          generatedTitle: "Generated one",
        });
        const plainBefore = await port.getThread("plain");
        const generatedBefore = await port.getThread("generated");
        expect(await write("plain", setTitle("Pinned"))).toBe("refused");
        expect(await write("plain", setTitle(null))).toBe("refused");
        expect(await write("generated", setTitle(null))).toBe("refused");
        expect(await port.getThread("plain")).toEqual(plainBefore);
        expect(await port.getThread("generated")).toEqual(generatedBefore);
      });
    });

    it("a closed thread may be titled: the closing turn may be its first", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread({
          ...threadRow("t1"),
          closedCode: "app:CHAT_FULL",
          closedMessage: "This chat is full.",
          closedAt: "2026-08-07T00:00:05.000Z",
        });
        expect(await write("t1", claim(2))).toBe("written");
        expect(await write("t1", record(2, "Last words"))).toBe("written");
        expect((await port.getThread("t1"))?.title).toBe("Last words");
      });
    });

    it("every kind of write refuses on a missing thread", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        expect(await write("t-missing", claim(2))).toBe("refused");
        expect(await write("t-missing", record(2, "x"))).toBe("refused");
        expect(await write("t-missing", setTitle("x"))).toBe("refused");
        expect(await write("t-missing", setTitle(null))).toBe("refused");
        expect(await port.getThread("t-missing")).toBeUndefined();
      });
    });

    it("no title write moves lastMessageAt (the sort key of every list index)", async () => {
      await withHarness(make, async (port) => {
        const write = titleWriter(port);
        await port.createThread(threadRow("t1"));
        const sortKey = (await port.getThread("t1"))?.lastMessageAt;
        await write("t1", claim(2, "2026-09-01T00:00:00.000Z"));
        await write("t1", record(2, "Generated", { at: "2026-09-01T00:00:01.000Z" }));
        await write("t1", setTitle("Mine", OWNER, "2026-09-01T00:00:02.000Z"));
        await write("t1", setTitle(null, OWNER, "2026-09-01T00:00:03.000Z"));
        expect((await port.getThread("t1"))?.lastMessageAt).toBe(sortKey);
      });
    });
  });
}

/**
 * The error {@link withItemSizeLimit} rejects an oversized row with: the shape
 * DynamoDB answers a too-large `PutItem` with.
 */
export class ItemSizeExceededError extends Error {
  override readonly name = "ValidationException";

  constructor(readonly bytes: number) {
    super("Item size has exceeded the maximum allowed size");
  }
}

/**
 * The error {@link withItemSizeLimit} rejects a row carrying a number DynamoDB
 * cannot hold with: like the DocumentClient's own, its message names the number.
 */
export class UnstorableNumberError extends Error {
  constructor(readonly value: number) {
    super(`Number ${String(value)} cannot be stored as written`);
  }
}

function firstUnfitNumber(value: unknown): number | undefined {
  if (typeof value === "number") return dynamoNumberFits(value) ? undefined : value;
  if (value === null || typeof value !== "object") return undefined;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = firstUnfitNumber(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Wrap a port so it behaves like a DynamoDB-backed binding on what a row may
 * hold (guuey#1794): it declares the DynamoDB row budget, and its
 * `putMessage` (and, guuey#2120, its `putSnapshot`) rejects a row over DynamoDB's 400 KB item limit (measured by
 * `dynamoItemBytes`) with {@link ItemSizeExceededError}, and a row carrying a
 * number DynamoDB cannot hold with {@link UnstorableNumberError}, instead of
 * storing it. Run a `ThreadStore` over it to test what happens at those
 * limits without a real table.
 */
export function withItemSizeLimit(port: ThreadPersistencePort): ThreadPersistencePort {
  return {
    rowBudget: DYNAMODB_ROW_BUDGET,
    getThread: (threadId) => port.getThread(threadId),
    createThread: (row) => port.createThread(row),
    incrementSeq: (threadId, preview, atIso) => port.incrementSeq(threadId, preview, atIso),
    ...closeThreadOf(port),
    ...writeTitleOf(port),
    async putMessage(row) {
      const unfit = firstUnfitNumber(row);
      if (unfit !== undefined) throw new UnstorableNumberError(unfit);
      const bytes = dynamoItemBytes(row);
      if (bytes > DYNAMODB_ITEM_LIMIT_BYTES) throw new ItemSizeExceededError(bytes);
      await port.putMessage(row);
    },
    listRecentMessages: (threadId, limit) => port.listRecentMessages(threadId, limit),
    findByClientMessageId: (threadId, clientMessageId) => port.findByClientMessageId(threadId, clientMessageId),
    getSnapshot: (threadId) => port.getSnapshot(threadId),
    // guuey#2120: the snapshot row is an item of the same store, refused the same way.
    async putSnapshot(row) {
      const unfit = firstUnfitNumber(row);
      if (unfit !== undefined) throw new UnstorableNumberError(unfit);
      const bytes = dynamoItemBytes(row);
      if (bytes > DYNAMODB_ITEM_LIMIT_BYTES) throw new ItemSizeExceededError(bytes);
      await port.putSnapshot(row);
    },
  };
}

/** `port`'s `closeThread`, forwarded, or nothing when it has none. */
function closeThreadOf(port: ThreadPersistencePort): Pick<ThreadPersistencePort, "closeThread"> {
  const close = port.closeThread;
  return close === undefined ? {} : { closeThread: (threadId, closure) => close.call(port, threadId, closure) };
}

/** `port`'s `writeTitle`, forwarded, or nothing when it has none. */
function writeTitleOf(port: ThreadPersistencePort): Pick<ThreadPersistencePort, "writeTitle"> {
  const write = port.writeTitle;
  return write === undefined ? {} : { writeTitle: (threadId, w) => write.call(port, threadId, w) };
}
