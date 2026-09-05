/**
 * guuey#864 — red-first acceptance of the CI `Unit (oss)` leg.
 *
 * A gate that has never been red has never been proven to run. The leg's
 * matrix entry sets `OSS_LEG_CANARY=1` on its FIRST landing, which makes this
 * test fail — proving, on the leg's own first run, that the oss suites now
 * execute on main. The follow-up commit flips the matrix value to "0" and the
 * leg goes green; from then on this test is the standing assertion that the
 * canary is off. Anywhere else (the mirror's release.yml, a laptop) the
 * variable is unset and the test passes.
 */
import { describe, expect, it } from "vitest";

describe("Unit (oss) leg canary (guuey#864)", () => {
  it("runs on main with the canary OFF", () => {
    expect(process.env["OSS_LEG_CANARY"] ?? "0").toBe("0");
  });
});
