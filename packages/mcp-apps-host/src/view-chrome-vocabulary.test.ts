/**
 * guuey#1279 Track A, extended on guuey#1325 — protocol/lifecycle vocabulary
 * cannot reach this package's chrome.
 *
 * ## Why this test exists, stated plainly
 *
 * guuey#1279 made the rule structural in `@guuey/chat`: rail tools are routed
 * around the host-overridable humanizer so protocol vocabulary cannot reach
 * the status line. That guard asserted a property of ONE package while the
 * rule was described as a property of "the widget chrome" — and those were not
 * the same set. `@guuey/mcp-apps-host` renders its own chrome, was never
 * walked by that guard, and shipped `"Negotiating with view…"` (the
 * {@link ViewHostPhase} member `"negotiating"` shown to a person) captioning a
 * blank frame on a public page. The founder saw it.
 *
 * **A by-construction guard is scoped to the packages its test walks.** So
 * this test states its coverage explicitly rather than leaving it implied:
 *
 *   COVERED HERE: every `.ts`/`.tsx` source in `@guuey/mcp-apps-host/src`,
 *   and the copy table those files render from.
 *   COVERED ELSEWHERE: `@guuey/chat`'s planner + status line, by
 *   `plan.protocol-chrome.test.ts` in that package (it carries the twin of
 *   the source scan below).
 *   NOT COVERED BY EITHER: app-level chrome (`apps/*`), which renders its own
 *   copy and is not reached from here. If a third surface starts rendering
 *   view state, it needs its own scan — that is the gap this comment exists
 *   to keep visible.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultViewHostStrings } from "./view-strings.js";

/**
 * Vocabulary that is machinery: rail identifiers, MCP wire shapes and the
 * lifecycle verbs. "Loading view…" is product copy and passes; "Negotiating
 * with view…" is not.
 */
const PROTOCOL_VOCABULARY = /ggui|handshake|negotiat|mcp__|ui:\/\//i;

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** Every source file in this package (excluding tests — they name the offenders on purpose). */
function sourceFiles(): string[] {
  return readdirSync(SRC_DIR)
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.includes(".test."))
    .map((f) => join(SRC_DIR, f));
}

/** Strip block and line comments — prose ABOUT the protocol is correct and expected. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * Prose runs: two or more words separated by single spaces. This is what
 * distinguishes a SENTENCE a person reads from an identifier. `"negotiating"`
 * as a union member is one word; the CSS class `guuey-chat-view-negotiating`
 * has no spaces; `Negotiating with view…` is three words and is caught.
 */
const WORD = /^[A-Za-z][a-z'’]*[.,!?…]?$/;
const DASH = /^[—–-]$/;

function proseRuns(source: string): string[] {
  const runs = source.match(/[A-Za-z'’]+(?: [A-Za-z'’…,.—–-]+)+/g) ?? [];
  // Every token must look like a natural WORD (or a dash). That is what
  // rejects `const GGUI_RAIL_TITLES`, `return s.viewNegotiating` and the
  // className `guuey-chat-view-negotiating` — code that legitimately names
  // the protocol — while keeping "Negotiating with view…".
  return runs.filter((run) => {
    const tokens = run.split(" ");
    return tokens.length >= 2 && tokens.every((t) => WORD.test(t) || DASH.test(t));
  });
}

describe("guuey#1325 — the copy table carries no machinery", () => {
  it.each(Object.entries(defaultViewHostStrings))("%s is product copy", (_key, value) => {
    expect(value).not.toMatch(PROTOCOL_VOCABULARY);
  });

  it("speaks the same words as @guuey/chat for the same states", () => {
    // Deliberate duplication: `@guuey/chat` depends on THIS package, so it
    // cannot be imported here without a cycle. Pinned so the two packages
    // cannot drift into describing one state two ways.
    expect(defaultViewHostStrings.viewLoading).toBe("Loading view…");
    expect(defaultViewHostStrings.viewBootFailure).toBe("This view couldn't start");
  });
});

describe("guuey#1325 — no source renders machinery as prose", () => {
  // The scan that would have caught the shipped bug: it reads the sources
  // rather than the behaviour, so a NEW hardcoded literal in any component
  // fails here even if no test renders that component.
  it.each(sourceFiles())("%s", (file) => {
    const offenders = proseRuns(stripComments(readFileSync(file, "utf8"))).filter((run) =>
      PROTOCOL_VOCABULARY.test(run),
    );
    expect(offenders).toEqual([]);
  });

  it("the scan actually fires on the string that shipped (a detector proven on a real instance)", () => {
    const shipped = 'return <p style={statusLineStyle}>Negotiating with view…</p>;';
    const offenders = proseRuns(stripComments(shipped)).filter((run) =>
      PROTOCOL_VOCABULARY.test(run),
    );
    expect(offenders.length).toBeGreaterThan(0);
  });

  it("does NOT fire on legitimate machinery: union members, class names, comparisons", () => {
    const legitimate = [
      'if (phase === "negotiating") { return null; }',
      'const c = "guuey-chat-view-negotiating";',
      'channel === "ggui"',
      // The four real false positives the first draft of this scan produced
      // against `@guuey/chat` — pinned so the rule can't loosen back.
      "const GGUI_RAIL_TITLES: Record<string, string> = {};",
      "return GGUI_RAIL_TITLES[bareToolName(wireName)];",
      "return s.viewNegotiating;",
      'className="guuey-chat-view guuey-chat-view-negotiating guuey-chat-shimmer"',
      "// A ggui shell negotiates unconditionally before painting.",
      "/** The default: a quiet line while negotiating with the view. */",
    ].join("\n");
    const offenders = proseRuns(stripComments(legitimate)).filter((run) =>
      PROTOCOL_VOCABULARY.test(run),
    );
    expect(offenders).toEqual([]);
  });
});
