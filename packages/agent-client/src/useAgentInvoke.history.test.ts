import { describe, it, expect } from "vitest";
import { applyHistoryResult } from "./useAgentInvoke.js";

describe("applyHistoryResult", () => {
  it("seeds messages when transcript non-empty and chat untouched", () => {
    const out = applyHistoryResult({ messages: [{ role: "user", text: "hi" }] }, []);
    expect(out).toEqual({ kind: "seed", messages: [{ role: "user", text: "hi" }] });
  });
  it("never overwrites an already-started chat", () => {
    const out = applyHistoryResult({ messages: [{ role: "user", text: "old" }] }, [
      { role: "user", text: "new" },
    ]);
    expect(out).toEqual({ kind: "skip" });
  });
  it("gone → clear the persisted thread", () => {
    expect(applyHistoryResult({ gone: true }, [])).toEqual({ kind: "clear" });
    // #3864: the status decides only the notice, never the clear.
    expect(applyHistoryResult({ gone: true, status: 404 }, [])).toEqual({ kind: "clear" });
    expect(applyHistoryResult({ gone: true, status: 403 }, [])).toEqual({ kind: "clear" });
  });
  it("skips when transcript is empty even if chat is untouched", () => {
    expect(applyHistoryResult({ messages: [] }, [])).toEqual({ kind: "skip" });
  });
});
