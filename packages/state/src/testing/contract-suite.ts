/**
 * Binding-agnostic behavioral contract for `Kv`. Every binding
 * (in-memory today, the hosted HTTP/DDB binding later) runs this
 * SAME suite so "works on in-memory" and "works on the real thing"
 * mean the same set of guarantees.
 *
 * Time control: the suite must not assume `vi.useFakeTimers` works
 * against a remote store, so TTL-expiry cases take an optional
 * `advance` hook off the harness. Bindings that can't warp time
 * (live DDB) omit it and the suite SKIPS those cases rather than
 * faking a pass.
 */
import { describe, expect, it } from "vitest";
import {
  InvalidArgumentError,
  InvalidKeyError,
  InvalidTtlError,
  QuotaExceededError,
  TypeMismatchError,
  ValueTooLargeError,
} from "../errors.js";
import type { Kv, ScopeContext, SetOptions } from "../types.js";

export interface KvHarness {
  kv: Kv;
  /** Advance logical time by ms (in-memory: vi timers; stub-DDB: clock var). */
  advance?: (ms: number) => void | Promise<void>;
  /** A second (or third) `Kv` bound to an alternate scope context — for isolation tests. */
  makeScoped: (ctx: ScopeContext) => Promise<Kv>;
  cleanup?: () => void | Promise<void>;
}

/** Scope context used by tests that assert exact `scope()` field values. */
const CTX: ScopeContext = { userId: "u_test", mcpId: "mcp_test" };

/**
 * View of `Kv` that models a plain-JS caller who skipped the required
 * `ttl`. Assigning a `Kv` to this interface is legal without any cast
 * or suppression comment: TypeScript compares METHOD parameters
 * bivariantly by design, so the `SetOptions` → `Partial<SetOptions>`
 * widening type-checks. The runtime validation contract — not the
 * type system — is what the "rejects a missing TTL" case exercises.
 */
interface KvWithLooseSetOptions {
  set(key: string, value: unknown, opts: Partial<SetOptions>): Promise<void>;
}

async function withHarness<T>(
  makeKv: () => Promise<KvHarness>,
  fn: (harness: KvHarness) => Promise<T>,
): Promise<T> {
  const harness = await makeKv();
  try {
    return await fn(harness);
  } finally {
    await harness.cleanup?.();
  }
}

export function runKvContractSuite(
  name: string,
  makeKv: () => Promise<KvHarness>,
): void {
  describe(`Kv contract — ${name}`, () => {
    describe("basic operations", () => {
      it("set + get round-trips a JSON-serializable value", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          await kv.set("hello", { value: 1 }, { ttl: 60 });
          expect(await kv.get<{ value: number }>("hello")).toEqual({
            value: 1,
          });
        });
      });

      it("get returns undefined for absent keys", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          expect(await kv.get("nope")).toBeUndefined();
        });
      });

      it("delete is a no-op for absent keys", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          await expect(kv.delete("nope")).resolves.toBeUndefined();
        });
      });

      it("has reports existence correctly", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          expect(await kv.has("a")).toBe(false);
          await kv.set("a", 1, { ttl: 60 });
          expect(await kv.has("a")).toBe(true);
          await kv.delete("a");
          expect(await kv.has("a")).toBe(false);
        });
      });

      it("keys returns the scope's keys, optionally prefix-filtered", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          await kv.set("user:1", "a", { ttl: 60 });
          await kv.set("user:2", "b", { ttl: 60 });
          await kv.set("post:1", "c", { ttl: 60 });
          const all = await kv.keys();
          expect(all.keys).toEqual(
            expect.arrayContaining(["user:1", "user:2", "post:1"]),
          );
          expect(all.cursor).toBeUndefined();
          expect((await kv.keys({ prefix: "user:" })).keys).toEqual([
            "user:1",
            "user:2",
          ]);
        });
      });

      it("keys paginates lexicographically via cursor", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          for (const k of ["e", "c", "a", "d", "b"]) {
            await kv.set(`p:${k}`, 1, { ttl: 60 });
          }
          const page1 = await kv.keys({ prefix: "p:", limit: 2 });
          expect(page1.keys).toEqual(["p:a", "p:b"]);
          expect(page1.cursor).toBe("p:b");
          const page2 = await kv.keys({
            prefix: "p:",
            limit: 2,
            ...(page1.cursor !== undefined ? { cursor: page1.cursor } : {}),
          });
          expect(page2.keys).toEqual(["p:c", "p:d"]);
          const page3 = await kv.keys({
            prefix: "p:",
            limit: 2,
            ...(page2.cursor !== undefined ? { cursor: page2.cursor } : {}),
          });
          expect(page3.keys).toEqual(["p:e"]);
          expect(page3.cursor).toBeUndefined();
        });
      });

      it("increment + decrement are atomic on number-typed keys", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          expect(await kv.increment("counter", { ttl: 60 })).toBe(1);
          expect(await kv.increment("counter", { by: 5, ttl: 60 })).toBe(6);
          expect(await kv.decrement("counter", { ttl: 60 })).toBe(5);
        });
      });

      it("scope() returns live usage", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = await harness.makeScoped(CTX);
          const before = await kv.scope();
          expect(before.usedBytes).toBe(0);
          await kv.set("x", "hello", { ttl: 60 });
          const after = await kv.scope();
          expect(after.usedBytes).toBeGreaterThan(before.usedBytes);
          expect(after.keyCount).toBe(1);
          expect(after.userId).toBe(CTX.userId);
          expect(after.mcpId).toBe(CTX.mcpId);
        });
      });

      it("scopes data per (userId, mcpId) — separate scopes don't see each other", async () => {
        await withHarness(makeKv, async (harness) => {
          const a = await harness.makeScoped({
            userId: "u_a",
            mcpId: "mcp_test",
          });
          const b = await harness.makeScoped({
            userId: "u_b",
            mcpId: "mcp_test",
          });
          await a.set("shared", "from-a", { ttl: 60 });
          expect(await b.get("shared")).toBeUndefined();
        });
      });

      it("scope keys cannot collide across (userId, mcpId) splits", async () => {
        // With a printable delimiter, {"a b","c"} and {"a","b c"} could
        // alias. Verify adjacent-looking ids stay isolated regardless
        // of how the binding forms its internal scope key.
        await withHarness(makeKv, async (harness) => {
          const a = await harness.makeScoped({ userId: "a", mcpId: "b_c" });
          const b = await harness.makeScoped({ userId: "a_b", mcpId: "c" });
          await a.set("k", "from-a", { ttl: 60 });
          expect(await b.get("k")).toBeUndefined();
        });
      });
    });

    describe("validation", () => {
      it("rejects an invalid key (empty)", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          await expect(kv.set("", 1, { ttl: 60 })).rejects.toBeInstanceOf(
            InvalidKeyError,
          );
        });
      });

      it("rejects an invalid key (illegal char)", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          await expect(
            kv.set("key with space", 1, { ttl: 60 }),
          ).rejects.toBeInstanceOf(InvalidKeyError);
        });
      });

      it("rejects a missing TTL", async () => {
        await withHarness(makeKv, async (harness) => {
          // Untyped-caller simulation — see KvWithLooseSetOptions.
          const kv: KvWithLooseSetOptions = harness.kv;
          await expect(kv.set("a", 1, {})).rejects.toBeInstanceOf(
            InvalidTtlError,
          );
        });
      });

      it("rejects a TTL over 90 days", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          const ninetyOneDays = 60 * 60 * 24 * 91;
          await expect(
            kv.set("a", 1, { ttl: ninetyOneDays }),
          ).rejects.toBeInstanceOf(InvalidTtlError);
        });
      });

      it("rejects a value over 64 KiB", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          const huge = "x".repeat(65 * 1024);
          await expect(kv.set("a", huge, { ttl: 60 })).rejects.toBeInstanceOf(
            ValueTooLargeError,
          );
        });
      });
    });

    describe("TTL expiry", () => {
      it("returns undefined after the TTL elapses", async () => {
        await withHarness(makeKv, async (harness) => {
          if (!harness.advance) return;
          const kv = harness.kv;
          await kv.set("ephemeral", "hi", { ttl: 30 });
          expect(await kv.get("ephemeral")).toBe("hi");
          await harness.advance(31_000);
          expect(await kv.get("ephemeral")).toBeUndefined();
        });
      });
    });

    describe("error envelope", () => {
      it("EVERY failable operation throws a GuueyStateError subclass — no bare TypeError/RangeError", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          // increment on a non-number key
          await kv.set("json-key", { a: 1 }, { ttl: 60 });
          await expect(
            kv.increment("json-key", { ttl: 60 }),
          ).rejects.toBeInstanceOf(TypeMismatchError);
          // keys() limit out of range / non-integer
          await expect(kv.keys({ limit: 0 })).rejects.toBeInstanceOf(
            InvalidArgumentError,
          );
          await expect(kv.keys({ limit: 1001 })).rejects.toBeInstanceOf(
            InvalidArgumentError,
          );
          await expect(kv.keys({ limit: 2.5 })).rejects.toBeInstanceOf(
            InvalidArgumentError,
          );
          // mget over the batch cap
          const tooMany = Array.from({ length: 101 }, (_, i) => `k:${i}`);
          await expect(kv.mget(tooMany)).rejects.toBeInstanceOf(
            InvalidArgumentError,
          );
          // non-integer counter step
          await expect(
            kv.increment("counter", { ttl: 60, by: 0.5 }),
          ).rejects.toBeInstanceOf(InvalidArgumentError);
          // non-JSON-serializable values (stringify returns undefined)
          await expect(
            kv.set("u", undefined, { ttl: 60 }),
          ).rejects.toBeInstanceOf(InvalidArgumentError);
          await expect(
            kv.set("f", () => "nope", { ttl: 60 }),
          ).rejects.toBeInstanceOf(InvalidArgumentError);
          // non-JSON-serializable values (stringify throws natively)
          interface Circular {
            self?: Circular;
          }
          const circular: Circular = {};
          circular.self = circular;
          await expect(
            kv.set("c", circular, { ttl: 60 }),
          ).rejects.toBeInstanceOf(InvalidArgumentError);
          await expect(
            kv.set("b", 10n, { ttl: 60 }),
          ).rejects.toBeInstanceOf(InvalidArgumentError);
        });
      });
    });

    describe("mget prototype safety", () => {
      it('a key literally named "__proto__" round-trips through mget', async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          await kv.set("__proto__", { isAdmin: true }, { ttl: 60 });
          await kv.set("normal", "ok", { ttl: 60 });
          const out = await kv.mget<unknown>(["__proto__", "normal"]);
          // The entry must exist as an OWN property with the stored value…
          expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(
            true,
          );
          expect(out["__proto__"]).toEqual({ isAdmin: true });
          expect(out["normal"]).toBe("ok");
          // …and must NOT have replaced the result object's prototype.
          expect((out as { isAdmin?: boolean }).isAdmin).toBeUndefined();
        });
      });
    });

    describe("byte accounting", () => {
      it("counts UTF-8 bytes of key + value, not UTF-16 code units", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          // "🎉" is 2 UTF-16 units but 4 UTF-8 bytes.
          const emoji = "🎉".repeat(1000);
          await kv.set("emoji", emoji, { ttl: 60 });
          const info = await kv.scope();
          // 5 key bytes + 2 JSON quote bytes + 4000 emoji bytes.
          expect(info.usedBytes).toBe(5 + 2 + 4000);
        });
      });

      it("key bytes count toward the scope quota (long keys can't dodge the cap)", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          // 1023-byte keys with 1-byte values: value bytes alone would say
          // "nearly empty"; key-inclusive accounting fills the 1 MiB cap
          // after ~1024 keys.
          const longKey = (i: number) =>
            `k${String(i).padStart(4, "0")}`.padEnd(1023, "x");
          let threw: unknown;
          for (let i = 0; i < 1100; i++) {
            try {
              await kv.set(longKey(i), 1, { ttl: 60 });
            } catch (err) {
              threw = err;
              break;
            }
          }
          expect(threw).toBeInstanceOf(QuotaExceededError);
          const info = await kv.scope();
          expect(info.usedBytes).toBeLessThanOrEqual(1024 * 1024);
          expect(info.usedBytes).toBeGreaterThan(1024 * 1000);
        });
      });

      it("rejects a value whose UTF-8 size exceeds the cap even when .length does not", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          // 17k emoji = 34k UTF-16 units (under 64 KiB as .length) but
          // 68 KB UTF-8 (over the cap).
          const sneaky = "🎉".repeat(17 * 1024);
          await expect(
            kv.set("sneaky", sneaky, { ttl: 60 }),
          ).rejects.toBeInstanceOf(ValueTooLargeError);
        });
      });
    });

    describe("audit regressions (2026-07-20)", () => {
      it("concurrent increments never lose updates (sync read-modify-write)", async () => {
        await withHarness(makeKv, async (harness) => {
          const kv = harness.kv;
          // Pre-fix, get-then-set across await points let all of these read
          // the same base and collapse to 1.
          const results = await Promise.all(
            Array.from({ length: 25 }, () =>
              kv.increment("counter", { ttl: 60 }),
            ),
          );
          expect(await kv.get<number>("counter")).toBe(25);
          // Every intermediate value observed exactly once.
          expect([...results].sort((a, b) => a - b)).toEqual(
            Array.from({ length: 25 }, (_, i) => i + 1),
          );
        });
      });

      it("expired keys stop counting toward the scope quota", async () => {
        await withHarness(makeKv, async (harness) => {
          if (!harness.advance) return;
          const kv = harness.kv;
          // ~896 KiB of payload under a 1 MiB scope cap, with a 1s TTL.
          const big = "x".repeat(63 * 1024);
          for (let i = 0; i < 14; i++) {
            await kv.set(`dead:${i}`, big, { ttl: 1 });
          }
          await harness.advance(2_000); // everything above is now expired
          // Pre-fix this threw QuotaExceededError: expired corpses still
          // summed into usedBytes.
          await kv.set("fresh", big, { ttl: 60 });
          expect(await kv.get("fresh")).toBe(big);
          const info = await kv.scope();
          expect(info.usedBytes).toBeLessThan(70 * 1024);
        });
      });
    });
  });
}
