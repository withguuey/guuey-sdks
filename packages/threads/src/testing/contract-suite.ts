/**
 * Binding-agnostic behavioral contract for {@link ThreadPersistencePort}.
 * Every binding (in-memory here, guuey's hosted DynamoDB binding, your
 * own store) runs this SAME suite so "works in-memory" and "works on the
 * real thing" mean the same set of guarantees — the `@guuey/state`
 * contract-suite pattern (guuey#107).
 */
import { describe, expect, it } from "vitest";
import type { ThreadPersistencePort, ThreadRow } from "../rows.js";

export interface ThreadPersistenceHarness {
  port: ThreadPersistencePort;
  cleanup?: () => void | Promise<void>;
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
): void {
  describe(`ThreadPersistencePort contract — ${name}`, () => {
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
  });
}
