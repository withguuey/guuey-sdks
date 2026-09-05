/**
 * NodeNext probe over the @ggui-ai/* declarations we consume (guuey#836,
 * the guuey#846 class).
 *
 * @ggui-ai/protocol 0.14.0 shipped `.d.ts` files whose relative re-exports
 * were EXTENSIONLESS — legal for a bundler, rejected by TypeScript's
 * NodeNext resolution (TS2834/TS2835), so a `"type": "module"` consumer
 * compiling strictly against the package could not use it at all. This
 * package IS such a consumer, but its own tsconfig carries `skipLibCheck`
 * (for the @modelcontextprotocol/ext-apps quirk documented there), which
 * hides exactly that class. So the probe compiles a fresh program — strict,
 * NodeNext, `skipLibCheck: false` — that imports every @ggui-ai/protocol
 * entry we use, and fails on any diagnostic raised inside `@ggui-ai/*` or
 * at the import sites. Two tolerances, both narrow and both printed:
 * diagnostics raised in OTHER packages' declarations (ext-apps 1.7.5's own
 * root d.ts, upstream ext-apps#704 / ggui#847), and diagnostics raised
 * inside @ggui-ai files that are CAUSED by that same quirk — protocol's
 * `host-context.d.ts` imports `McpUi*` names that reach it through
 * ext-apps' broken re-export, so under strict lib-check they read as
 * "no exported member" (TS2305/TS2460) although protocol's own specifiers
 * are extension-correct. Such a diagnostic is tolerated ONLY when its text
 * names `@modelcontextprotocol/ext-apps`; the NodeNext resolution class
 * itself (TS2834/TS2835/TS2307) inside @ggui-ai is never tolerated, and
 * neither is any other @ggui-ai diagnostic. When ext-apps ships correct
 * declarations the tolerated set goes to zero on its own.
 *
 * The second test proves the probe can go red (the detectors law): a
 * synthetic declaration with an extensionless re-export must surface as the
 * NodeNext extension error through the same harness.
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Every @ggui-ai/protocol entry point a guuey package imports (grep of the tree, 2026-09-05) plus the 0.15.0 browser entry. */
const PROTOCOL_ENTRIES = [
  "@ggui-ai/protocol",
  "@ggui-ai/protocol/integrations/mcp-apps",
  "@ggui-ai/protocol/blueprint-key",
  "@ggui-ai/protocol/wire",
] as const;

/** The upstream whose root d.ts is extensionless today (ext-apps#704); named in every diagnostic it causes. */
const EXT_APPS = "@modelcontextprotocol/ext-apps";

/** NodeNext extension / resolution failures — the guuey#846 class. */
const NODENEXT_RESOLUTION_CODES = new Set([2834, 2835, 2307]);

interface ProbeDiagnostic {
  file: string;
  code: number;
  text: string;
}

const NODENEXT_STRICT: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2023,
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  strict: true,
  skipLibCheck: false,
  noEmit: true,
  types: [],
};

function compile(rootFile: string): ProbeDiagnostic[] {
  const program = ts.createProgram([rootFile], NODENEXT_STRICT);
  return ts.getPreEmitDiagnostics(program).map((d) => ({
    file: d.file?.fileName ?? "<global>",
    code: d.code,
    text: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  }));
}

/** A scratch dir INSIDE this package so bare specifiers resolve through its node_modules. */
function scratch(): string {
  return mkdtempSync(join(here, ".nodenext-probe-"));
}

function render(diags: readonly ProbeDiagnostic[]): string {
  return diags.map((d) => `${d.file}: TS${d.code} ${d.text.split("\n")[0]}`).join("\n");
}

describe("NodeNext probe over @ggui-ai/protocol (guuey#846 class)", () => {
  it("every entry we import typechecks strict under NodeNext with skipLibCheck: false", () => {
    const dir = scratch();
    try {
      const probe = join(dir, "probe.mts");
      const imports = PROTOCOL_ENTRIES.map((e, i) => `import * as m${i} from ${JSON.stringify(e)};`).join("\n");
      const uses = PROTOCOL_ENTRIES.map((_, i) => `m${i}`).join(", ");
      writeFileSync(
        probe,
        `${imports}\n` +
          // A typed use, not just a resolved import: the refusal-code table this package reads.
          `const codes: readonly string[] = m0.RENDER_GATE_REFUSAL_CODES;\n` +
          `export const probe = { codes, modules: [${uses}] };\n`,
      );
      const all = compile(probe);
      const ours = all.filter((d) => d.file === probe || d.file.includes(`${sep}@ggui-ai${sep}`) || d.file.includes("/@ggui-ai/"));
      const elsewhere = all.filter((d) => !ours.includes(d));
      if (elsewhere.length > 0) {
        // Informational — other packages' declarations under strict lib-check (ext-apps 1.7.5 today).
        console.info(`nodenext-probe: ${elsewhere.length} diagnostic(s) outside @ggui-ai (not counted):\n${render(elsewhere.slice(0, 3))}`);
      }
      const resolutionClass = ours.filter((d) => NODENEXT_RESOLUTION_CODES.has(d.code));
      expect(resolutionClass, `the guuey#846 class is back inside @ggui-ai/*:\n${render(resolutionClass)}`).toEqual([]);
      const viaExtApps = ours.filter((d) => d.text.includes(EXT_APPS));
      if (viaExtApps.length > 0) {
        console.info(`nodenext-probe: ${viaExtApps.length} diagnostic(s) inside @ggui-ai caused by ${EXT_APPS}' declarations (tolerated, ext-apps#704):\n${render(viaExtApps)}`);
      }
      const unexplained = ours.filter((d) => !viaExtApps.includes(d));
      expect(unexplained, `@ggui-ai/* declarations must be clean under NodeNext (only ${EXT_APPS}-caused diagnostics are tolerated):\n${render(unexplained)}`).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("goes RED on an extensionless relative re-export in a declaration (the harness can see the class)", () => {
    const dir = scratch();
    try {
      mkdirSync(join(dir, "bad"));
      writeFileSync(join(dir, "bad", "inner.d.ts"), `export type Inner = { ok: true };\n`);
      // The 0.14.0 shape: a d.ts re-exporting through an EXTENSIONLESS relative specifier.
      writeFileSync(join(dir, "bad", "index.d.ts"), `export * from "./inner";\n`);
      writeFileSync(join(dir, "bad", "index.js"), `export {};\n`);
      writeFileSync(join(dir, "bad", "package.json"), JSON.stringify({ name: "bad", type: "module", types: "./index.d.ts", main: "./index.js" }));
      const probe = join(dir, "probe.mts");
      writeFileSync(probe, `import type { Inner } from "./bad/index.js";\nexport const x: Inner = { ok: true };\n`);
      const inBad = compile(probe).filter((d) => d.file.includes(`${sep}bad${sep}`) || d.file.includes("/bad/"));
      expect(inBad.length, "the synthetic declaration must raise at least one diagnostic").toBeGreaterThan(0);
      expect(
        inBad.some((d) => NODENEXT_RESOLUTION_CODES.has(d.code)),
        `expected a NodeNext resolution error (TS2834/TS2835/TS2307), got:\n${render(inBad)}`,
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
