/**
 * guuey#2293 — the image attachments a turn may carry, judged at the one send
 * path before anything reaches the wire. V1 is images only, sent inline as
 * base64, under an allowlist, a count and two size caps.
 */
import { describe, expect, it } from "vitest";
import {
  IMAGE_ATTACHMENT_MAX_BASE64_CHARS,
  IMAGE_ATTACHMENT_MIME_TYPES,
  IMAGE_ATTACHMENTS_MAX_COUNT,
  IMAGE_ATTACHMENTS_MAX_TOTAL_BASE64_CHARS,
  isImageAttachmentMimeType,
  validateImageAttachments,
  type ImageAttachment,
} from "./attachments.js";

/** A 1×1 transparent PNG. */
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function png(data = PNG_1PX): ImageAttachment {
  return { kind: "inline", mimeType: "image/png", data };
}

/** A syntactically valid base64 string of exactly `chars` characters (a multiple of 4). */
function base64OfLength(chars: number): string {
  return "A".repeat(chars);
}

describe("the V1 allowlist and caps", () => {
  it("allows exactly the four image types every framework adapter accepts, and no audio", () => {
    expect([...IMAGE_ATTACHMENT_MIME_TYPES]).toEqual(["image/jpeg", "image/png", "image/gif", "image/webp"]);
    expect(isImageAttachmentMimeType("image/png")).toBe(true);
    expect(isImageAttachmentMimeType("image/heic")).toBe(false);
    expect(isImageAttachmentMimeType("audio/webm")).toBe(false);
    expect(isImageAttachmentMimeType("image/svg+xml")).toBe(false);
  });

  it("caps 4 images, 5,000,000 base64 characters each and 8,000,000 in one turn", () => {
    expect(IMAGE_ATTACHMENTS_MAX_COUNT).toBe(4);
    expect(IMAGE_ATTACHMENT_MAX_BASE64_CHARS).toBe(5_000_000);
    expect(IMAGE_ATTACHMENTS_MAX_TOTAL_BASE64_CHARS).toBe(8_000_000);
  });
});

describe("validateImageAttachments", () => {
  it("accepts a valid list and returns it as the wire carries it", () => {
    const result = validateImageAttachments([png(), { kind: "inline", mimeType: "image/jpeg", data: "/9j/4AAQ" }]);
    expect(result).toEqual({
      ok: true,
      attachments: [png(), { kind: "inline", mimeType: "image/jpeg", data: "/9j/4AAQ" }],
    });
  });

  it("an empty list is valid and carries nothing", () => {
    expect(validateImageAttachments([])).toEqual({ ok: true, attachments: [] });
  });

  it("refuses more than the count cap", () => {
    const list = Array.from({ length: IMAGE_ATTACHMENTS_MAX_COUNT + 1 }, () => png());
    expect(validateImageAttachments(list)).toEqual({ ok: false, refusal: { reason: "too_many", max: 4 } });
  });

  it("refuses a type off the allowlist, naming the index (a JS caller is not held by the type)", () => {
    const list: ReadonlyArray<{ kind: "inline"; mimeType: string; data: string }> = [
      png(),
      { kind: "inline", mimeType: "audio/webm", data: "AAAA" },
    ];
    expect(validateImageAttachments(list)).toEqual({
      ok: false,
      refusal: { reason: "unsupported_type", index: 1, mimeType: "audio/webm" },
    });
  });

  it("refuses empty data and data that is not plain base64 (a data: URL prefix, whitespace, bad padding)", () => {
    expect(validateImageAttachments([png("")])).toEqual({ ok: false, refusal: { reason: "not_base64", index: 0 } });
    expect(validateImageAttachments([png(`data:image/png;base64,${PNG_1PX}`)])).toEqual({
      ok: false,
      refusal: { reason: "not_base64", index: 0 },
    });
    expect(validateImageAttachments([png("AAAA\nAAAA")])).toEqual({ ok: false, refusal: { reason: "not_base64", index: 0 } });
    expect(validateImageAttachments([png("AAA")])).toEqual({ ok: false, refusal: { reason: "not_base64", index: 0 } });
  });

  it("refuses one image over the per-image cap, and accepts one exactly at it", () => {
    expect(validateImageAttachments([png(base64OfLength(IMAGE_ATTACHMENT_MAX_BASE64_CHARS))]).ok).toBe(true);
    expect(validateImageAttachments([png(base64OfLength(IMAGE_ATTACHMENT_MAX_BASE64_CHARS + 4))])).toEqual({
      ok: false,
      refusal: { reason: "too_large", index: 0, max: 5_000_000 },
    });
  });

  it("refuses a list whose images are each under the cap but together over the turn's cap", () => {
    const each = 4_000_004; // two of these exceed 8,000,000
    expect(validateImageAttachments([png(base64OfLength(4_000_000)), png(base64OfLength(4_000_000))]).ok).toBe(true);
    expect(validateImageAttachments([png(base64OfLength(each)), png(base64OfLength(each))])).toEqual({
      ok: false,
      refusal: { reason: "total_too_large", max: 8_000_000 },
    });
  });

  it("refuses a kind other than inline (V1 sends no url or storage attachment)", () => {
    const list = [{ kind: "url", mimeType: "image/png", data: "AAAA" }] as const;
    expect(validateImageAttachments(list)).toEqual({ ok: false, refusal: { reason: "unsupported_kind", index: 0 } });
  });
});
