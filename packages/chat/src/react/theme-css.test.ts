/**
 * The stylesheet ↔ `themeCssVars` contract (guuey#1126, audit G25): every
 * read of a themed token in `styles.css` composes the two channels —
 * `var(--guuey-chat-<t>, var(--_guuey-chat-<t>))` — so a host variable
 * wins per-token AND the resolved theme still reaches the rule when the
 * host sets nothing. A bare `var(--guuey-chat-<t>)` resolves to NOTHING
 * unless the host themes that token explicitly (ten such reads left the
 * chips border, clear-row and link-ask unthemed even inside the stamp's
 * scope). This lint keeps the class from returning.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GUUEY_CHAT_THEME } from "../theme.js";
import { themeCssVars } from "./theme-css.js";

const INTERNAL_PREFIX = "--_guuey-chat-";
const PUBLIC_PREFIX = "--guuey-chat-";

/** Every token the kit stamps, optional ones included (link, fonts). */
const THEMED_TOKENS: ReadonlySet<string> = new Set(
  Object.keys(
    themeCssVars(
      {
        ...GUUEY_CHAT_THEME,
        typography: { fontFamily: "Inter", monoFontFamily: "JetBrains Mono" },
      },
      "light",
    ),
  ).map((name) => name.slice(INTERNAL_PREFIX.length)),
);

const STYLESHEET = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

/** `line:col` of a character offset, for a violation message worth reading. */
function locate(offset: number): string {
  const before = STYLESHEET.slice(0, offset);
  const line = before.split("\n").length;
  const col = offset - before.lastIndexOf("\n");
  return `styles.css:${line}:${col}`;
}

describe("styles.css reads every themed token through both channels (guuey#1126 G25)", () => {
  it("derives a non-trivial token set from themeCssVars", () => {
    expect(THEMED_TOKENS.has("accent")).toBe(true);
    expect(THEMED_TOKENS.has("gap")).toBe(true);
    expect(THEMED_TOKENS.has("link")).toBe(true);
    expect(THEMED_TOKENS.has("mono-font")).toBe(true);
  });

  it("no public read of a themed token lacks its internal fallback; no public read at all is bare", () => {
    const violations: string[] = [];
    const publicRead = /var\(--guuey-chat-([a-z0-9-]+)(\s*[,)])/g;
    for (const match of STYLESHEET.matchAll(publicRead)) {
      const token = match[1];
      const after = STYLESHEET.slice(match.index + match[0].length - match[2].length);
      const at = locate(match.index);
      if (THEMED_TOKENS.has(token)) {
        const expected = `, var(${INTERNAL_PREFIX}${token}`;
        if (!after.startsWith(expected)) {
          violations.push(`${at}: var(${PUBLIC_PREFIX}${token}…) must read as var(${PUBLIC_PREFIX}${token}, var(${INTERNAL_PREFIX}${token}…)) — got ${JSON.stringify(match[0] + after.slice(match[2].length, match[2].length + 24))}`);
        }
      } else if (match[2].trimStart() === ")") {
        violations.push(`${at}: var(${PUBLIC_PREFIX}${token}) is a bare public read with no fallback`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("no internal token is read on its own — the host channel must wrap it", () => {
    const violations: string[] = [];
    const internalRead = /var\(--_guuey-chat-([a-z0-9-]+)/g;
    for (const match of STYLESHEET.matchAll(internalRead)) {
      const token = match[1];
      const expectedWrapper = `var(${PUBLIC_PREFIX}${token}, `;
      const before = STYLESHEET.slice(Math.max(0, match.index - expectedWrapper.length), match.index);
      if (before !== expectedWrapper) {
        violations.push(`${locate(match.index)}: var(${INTERNAL_PREFIX}${token}…) read without the var(${PUBLIC_PREFIX}${token}, …) wrapper`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("every themed token is read at least once by the stylesheet (a stamped-but-unread token is dead theme data)", () => {
    const unread = [...THEMED_TOKENS].filter(
      (token) => !STYLESHEET.includes(`var(${PUBLIC_PREFIX}${token}, var(${INTERNAL_PREFIX}${token}`),
    );
    expect(unread).toEqual([]);
  });
});
