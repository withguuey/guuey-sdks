/**
 * The ONE hash of a user turn's content blocks for thread resume. Every value the
 * host reports about a turn (the prompt it sends, its own input text) and every
 * value it measures in a stored session file is computed here, so the two sides
 * of a compare can only differ when the content does.
 *
 * It hashes PARSED blocks, never JSON text: the CLI re-serializes what it stores,
 * so key order and escaping are not content. Per block, in order: the `type`;
 * then a text block's UTF-8 bytes, or an image block's `media_type` and its exact
 * base64 `data`. Every field is length-prefixed, so "ab" in one block and "a", "b"
 * in two hash differently. Any other block type is not hashable: the caller
 * treats it as content it cannot vouch for.
 *
 * {@link CLI_SESSION_HASH_VERSION} (in `@guuey/worker`) names this form. Changing
 * what is hashed, or how, bumps it, so a Router comparing values from two forms
 * resets the thread benignly instead of reading the change as a tamper.
 */
import { createHash } from "node:crypto";
import { isInvokeImageMimeType, type AnthropicUserBlock } from "@guuey/worker";

/** sha256 over length-prefixed fields: each field is its 4-byte big-endian byte length, then its bytes. */
export function sha256OfFields(fields: readonly string[]): string {
  const hash = createHash("sha256");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/** The fields one block contributes, in order. */
function blockFields(block: AnthropicUserBlock): string[] {
  if (block.type === "text") return ["text", block.text];
  return ["image", block.source.media_type, block.source.data];
}

/** The hash of a user turn's content blocks, in order. */
export function hashUserBlocks(blocks: readonly AnthropicUserBlock[]): string {
  return sha256OfFields(blocks.flatMap(blockFields));
}

/** The hash of one text, as a single text block (the stored `lastPrompt`, the invoke's own text). */
export function hashUserText(text: string): string {
  return hashUserBlocks([{ type: "text", text }]);
}

/** The hash of a system prompt: its own field name first, so it never equals a user block's hash. */
export function hashSystemPrompt(text: string): string {
  return sha256OfFields(["system", text]);
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A stored message's `content`, read as hashable blocks: a string is one text
 * block (the CLI's plain form); an array must hold only text and base64 image
 * blocks. Anything else returns `null`, which the caller reports as unclassified.
 */
export function parseStoredUserContent(content: unknown): AnthropicUserBlock[] | null {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return null;
  const blocks: AnthropicUserBlock[] = [];
  for (const item of content) {
    if (!isRecord(item)) return null;
    if (item.type === "text" && typeof item.text === "string") {
      blocks.push({ type: "text", text: item.text });
      continue;
    }
    if (item.type === "image" && isRecord(item.source)) {
      const { type, media_type: mediaType, data } = item.source;
      if (type !== "base64" || typeof data !== "string" || typeof mediaType !== "string" || !isInvokeImageMimeType(mediaType)) {
        return null;
      }
      blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
      continue;
    }
    return null;
  }
  return blocks;
}
