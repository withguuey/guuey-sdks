import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildInvokeBody } from "./invoke-body.js";
import { WIDGET_INVOKE_BODY_CASES } from "./fixtures/widget-invoke-body-cases.js";

/**
 * guuey#1213 — the wire shape has a fixture, and the fixture is the code's
 * truth. `fixtures/widget-invoke-bodies.json` is consumed by the pod's
 * `rolling-release.test.ts` (current bodies vs the PREVIOUS release's frozen
 * validator) and copied into the pod's `prev-release/<tag>/` set at each
 * release tag (previous bodies vs the CURRENT validator). Regenerate with
 * `npx tsx src/fixtures/write-widget-invoke-bodies.ts` from this package (tsx is not one of its dependencies)
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
      generatedBy: "oss/packages/agent-client/src/fixtures/widget-invoke-body-cases.ts WIDGET_INVOKE_BODY_CASES",
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

describe("the widget cases carry exactly what the widget sends", () => {
  it("every widget case's capabilities equal VIEW_MESSAGE_TURN_CAPABILITIES (the default plus the view-message-turn declaration); the SDK-minimal case advertises nothing", async () => {
    const { DEFAULT_BLOCK_PRESERVING_CAPABILITIES, VIEW_MESSAGE_TURN_CAPABILITIES } = await import("./useAgentInvoke.js");
    expect(VIEW_MESSAGE_TURN_CAPABILITIES).toEqual({ ...DEFAULT_BLOCK_PRESERVING_CAPABILITIES, uiResources: { viewMessageTurns: true } });
    for (const c of WIDGET_INVOKE_BODY_CASES) {
      if (c.name === "sdk-minimal") expect(c.input.capabilities).toBeUndefined();
      else expect(c.input.capabilities, c.name).toEqual(VIEW_MESSAGE_TURN_CAPABILITIES);
    }
  });
});

// The corpus is test-only. A test corpus in a runtime module rides into every
// bundle that imports the builder — its private notes reached a production
// bundle's public JS that way. `src/fixtures/**` is excluded from the build and
// the npm pack; this holds the other half: no runtime module imports from it.
describe("the case corpus ships in no bundle and no tarball", () => {
  it("no runtime module under src/ imports from fixtures/", () => {
    const src = dirname(fileURLToPath(import.meta.url));
    const runtime = readdirSync(src).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(runtime.length).toBeGreaterThan(0);
    // every way a module can reach another: `import … from` / `export … from`, a side-effect
    // `import "…"`, and a dynamic `import("…")` — the pack guard reads the same forms
    const reaches = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']\.\/fixtures\//;
    const offenders = runtime.filter((f) => reaches.test(readFileSync(join(src, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
