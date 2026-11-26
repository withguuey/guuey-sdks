/**
 * The parts judge: size and shape only. It never refuses a kind or a media type (that is the runtime's word, read off
 * its acknowledgement), and it refuses whole every list the runtime would refuse whole.
 */
import { describe, expect, it } from "vitest";
import {
  describeUserPartRefusal,
  MEDIA_INBOUND_MAX_AUDIO_PARTS_PER_TURN,
  MEDIA_INBOUND_MAX_IMAGES_PER_TURN,
  MEDIA_INBOUND_MAX_PARTS_PER_TURN,
  MEDIA_INBOUND_MAX_STORAGE_REFS_PER_TURN,
  MEDIA_INBOUND_PART_MAX_BASE64_CHARS,
  MEDIA_INBOUND_TURN_MAX_BASE64_CHARS,
  PART_FILE_ID_MAX_CHARS,
  PART_URL_MAX_CHARS,
  shape1AttachmentsOf,
  shape1FormOf,
  USER_PART_SUGGESTED_MIME_TYPES,
  validateUserParts,
  type UserPart,
  type UserPartCandidate,
  type UserPartRefusal,
} from "./user-parts.js";

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const ON_THREAD = { hasThread: true };
const FIRST_CONTACT = { hasThread: false };

function inline(type: string, mediaType: string, data = "AAAA"): UserPartCandidate {
  return { type, source: { type: "base64", mediaType, data } };
}
function link(type: string, url: string): UserPartCandidate {
  return { type, source: { type: "url", url } };
}
function upload(type: string, fileId: string): UserPartCandidate {
  return { type, source: { type: "file", fileId } };
}
function refusalOf(list: readonly UserPartCandidate[], context = ON_THREAD): UserPartRefusal {
  const verdict = validateUserParts(list, context);
  if (verdict.ok) throw new Error("expected a refusal");
  return verdict.refusal;
}

describe("validateUserParts — what passes", () => {
  it("the four kinds pass in their wire shape, in order; a file keeps its filename and a document its title", () => {
    const verdict = validateUserParts(
      [
        inline("image", "image/png", PNG_DATA),
        inline("audio", "audio/wav"),
        { type: "file", source: { type: "base64", mediaType: "text/csv", data: "YSxi" }, filename: "rows.csv" },
        { type: "document", source: { type: "url", url: "https://files.example/a.pdf", mediaType: "application/pdf" }, title: "Terms" },
      ],
      FIRST_CONTACT,
    );
    expect(verdict).toEqual({
      ok: true,
      parts: [
        { type: "image", source: { type: "base64", mediaType: "image/png", data: PNG_DATA } },
        { type: "audio", source: { type: "base64", mediaType: "audio/wav", data: "AAAA" } },
        { type: "file", source: { type: "base64", mediaType: "text/csv", data: "YSxi" }, filename: "rows.csv" },
        { type: "document", source: { type: "url", url: "https://files.example/a.pdf", mediaType: "application/pdf" }, title: "Terms" },
      ],
    });
  });

  it("never refuses a media type: a type off every suggested list is the runtime's to judge", () => {
    for (const mediaType of ["image/heic", "audio/webm", "application/zip", "video/mp4"]) {
      expect(validateUserParts([inline("file", mediaType)], ON_THREAD).ok).toBe(true);
    }
    expect(USER_PART_SUGGESTED_MIME_TYPES.image).toEqual(["image/jpeg", "image/png", "image/gif", "image/webp"]);
  });

  it("an uploaded object passes on a thread that exists, and takes no inline room", () => {
    const big = "A".repeat(MEDIA_INBOUND_PART_MAX_BASE64_CHARS);
    const verdict = validateUserParts([inline("document", "application/pdf", big), upload("document", "obj_1")], ON_THREAD);
    expect(verdict).toEqual({
      ok: true,
      parts: [
        { type: "document", source: { type: "base64", mediaType: "application/pdf", data: big } },
        { type: "document", source: { type: "file", fileId: "obj_1" } },
      ],
    });
  });

  it("a link names its media type only when the caller gave one", () => {
    expect(validateUserParts([link("image", "https://cdn.example/a.png")], ON_THREAD)).toEqual({
      ok: true,
      parts: [{ type: "image", source: { type: "url", url: "https://cdn.example/a.png" } }],
    });
  });
});

describe("validateUserParts — every refusal", () => {
  it("unsupported_kind: a block type outside the four", () => {
    expect(refusalOf([inline("image", "image/png"), inline("video", "video/mp4")])).toEqual({
      reason: "unsupported_kind",
      index: 1,
      type: "video",
    });
  });

  it("source_unsupported: a source that is none of base64, url and file", () => {
    expect(refusalOf([{ type: "image", source: { type: "text" } }])).toEqual({ reason: "source_unsupported", index: 0, source: "text" });
  });

  it("missing_media_type: an inline part that does not name its type", () => {
    expect(refusalOf([inline("file", "")])).toEqual({ reason: "missing_media_type", index: 0 });
    expect(refusalOf([{ type: "file", source: { type: "base64", data: "AAAA" } }])).toEqual({ reason: "missing_media_type", index: 0 });
  });

  it("not_base64: empty, unpadded or off-alphabet data", () => {
    for (const data of ["", "AAA", "AA$A", "data:image/png;base64,AAAA"]) {
      expect(refusalOf([inline("image", "image/png", data)])).toEqual({ reason: "not_base64", index: 0 });
    }
  });

  it("too_large: one inline part over the per-part cap", () => {
    expect(refusalOf([inline("audio", "audio/wav", "A".repeat(MEDIA_INBOUND_PART_MAX_BASE64_CHARS + 4))])).toEqual({
      reason: "too_large",
      index: 0,
      max: MEDIA_INBOUND_PART_MAX_BASE64_CHARS,
    });
  });

  it("total_too_large: every inline kind shares ONE room", () => {
    const half = "A".repeat(MEDIA_INBOUND_TURN_MAX_BASE64_CHARS / 2);
    expect(refusalOf([inline("image", "image/png", half), inline("document", "application/pdf", `${half}AAAA`)])).toEqual({
      reason: "total_too_large",
      max: MEDIA_INBOUND_TURN_MAX_BASE64_CHARS,
    });
    expect(validateUserParts([inline("image", "image/png", half), inline("document", "application/pdf", half)], ON_THREAD).ok).toBe(true);
  });

  it("too_many: at most 4 images", () => {
    const images = Array.from({ length: MEDIA_INBOUND_MAX_IMAGES_PER_TURN + 1 }, () => inline("image", "image/png"));
    expect(refusalOf(images)).toEqual({ reason: "too_many", kind: "image", max: MEDIA_INBOUND_MAX_IMAGES_PER_TURN });
    expect(validateUserParts(images.slice(1), ON_THREAD).ok).toBe(true);
  });

  it("too_many: at most ONE audio part, inline or not (2 refused, 1 passes)", () => {
    expect(MEDIA_INBOUND_MAX_AUDIO_PARTS_PER_TURN).toBe(1);
    expect(refusalOf([inline("audio", "audio/wav"), link("audio", "https://files.example/b.mp3")])).toEqual({
      reason: "too_many",
      kind: "audio",
      max: MEDIA_INBOUND_MAX_AUDIO_PARTS_PER_TURN,
    });
    expect(validateUserParts([inline("audio", "audio/wav"), inline("image", "image/png")], ON_THREAD).ok).toBe(true);
  });

  it("too_many_parts: at most 16 parts of every kind together", () => {
    const docs = Array.from({ length: MEDIA_INBOUND_MAX_PARTS_PER_TURN + 1 }, (_, i) => link("document", `https://files.example/${i}.pdf`));
    expect(refusalOf(docs)).toEqual({ reason: "too_many_parts", max: MEDIA_INBOUND_MAX_PARTS_PER_TURN });
    expect(validateUserParts(docs.slice(1), ON_THREAD).ok).toBe(true);
  });

  it("too_many_file_refs: at most 5 uploaded objects", () => {
    const uploads = Array.from({ length: MEDIA_INBOUND_MAX_STORAGE_REFS_PER_TURN + 1 }, (_, i) => upload("file", `obj_${i}`));
    expect(refusalOf(uploads)).toEqual({ reason: "too_many_file_refs", max: MEDIA_INBOUND_MAX_STORAGE_REFS_PER_TURN });
    expect(validateUserParts(uploads.slice(1), ON_THREAD).ok).toBe(true);
  });

  it("not_https and url_too_long: a link is https and bounded", () => {
    expect(refusalOf([link("image", "http://cdn.example/a.png")])).toEqual({ reason: "not_https", index: 0 });
    const long = `https://cdn.example/${"a".repeat(PART_URL_MAX_CHARS)}`;
    expect(refusalOf([link("image", long)])).toEqual({ reason: "url_too_long", index: 0, max: PART_URL_MAX_CHARS });
  });

  it("bad_file_id: an uploaded object with no id, or one too long", () => {
    expect(refusalOf([upload("image", "")])).toEqual({ reason: "bad_file_id", index: 0, max: PART_FILE_ID_MAX_CHARS });
    expect(refusalOf([{ type: "image", source: { type: "file" } }])).toEqual({ reason: "bad_file_id", index: 0, max: PART_FILE_ID_MAX_CHARS });
    expect(refusalOf([upload("image", "f".repeat(PART_FILE_ID_MAX_CHARS + 1))])).toEqual({
      reason: "bad_file_id",
      index: 0,
      max: PART_FILE_ID_MAX_CHARS,
    });
    expect(validateUserParts([upload("image", "f".repeat(PART_FILE_ID_MAX_CHARS))], ON_THREAD).ok).toBe(true);
  });

  it("file_source_needs_thread: an uploaded object on a first-contact turn", () => {
    expect(refusalOf([inline("image", "image/png"), upload("audio", "obj_1")], FIRST_CONTACT)).toEqual({
      reason: "file_source_needs_thread",
      index: 1,
    });
  });

  it("every refusal has a plain sentence", () => {
    const refusals: UserPartRefusal[] = [
      { reason: "unsupported_kind", index: 0, type: "video" },
      { reason: "source_unsupported", index: 0, source: "text" },
      { reason: "missing_media_type", index: 0 },
      { reason: "not_base64", index: 0 },
      { reason: "too_large", index: 0, max: 1 },
      { reason: "total_too_large", max: 1 },
      { reason: "too_many", kind: "image", max: 4 },
      { reason: "too_many", kind: "audio", max: 1 },
      { reason: "too_many_parts", max: 16 },
      { reason: "too_many_file_refs", max: 5 },
      { reason: "not_https", index: 0 },
      { reason: "url_too_long", index: 0, max: 1 },
      { reason: "bad_file_id", index: 0, max: 1 },
      { reason: "file_source_needs_thread", index: 0 },
      { reason: "shape1_cannot_carry", index: 0, kind: "audio" },
    ];
    for (const refusal of refusals) expect(describeUserPartRefusal(refusal)).toMatch(/\S/);
    expect(describeUserPartRefusal({ reason: "too_many", kind: "audio", max: 1 })).toMatch(/recording/);
  });
});

describe("shape 1's form of a judged list", () => {
  const png: UserPart = { type: "image", source: { type: "base64", mediaType: "image/png", data: PNG_DATA } };

  it("images inline in the four types and by link become today's attachments", () => {
    const byLink: UserPart = { type: "image", source: { type: "url", url: "https://cdn.example/a.webp", mediaType: "image/webp" } };
    const byBareLink: UserPart = { type: "image", source: { type: "url", url: "https://cdn.example/a" } };
    expect(shape1AttachmentsOf([png, byLink, byBareLink])).toEqual([
      { kind: "inline", mimeType: "image/png", data: PNG_DATA },
      { kind: "url", url: "https://cdn.example/a.webp", mimeType: "image/webp" },
      { kind: "url", url: "https://cdn.example/a" },
    ]);
    expect(shape1AttachmentsOf([])).toEqual([]);
  });

  it("any part shape 1 cannot carry: undefined, and the form names the first", () => {
    const audio: UserPart = { type: "audio", source: { type: "base64", mediaType: "audio/wav", data: "AAAA" } };
    const uploaded: UserPart = { type: "image", source: { type: "file", fileId: "obj_1" } };
    const heic: UserPart = { type: "image", source: { type: "base64", mediaType: "image/heic", data: "AAAA" } };
    for (const odd of [audio, uploaded, heic]) {
      expect(shape1AttachmentsOf([png, odd])).toBeUndefined();
      expect(shape1FormOf([png, odd])).toEqual({ ok: false, refusal: { reason: "shape1_cannot_carry", index: 1, kind: odd.type } });
    }
  });
});
