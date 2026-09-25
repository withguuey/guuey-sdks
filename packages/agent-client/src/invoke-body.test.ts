import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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
// Every way a module names another: `import … from` / `export … from`, a side-effect
// `import "…"`, and a dynamic `import("…")` with a literal — the pack guard reads the same
// forms. A specifier built at runtime cannot be read here; none exists in this package.
const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** The relative specifiers in `source` (a module at `file`) that resolve inside `fixtures`. */
function specifiersIntoFixtures(file: string, source: string, fixtures: string): string[] {
  return [...source.matchAll(SPECIFIER)]
    .flatMap((m) => (m[1] === undefined ? [] : [m[1]]))
    .filter((s) => s.startsWith("."))
    .filter((s) => {
      const target = resolve(dirname(file), s);
      return target === fixtures || target.startsWith(fixtures + sep);
    });
}

describe("the case corpus ships in no bundle and no tarball", () => {
  it("no runtime module anywhere under src/ (any depth) reaches src/fixtures/", () => {
    const src = dirname(fileURLToPath(import.meta.url));
    const fixtures = join(src, "fixtures");
    // any depth: a module in a subdirectory reaches the corpus as `../fixtures/…`, so the walk
    // recurses and every relative specifier is RESOLVED against its own file, never pattern-matched
    const runtime = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => !join(src, f).startsWith(fixtures + sep));
    expect(runtime.length).toBeGreaterThan(0);
    const offenders = runtime.flatMap((f) =>
      specifiersIntoFixtures(join(src, f), readFileSync(join(src, f), "utf8"), fixtures).map(
        (s) => `${f} → ${s}`
      )
    );
    expect(offenders).toEqual([]);
  });

  it("the resolver: `../fixtures/` from a subdirectory is caught; a sibling `fixtures` dir elsewhere is not", () => {
    const src = "/pkg/src";
    const fixtures = "/pkg/src/fixtures";
    const from = (file: string, source: string): string[] =>
      specifiersIntoFixtures(file, source, fixtures);
    expect(from("/pkg/src/a.ts", 'import { X } from "./fixtures/cases.js";')).toEqual([
      "./fixtures/cases.js",
    ]);
    expect(from("/pkg/src/sub/b.ts", 'export * from "../fixtures/cases.js";')).toEqual([
      "../fixtures/cases.js",
    ]);
    expect(from("/pkg/src/sub/deep/c.ts", 'const m = await import("../../fixtures/x.js");')).toEqual(
      ["../../fixtures/x.js"]
    );
    expect(from("/pkg/src/sub/d.ts", 'import "./fixtures/own.js";')).toEqual([]);
    expect(from(`${src}/e.ts`, 'import { y } from "@guuey/mcp-apps-host";')).toEqual([]);
  });
});
