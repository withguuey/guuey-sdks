import { describe, expect, it } from "vitest";
import { stallProbeDecision } from "./useAgentInvoke.js";
import type { AgentMessage } from "./types.js";

const user = (text: string): AgentMessage => ({ role: "user", text });

describe("stallProbeDecision — a finished tail", () => {
  it("adopts a history whose last row is the turn's notice: a failed turn ends on it (persisted at completion)", () => {
    expect(stallProbeDecision([user("q"), { role: "notice", text: "The reply was withheld.", failure: { code: "CONTENT_BLOCKED" } }], 1)).toBe("adopt");
  });

  it("RED control: an assistant tail adopts, a user tail or an empty tail stays in flight, as before", () => {
    expect(stallProbeDecision([user("q"), { role: "assistant", text: "Here it is." }], 1)).toBe("adopt");
    expect(stallProbeDecision([user("q")], 1)).toBe("in-flight");
    expect(stallProbeDecision([user("q"), { role: "notice", text: " " }], 1)).toBe("in-flight");
    expect(stallProbeDecision([user("q"), { role: "assistant", text: "old" }], 2)).toBe("in-flight");
  });
});
