/**
 * A1, the stable prompt prefix: ONE assembler (`../preamble.ts`) builds every
 * runner's system prompt and turn context. This source-text guard keeps it so:
 * no runner source under `src/frameworks/` names a section renderer (or the
 * retired system-prompt preamble) directly, and each framework's prompt goes
 * through `buildSystemPrompt` + `buildTurnContextBlocks`. A runner that renders
 * a section itself would let per-turn bytes back into the system prompt, or
 * let one framework's prompt drift from the others.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL(".", import.meta.url));

/** The section renderers only the assembler may call, plus the retired preamble. */
const SECTION_RENDERER =
  /\b(?:renderMemorySection\w*|renderProfileSection|renderUserMemoryRecall|renderProfileRecall|renderFirstImpression\w*|renderMcpAvailabilitySection|renderResourcesSection|renderSurfaceSection|renderGenerativeUiSection|renderA2uiSection|withContextPreamble)\b/g;

/** Every runner source file in this directory (tests excluded: they compute expected bytes with the renderers). */
const RUNNER_SOURCES = readdirSync(DIR).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));

function sourceOf(file: string): string {
  return readFileSync(join(DIR, file), "utf8");
}

describe("A1: one assembler — no runner renders a prompt section itself", () => {
  it("guards the runner sources it must (never vacuous)", () => {
    expect(RUNNER_SOURCES).toEqual(expect.arrayContaining(["claude-options.ts", "claude.ts", "openai.ts", "google-adk.ts"]));
  });

  it("RED control: the pattern catches a direct call and an import", () => {
    expect("x + renderSurfaceSection(cls.surfaceHints)".match(SECTION_RENDERER)).toEqual(["renderSurfaceSection"]);
    expect('import { renderFirstImpressionShownSection, withContextPreamble } from "../preamble.js";'.match(SECTION_RENDERER)).toEqual([
      "renderFirstImpressionShownSection",
      "withContextPreamble",
    ]);
  });

  it.each(RUNNER_SOURCES)("%s names no section renderer", (file) => {
    expect(sourceOf(file).match(SECTION_RENDERER) ?? []).toEqual([]);
  });

  it.each(["claude-options.ts", "openai.ts", "google-adk.ts"])(
    "%s builds its system prompt and turn context through the assembler",
    (file) => {
      const source = sourceOf(file);
      expect(source).toMatch(/\bbuildSystemPrompt\(/);
      expect(source).toMatch(/\bbuildTurnContextBlocks\(/);
      expect(source).toMatch(/\bpromptClassOf\(/);
    },
  );
});
