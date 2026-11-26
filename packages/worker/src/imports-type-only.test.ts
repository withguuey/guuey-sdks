/**
 * `@guuey/worker` depends on `@silverprotocol/core` for TYPES only: the AgBlock kinds of turn context and message
 * parts. Its runtime (and the zod it carries) must never load in a worker, so every import or re-export of it under
 * src is `import type` / `export type`. A value import, a mixed `import { type X, y }`, a side-effect import, a dynamic
 * `import()` or a `require()` of it fails here, before it can reach a builder's pod.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE = "@silverprotocol/core";
const SRC = fileURLToPath(new URL(".", import.meta.url));
const SELF = "imports-type-only.test.ts";

/** Every static statement that names the package: `import … from "pkg"`, `export … from "pkg"`, `import "pkg"`. */
const STATIC = /(?:^|[;\n])\s*((?:import|export)\b[^;]*?["']@silverprotocol\/core(?:\/[^"']*)?["'])/g;
/** Every dynamic load of it: `import("pkg")` or `require("pkg")`. */
const DYNAMIC = /\b(?:import|require)\s*\(\s*["']@silverprotocol\/core(?:\/[^"']*)?["']/g;
/** The two allowed forms: `import type { … } from` and `export type { … } from`. */
const TYPE_ONLY = /^(?:import|export)\s+type\s*\{[^}]*\}\s*from\s*["']@silverprotocol\/core(?:\/[^"']*)?["']$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|mts|cts)$/.test(entry.name) && entry.name !== SELF ? [path] : [];
  });
}

/** The offending statements of one file's text. */
export function valueImportsOf(text: string): string[] {
  const statements = [...text.matchAll(STATIC)].map((m) => (m[1] ?? "").replace(/\s+/g, " ").trim());
  return [
    ...statements.filter((s) => !TYPE_ONLY.test(s)),
    ...[...text.matchAll(DYNAMIC)].map((m) => m[0]),
  ];
}

describe(`${PACKAGE} is imported for types only`, () => {
  it("names the package at least once (the check is not vacuous)", () => {
    const naming = sourceFiles(SRC).filter((f) => readFileSync(f, "utf8").includes(PACKAGE));
    expect(naming.length).toBeGreaterThan(0);
  });
  it("every import and re-export of it under src is type-only", () => {
    const offending = sourceFiles(SRC).flatMap((f) =>
      valueImportsOf(readFileSync(f, "utf8")).map((s) => `${f.slice(SRC.length)}: ${s}`),
    );
    expect(offending).toEqual([]);
  });
  it("the rule refuses every value form and allows only the two type forms", () => {
    expect(valueImportsOf(`import type { AgBlock } from "${PACKAGE}";`)).toEqual([]);
    expect(valueImportsOf(`import type {\n  AgBlock,\n  AgSource,\n} from "${PACKAGE}";`)).toEqual([]);
    expect(valueImportsOf(`export type { AgBlock } from "${PACKAGE}";`)).toEqual([]);
    expect(valueImportsOf(`import type { AgBlock } from "${PACKAGE}/dist/agjson.js";`)).toEqual([]);
    for (const bad of [
      `import { AgBlock } from "${PACKAGE}";`,
      `import { type AgBlock, AgInput } from "${PACKAGE}";`,
      `import { type AgBlock } from "${PACKAGE}";`,
      `import * as core from "${PACKAGE}";`,
      `import core from "${PACKAGE}";`,
      `import "${PACKAGE}";`,
      `export { AgBlock } from "${PACKAGE}";`,
      `export * from "${PACKAGE}";`,
      `const core = await import("${PACKAGE}");`,
      `const core = require("${PACKAGE}");`,
      `import { AgBlock } from "${PACKAGE}/dist/agjson.js";`,
      `export * from "${PACKAGE}/dist/input-check.js";`,
    ]) {
      expect(valueImportsOf(bad), bad).not.toEqual([]);
    }
  });
});
