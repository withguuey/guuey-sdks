/**
 * The rules for a worker's request to end the conversation
 * ({@link EndThread}): one place, read by the worker SDK before it writes the
 * request, by `parseEvent` before it keeps one, and by a Router before it acts
 * on one. A request that breaks a rule is refused whole, never trimmed.
 */
import type { EndThread } from "./protocol.js";

/** A code is 1–40 characters: an upper-case letter, then upper-case letters, digits or `_`. */
export const END_THREAD_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;
/** The longest message, in characters (Unicode code points, not UTF-16 units). */
export const END_THREAD_MESSAGE_MAX_CHARS = 500;

/** Whether `text` holds a control character other than `\n` (C0, DEL and C1 alike). */
function hasForbiddenControl(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp <= 0x1f && cp !== 0x0a) || (cp >= 0x7f && cp <= 0x9f)) return true;
  }
  return false;
}

/**
 * Why `request` is not a valid {@link EndThread}, or `undefined` when it is.
 * The answer names the field ("code ..." or "message ..."), never the value.
 */
export function endThreadProblem(request: EndThread): string | undefined {
  if (typeof request.code !== "string" || !END_THREAD_CODE_PATTERN.test(request.code)) {
    return "code must be 1-40 characters: an upper-case letter, then upper-case letters, digits or _";
  }
  if (typeof request.message !== "string") return "message must be a string";
  const chars = Array.from(request.message).length;
  if (chars === 0 || chars > END_THREAD_MESSAGE_MAX_CHARS) {
    return `message must be 1-${END_THREAD_MESSAGE_MAX_CHARS} characters`;
  }
  if (hasForbiddenControl(request.message)) {
    return "message must not contain control characters other than a line feed";
  }
  return undefined;
}
