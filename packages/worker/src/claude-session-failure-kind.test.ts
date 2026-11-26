import { describe, expect, it } from "vitest";
import {
  cliSessionFailureKindOf,
  cliSessionNotAppliedMessage,
  cliSessionRefusedMessage,
  cliSessionUnconfirmedMessage,
} from "./claude-session.js";
import { CLI_SESSION_RESUME_FAILED } from "./protocol.js";

describe("cliSessionFailureKindOf: the one parse of the three resume-failure messages", () => {
  it("reads each builder's output as its kind", () => {
    expect(cliSessionFailureKindOf(cliSessionRefusedMessage("corrupt"))).toBe("refused");
    expect(cliSessionFailureKindOf(cliSessionNotAppliedMessage("this serve loop has no claudeSession"))).toBe(
      "not-applied",
    );
    expect(cliSessionFailureKindOf(cliSessionUnconfirmedMessage("system/init"))).toBe("unconfirmed");
    expect(cliSessionFailureKindOf(cliSessionUnconfirmedMessage("assistant"))).toBe("unconfirmed");
  });
  it("reads anything else as no resume failure, the prefix with an unknown tail included (fail-closed)", () => {
    for (const message of [
      "",
      "model overloaded",
      `${CLI_SESSION_RESUME_FAILED}`,
      `${CLI_SESSION_RESUME_FAILED}: something new`,
      `${CLI_SESSION_RESUME_FAILED}: refused`,
      `${CLI_SESSION_RESUME_FAILED}: not applied (why`,
      cliSessionUnconfirmedMessage(""),
      `x${cliSessionRefusedMessage("corrupt")}`,
    ]) {
      expect(cliSessionFailureKindOf(message)).toBeUndefined();
    }
  });
});
