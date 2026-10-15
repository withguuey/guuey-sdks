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
