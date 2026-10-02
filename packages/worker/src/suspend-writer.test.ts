import { describe, it, expect } from "vitest";
import { createSuspendWriter } from "./suspend-writer.js";
import { parseEvent } from "./parse.js";
import { SUSPEND_ENVELOPE_MAX_BYTES, type Invoke } from "./protocol.js";

const baseInvoke: Invoke = {
  type: "invoke",
  input: "hi",
  identity: { userId: "u1", authMode: "anonymous" },
  fs: { app: "/app", home: "/home", session: "/session" },
  history: [],
};
const sink = () => {
  const writes: string[] = [];
  return { writes, out: { write: (s: string) => void writes.push(s) } };
};
/** An ASCII envelope whose JSON-string form (the two quotes included) is exactly `bytes` bytes. */
const envelopeOfJsonBytes = (bytes: number) => "a".repeat(bytes - 2);

describe("createSuspendWriter — the gate", () => {
  it("returns undefined when the invoke carried no offer", () => {
    const { out, writes } = sink();
    expect(createSuspendWriter(out, baseInvoke)).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("returns a writer when the invoke carried an offer", () => {
    const { out } = sink();
    expect(createSuspendWriter(out, { ...baseInvoke, suspend: { maxEnvelopeBytes: 64 } })).toBeDefined();
  });
});

describe("createSuspendWriter — the cap, measured on the envelope's JSON-string bytes", () => {
  it("writes at exactly the cap and refuses at cap + 1 byte, writing nothing", () => {
    const { out, writes } = sink();
    const w = createSuspendWriter(out, { ...baseInvoke, suspend: { maxEnvelopeBytes: 100 } });
    if (w === undefined) throw new Error("expected a writer");
    expect(w.maxEnvelopeBytes).toBe(100);
    expect(w.suspend(envelopeOfJsonBytes(101), ["approval_c"])).toBe("over_cap");
    expect(writes).toEqual([]);
    expect(w.suspend(envelopeOfJsonBytes(100), ["approval_c"])).toBe("written");
    expect(writes).toHaveLength(1);
  });

  it("counts escapes and multi-byte characters as JSON.stringify + UTF-8 render them", () => {
    const { out, writes } = sink();
    const w = createSuspendWriter(out, { ...baseInvoke, suspend: { maxEnvelopeBytes: 10 } });
    if (w === undefined) throw new Error("expected a writer");
    // '"' + '\\"' (2) + '€' (3 bytes) + 'ab' (2) + '"' = 1 + 2 + 3 + 2 + 1 = 9 bytes; 4 characters.
    expect(w.suspend('"€ab', [])).toBe("written");
    // One more '€' makes it 12 bytes, over 10, though only 5 characters.
    expect(w.suspend('"€€ab', [])).toBe("over_cap");
    expect(writes).toHaveLength(1);
  });

  it("never exceeds SUSPEND_ENVELOPE_MAX_BYTES, whatever the offer says", () => {
    const { out } = sink();
    const w = createSuspendWriter(out, {
      ...baseInvoke,
      suspend: { maxEnvelopeBytes: SUSPEND_ENVELOPE_MAX_BYTES * 4 },
    });
    if (w === undefined) throw new Error("expected a writer");
    expect(w.maxEnvelopeBytes).toBe(SUSPEND_ENVELOPE_MAX_BYTES);
    expect(w.suspend(envelopeOfJsonBytes(SUSPEND_ENVELOPE_MAX_BYTES + 1), [])).toBe("over_cap");
    expect(w.suspend(envelopeOfJsonBytes(SUSPEND_ENVELOPE_MAX_BYTES), [])).toBe("written");
  });

  it("writes one NDJSON line the Router's parser reads back as the same suspend", () => {
    const { out, writes } = sink();
    const w = createSuspendWriter(out, { ...baseInvoke, suspend: { maxEnvelopeBytes: 1024 } });
    if (w === undefined) throw new Error("expected a writer");
    const envelope = JSON.stringify({ runState: "é\n\"x\"" });
    expect(w.suspend(envelope, ["approval_a", "approval_b"])).toBe("written");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.endsWith("\n")).toBe(true);
    expect(writes[0]!.indexOf("\n")).toBe(writes[0]!.length - 1);
    expect(parseEvent(writes[0]!.trim())).toEqual({
      type: "suspend",
      envelope,
      askIds: ["approval_a", "approval_b"],
    });
  });
});
