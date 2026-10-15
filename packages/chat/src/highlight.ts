/**
 * Code presentation, platform-free (guuey#2367): one model that the web kit
 * and the native kit both render, so a code fence or a tool result looks the
 * same on every surface. Each renderer only maps a {@link HighlightKind} to a
 * colour; nothing here knows about the DOM or React Native.
 *
 * Two promises, each pinned by a test:
 *  - LOSSLESS: the concatenated `text` of the tokens equals the input, byte
 *    for byte, whitespace and newlines included, so a renderer may split on
 *    `\n` itself or draw one element per token.
 *  - BOUNDED: tokenizing is a single forward pass, with no regex backtracking
 *    over unbounded input, and input longer than {@link HIGHLIGHT_MAX_CHARS} is
 *    returned as one `plain` token instead of being scanned.
 */

/** What a token is. A closed set: a renderer handles every member. */
export type HighlightKind = "keyword" | "string" | "number" | "punctuation" | "comment" | "key" | "plain";

export interface HighlightToken {
  readonly text: string;
  readonly kind: HighlightKind;
}

/** Beyond this, a block is shown as plain text, never scanned. */
export const HIGHLIGHT_MAX_CHARS = 200_000;

/**
 * `text` re-indented with two spaces when it parses as JSON (an object or an
 * array), else null. Never throws. A JSON scalar ("1", "\"x\"") is not worth
 * re-printing, so it is null too.
 */
export function prettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // not JSON: the caller shows the text as it came
  }
  return typeof parsed === "object" && parsed !== null ? JSON.stringify(parsed, null, 2) : null;
}

const JSON_LANGS = new Set(["json", "jsonc", "json5"]);
const KEYWORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  js: new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "new", "class", "extends", "import", "export", "from", "default", "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "true", "false", "null", "undefined", "this", "yield"]),
  py: new Set(["def", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "import", "from", "as", "class", "try", "except", "finally", "raise", "with", "lambda", "yield", "pass", "break", "continue", "True", "False", "None", "async", "await", "is"]),
  sh: new Set(["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac", "function", "return", "export", "local", "echo"]),
};
const LANG_FAMILY: Readonly<Record<string, keyof typeof KEYWORDS>> = {
  js: "js", javascript: "js", jsx: "js", ts: "js", typescript: "js", tsx: "js", mjs: "js", cjs: "js",
  py: "py", python: "py",
  sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh",
};

/**
 * Tokens for `code` in `lang` (a fence's info string, case-insensitive). JSON
 * gets keys, strings, numbers and literals; js/ts, python and shell get
 * strings, numbers, comments and keywords; anything else is one `plain` token.
 */
export function highlightCode(code: string, lang?: string): HighlightToken[] {
  if (code.length === 0) return [];
  if (code.length > HIGHLIGHT_MAX_CHARS) return [{ text: code, kind: "plain" }];
  const l = (lang ?? "").trim().toLowerCase();
  if (JSON_LANGS.has(l)) return tokenizeJson(code);
  const family = LANG_FAMILY[l];
  if (family !== undefined) return tokenizeCode(code, family);
  return [{ text: code, kind: "plain" }];
}

/** Appends, merging runs of the same kind so renderers draw fewer elements. */
function push(out: HighlightToken[], text: string, kind: HighlightKind): void {
  if (text.length === 0) return;
  const last = out[out.length - 1];
  if (last !== undefined && last.kind === kind) out[out.length - 1] = { text: last.text + text, kind };
  else out.push({ text, kind });
}

/** The end index (exclusive) of a quoted string starting at `start`, honouring backslash escapes; stops at a newline for an unterminated string. */
function stringEnd(src: string, start: number, quote: string, multiline: boolean): number {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === quote) return i + 1;
    if (c === "\n" && !multiline) return i;
    i++;
  }
  return src.length;
}

function numberEnd(src: string, start: number): number {
  let i = start;
  if (src[i] === "-") i++;
  while (i < src.length && /[0-9a-fA-FxXoObB._eE+-]/.test(src[i]!)) {
    // a sign is part of a number only right after an exponent
    if ((src[i] === "+" || src[i] === "-") && !/[eE]/.test(src[i - 1] ?? "")) break;
    i++;
  }
  return i;
}

function tokenizeJson(src: string): HighlightToken[] {
  const out: HighlightToken[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"') {
      const end = stringEnd(src, i, '"', false);
      // a string followed (after spaces) by ':' is an object key
      let j = end;
      while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
      push(out, src.slice(i, end), src[j] === ":" ? "key" : "string");
      i = end;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      const end = Math.max(numberEnd(src, i), i + 1);
      push(out, src.slice(i, end), "number");
      i = end;
    } else if ("{}[]:,".includes(c)) {
      push(out, c, "punctuation");
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      let end = i;
      while (end < src.length && /[A-Za-z0-9_]/.test(src[end]!)) end++;
      const word = src.slice(i, end);
      push(out, word, word === "true" || word === "false" || word === "null" ? "keyword" : "plain");
      i = end;
    } else if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? src.length : nl;
      push(out, src.slice(i, end), "comment"); // jsonc
      i = end;
    } else {
      push(out, c, "plain");
      i++;
    }
  }
  return out;
}

function tokenizeCode(src: string, family: keyof typeof KEYWORDS): HighlightToken[] {
  const keywords = KEYWORDS[family]!;
  const out: HighlightToken[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const lineComment = (family === "js" && c === "/" && src[i + 1] === "/") || (family !== "js" && c === "#");
    if (lineComment) {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? src.length : nl;
      push(out, src.slice(i, end), "comment");
      i = end;
    } else if (family === "js" && c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? src.length : close + 2;
      push(out, src.slice(i, end), "comment");
      i = end;
    } else if (c === '"' || c === "'" || (family === "js" && c === "`")) {
      const end = stringEnd(src, i, c, c === "`");
      push(out, src.slice(i, end), "string");
      i = end;
    } else if (c >= "0" && c <= "9" && !/[A-Za-z0-9_$]/.test(src[i - 1] ?? "")) {
      const end = Math.max(numberEnd(src, i), i + 1);
      push(out, src.slice(i, end), "number");
      i = end;
    } else if (/[A-Za-z_$]/.test(c)) {
      let end = i;
      while (end < src.length && /[A-Za-z0-9_$]/.test(src[end]!)) end++;
      const word = src.slice(i, end);
      push(out, word, keywords.has(word) ? "keyword" : "plain");
      i = end;
    } else if ("{}[]();,.:=<>+-*/%!&|?".includes(c)) {
      push(out, c, "punctuation");
      i++;
    } else {
      push(out, c, "plain");
      i++;
    }
  }
  return out;
}
