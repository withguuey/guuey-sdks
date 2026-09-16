import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildInvokeBody, WIDGET_INVOKE_BODY_CASES } from "./invoke-body.js";

/**
 * guuey#1213 — the wire shape has a fixture, and the fixture is the code's
 * truth. `fixtures/widget-invoke-bodies.json` is consumed by the pod's
 * `rolling-release.test.ts` (current bodies vs the PREVIOUS release's frozen
 * validator) and copied into the pod's `prev-release/<tag>/` set at each
 * release tag (previous bodies vs the CURRENT validator). Regenerate with
 * `pnpm --filter @guuey/agent-client exec tsx src/fixtures/write-widget-invoke-bodies.ts`
 * — never by hand.
 */
const FIXTURE = new URL("./fixtures/widget-invoke-bodies.json", import.meta.url);

describe("buildInvokeBody — the one wire shape", () => {
  it("omits absent optional keys entirely (never an undefined-valued key on the wire)", () => {
    const body = buildInvokeBody({ input: "ping", clientMessageId: "cm_1" });
    expect(Object.keys(body)).toEqual(["input", "clientMessageId"]);
    expect(JSON.parse(JSON.stringify(body))).toEqual({ input: "ping", clientMessageId: "cm_1" });
  });

  it("a null threadId (first contact) is not sent; a minted one is", () => {
    expect(buildInvokeBody({ input: "a", clientMessageId: "c", threadId: null })).not.toHaveProperty("threadId");
    expect(buildInvokeBody({ input: "a", clientMessageId: "c", threadId: "thr_1" }).threadId).toBe("thr_1");
  });

  it("carries capabilities, pageContext and mode verbatim, in the wire's key order", () => {
    const body = buildInvokeBody({
      input: "x",
      threadId: "t",
      clientMessageId: "c",
      capabilities: { hitl: { ask: true, grantModes: true } },
      pageContext: { hostOrigin: "https://h.example" },
      mode: "guest",
    });
    expect(Object.keys(body)).toEqual(["input", "threadId", "clientMessageId", "capabilities", "pageContext", "mode"]);
  });
});

describe("the widget's canonical bodies are pinned as the fixture (guuey#1213)", () => {
  it("fixtures/widget-invoke-bodies.json equals the builder's output for every canonical case, byte for byte", () => {
    const expected = {
      $schema: "guuey/widget-invoke-bodies@1",
      generatedBy: "oss/packages/agent-client/src/invoke-body.ts WIDGET_INVOKE_BODY_CASES",
      cases: WIDGET_INVOKE_BODY_CASES.map((c) => ({ name: c.name, why: c.why, body: buildInvokeBody(c.input) })),
    };
    const onDisk = readFileSync(FIXTURE, "utf8");
    expect(onDisk).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });

  it("the case list covers the shapes the widget actually sends: init-origin-only, a full page block, a page block without context, a mode pin, and the SDK minimum", () => {
    const names = WIDGET_INVOKE_BODY_CASES.map((c) => c.name);
    expect(names).toEqual(["session-open-init-origin", "turn-with-page", "turn-with-page-no-context", "guest-mode-pin", "sdk-minimal"]);
    const withPath = WIDGET_INVOKE_BODY_CASES.filter((c) => c.input.pageContext?.path !== undefined);
    // Every path-bearing block the widget builds also carries title + hostOrigin (WidgetChat's onPage).
    for (const c of withPath) {
      expect(c.input.pageContext?.title).toBeDefined();
      expect(c.input.pageContext?.hostOrigin).toBeDefined();
    }
  });
});
