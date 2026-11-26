/**
 * A turn's user parts: the caps and the ONE judge (request shape 2).
 *
 * A part is one of the protocol's four user block kinds (`image`, `audio`, `file`, `document`), each carrying an
 * `AgSource`. The judge holds the rules of SIZE and SHAPE so a body the runtime would refuse whole never reaches the
 * wire. It never decides which kinds or which media types an agent takes: that is the runtime's word alone (its ack
 * on the `session` frame, `accepts.parts`), so a kind the client has not heard of an agent taking is still sent, and
 * the turn ends `PARTS_UNSUPPORTED` when the runtime does not acknowledge it. The runtime judges every part again and
 * never trusts this one.
 *
 * The rules (the caps are {@link MEDIA_INBOUND_MAX_PARTS_PER_TURN} and its neighbours):
 *  - at most 16 parts per turn, of them at most 4 images and 1 audio part (one cap each, as the runtime's);
 *  - every inline (`base64`) part shares ONE room of 6,000,000 base64 characters, with 5,000,000 per part, and names
 *    its `mediaType`;
 *  - a link is `https` and at most {@link PART_URL_MAX_CHARS} characters;
 *  - an uploaded object (`source: file`) names a `fileId` of at most {@link PART_FILE_ID_MAX_CHARS} characters, takes
 *    no room, at most 5 per turn, and only rides a turn on a thread that already exists (an upload belongs to its
 *    thread, and a first-contact turn has none yet);
 *  - a block type outside the four kinds is refused: the client builds only these.
 */
import type { AgBlock } from "@silverprotocol/core";
import { IMAGE_ATTACHMENT_MIME_TYPES, type TurnAttachment } from "./attachments.js";

/** The four user part kinds: the protocol's own block types. */
export const USER_PART_KINDS = ["image", "audio", "file", "document"] as const;

/** One of {@link USER_PART_KINDS}. */
export type UserPartKind = (typeof USER_PART_KINDS)[number];

/** A user part on the wire: exactly the protocol's block of that kind. */
export type UserPart = Extract<AgBlock, { type: UserPartKind }>;

/**
 * The media types a file picker offers for each kind (its `accept`). A HINT for a picker only, never a gate: the judge
 * reads no media type against it, and an agent's runtime may take types this list does not name.
 */
export const USER_PART_SUGGESTED_MIME_TYPES: { readonly [kind in UserPartKind]: readonly string[] } = Object.freeze({
  image: IMAGE_ATTACHMENT_MIME_TYPES,
  audio: Object.freeze(["audio/wav", "audio/mpeg"]),
  file: Object.freeze(["text/plain", "text/markdown", "text/csv", "application/json"]),
  document: Object.freeze(["application/pdf"]),
});

/*
 * The inbound media caps: a courtesy mirror of @guuey-private/media-signing; a sync test pins equality. That package
 * is the one home of these numbers and the runtime enforces them; this public package cannot import it, so it keeps
 * the same names and values and refuses a turn the runtime would refuse whole.
 */

/** At most this many parts in one turn, of every kind together. */
export const MEDIA_INBOUND_MAX_PARTS_PER_TURN = 16;

/** At most this many uploaded objects (`source: file`) in one turn. */
export const MEDIA_INBOUND_MAX_STORAGE_REFS_PER_TURN = 5;

/** At most this many images in one turn. */
export const MEDIA_INBOUND_MAX_IMAGES_PER_TURN = 4;

/** At most this many audio parts in one turn (counted inside the turn's parts). */
export const MEDIA_INBOUND_MAX_AUDIO_PARTS_PER_TURN = 1;

/** One inline part's base64 text is at most this many characters. */
export const MEDIA_INBOUND_PART_MAX_BASE64_CHARS = 5_000_000;

/** One turn's inline parts together are at most this many base64 characters. */
export const MEDIA_INBOUND_TURN_MAX_BASE64_CHARS = 6_000_000;


/** A part's link is at most this many characters. */
export const PART_URL_MAX_CHARS = 4096;

/** An uploaded object's id is at most this many characters. */
export const PART_FILE_ID_MAX_CHARS = 1024;

/**
 * What a caller hands the judge. Wider than {@link UserPart} on purpose, like `ImageAttachmentCandidate`: a JavaScript
 * caller (or a host reading a file it did not type) is not held by the type, so the judge reads strings and decides.
 */
export interface UserPartCandidate {
  readonly type: string;
  readonly source: {
    readonly type: string;
    readonly mediaType?: string;
    readonly data?: string;
    readonly url?: string;
    readonly fileId?: string;
  };
  readonly filename?: string;
  readonly title?: string;
}

/** What the judge knows of the turn beside its parts. */
export interface UserPartsContext {
  /** The turn goes to a thread that already exists (not first contact): the one place an uploaded object may ride. */
  readonly hasThread: boolean;
}

/** Why a list was refused. `index` names the first part that broke a rule. */
export type UserPartRefusal =
  | { reason: "unsupported_kind"; index: number; type: string }
  | { reason: "source_unsupported"; index: number; source: string }
  | { reason: "missing_media_type"; index: number }
  | { reason: "not_base64"; index: number }
  | { reason: "too_large"; index: number; max: number }
  | { reason: "total_too_large"; max: number }
  | { reason: "too_many"; kind: UserPartKind; max: number }
  | { reason: "too_many_parts"; max: number }
  | { reason: "too_many_file_refs"; max: number }
  | { reason: "not_https"; index: number }
  | { reason: "url_too_long"; index: number; max: number }
  | { reason: "bad_file_id"; index: number; max: number }
  | { reason: "file_source_needs_thread"; index: number }
  /** Not the judge's: request shape 1 carries attached JPEG, PNG, GIF and WebP images only ({@link shape1FormOf}). */
  | { reason: "shape1_cannot_carry"; index: number; kind: UserPartKind };

export type UserPartsVerdict = { ok: true; parts: UserPart[] } | { ok: false; refusal: UserPartRefusal };

/** Standard base64: the 64-letter alphabet, padded to a multiple of 4, nothing else. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether `type` is one of {@link USER_PART_KINDS}. */
export function isUserPartKind(type: string): type is UserPartKind {
  return (USER_PART_KINDS as readonly string[]).includes(type);
}

/**
 * Judge a turn's parts, all or nothing: every part passes and the list comes back in its wire shape, or the first broken
 * rule is named and nothing is sent.
 */
export function validateUserParts(list: readonly UserPartCandidate[], context: UserPartsContext): UserPartsVerdict {
  if (list.length > MEDIA_INBOUND_MAX_PARTS_PER_TURN) {
    return { ok: false, refusal: { reason: "too_many_parts", max: MEDIA_INBOUND_MAX_PARTS_PER_TURN } };
  }
  const parts: UserPart[] = [];
  const counts: { [kind in UserPartKind]: number } = { image: 0, audio: 0, file: 0, document: 0 };
  let fileRefs = 0;
  let total = 0;
  for (const [index, candidate] of list.entries()) {
    const { type, source } = candidate;
    if (!isUserPartKind(type)) return { ok: false, refusal: { reason: "unsupported_kind", index, type } };
    counts[type] += 1;
    if (type === "image" && counts.image > MEDIA_INBOUND_MAX_IMAGES_PER_TURN) {
      return { ok: false, refusal: { reason: "too_many", kind: "image", max: MEDIA_INBOUND_MAX_IMAGES_PER_TURN } };
    }
    if (type === "audio" && counts.audio > MEDIA_INBOUND_MAX_AUDIO_PARTS_PER_TURN) {
      return { ok: false, refusal: { reason: "too_many", kind: "audio", max: MEDIA_INBOUND_MAX_AUDIO_PARTS_PER_TURN } };
    }
    const mediaType = source.mediaType ?? "";
    const named = mediaType !== "" ? { mediaType } : {};
    if (source.type === "url") {
      const url = source.url ?? "";
      if (!url.startsWith("https://")) return { ok: false, refusal: { reason: "not_https", index } };
      if (url.length > PART_URL_MAX_CHARS) {
        return { ok: false, refusal: { reason: "url_too_long", index, max: PART_URL_MAX_CHARS } };
      }
      parts.push(partOf(type, { type: "url", url, ...named }, candidate));
      continue;
    }
    if (source.type === "file") {
      const fileId = source.fileId ?? "";
      if (fileId === "" || fileId.length > PART_FILE_ID_MAX_CHARS) {
        return { ok: false, refusal: { reason: "bad_file_id", index, max: PART_FILE_ID_MAX_CHARS } };
      }
      if (!context.hasThread) return { ok: false, refusal: { reason: "file_source_needs_thread", index } };
      fileRefs += 1;
      if (fileRefs > MEDIA_INBOUND_MAX_STORAGE_REFS_PER_TURN) {
        return { ok: false, refusal: { reason: "too_many_file_refs", max: MEDIA_INBOUND_MAX_STORAGE_REFS_PER_TURN } };
      }
      parts.push(partOf(type, { type: "file", fileId, ...named }, candidate));
      continue;
    }
    if (source.type !== "base64") {
      return { ok: false, refusal: { reason: "source_unsupported", index, source: source.type } };
    }
    if (mediaType === "") return { ok: false, refusal: { reason: "missing_media_type", index } };
    const data = source.data ?? "";
    if (data.length > MEDIA_INBOUND_PART_MAX_BASE64_CHARS) {
      return { ok: false, refusal: { reason: "too_large", index, max: MEDIA_INBOUND_PART_MAX_BASE64_CHARS } };
    }
    if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) {
      return { ok: false, refusal: { reason: "not_base64", index } };
    }
    total += data.length;
    parts.push(partOf(type, { type: "base64", mediaType, data }, candidate));
  }
  if (total > MEDIA_INBOUND_TURN_MAX_BASE64_CHARS) {
    return { ok: false, refusal: { reason: "total_too_large", max: MEDIA_INBOUND_TURN_MAX_BASE64_CHARS } };
  }
  return { ok: true, parts };
}

type PartSource = UserPart["source"];

/** The wire block for a judged part; `filename` / `title` ride only on the kinds that carry them. */
function partOf(kind: UserPartKind, source: PartSource, candidate: UserPartCandidate): UserPart {
  switch (kind) {
    case "image":
      return { type: "image", source };
    case "audio":
      return { type: "audio", source };
    case "file":
      return { type: "file", source, ...(candidate.filename !== undefined ? { filename: candidate.filename } : {}) };
    case "document":
      return { type: "document", source, ...(candidate.title !== undefined ? { title: candidate.title } : {}) };
  }
}

/** The image type shape 1 names for a part, when it is one of the four that shape carries. */
function shape1ImageTypeOf(mediaType: string | undefined): (typeof IMAGE_ATTACHMENT_MIME_TYPES)[number] | undefined {
  return IMAGE_ATTACHMENT_MIME_TYPES.find((t) => t === mediaType);
}

/** A judged list in request shape 1's form, or the first part that shape cannot carry. */
export type Shape1Form = { ok: true; attachments: TurnAttachment[] } | { ok: false; refusal: UserPartRefusal };

/**
 * Shape 1's form of a judged list: its `attachments`, which hold images only, inline in one of the four image types or
 * by link. Every other part (a recording, a file, a document, an uploaded object) has no shape-1 form, so a turn that
 * must go as shape 1 is refused (`PARTS_INVALID`, `shape1_cannot_carry`) rather than sent without it.
 */
export function shape1FormOf(parts: readonly UserPart[]): Shape1Form {
  const attachments: TurnAttachment[] = [];
  for (const [index, part] of parts.entries()) {
    const source = part.source;
    const mimeType = shape1ImageTypeOf(source.mediaType);
    if (part.type === "image" && source.type === "base64" && mimeType !== undefined) {
      attachments.push({ kind: "inline", mimeType, data: source.data });
    } else if (part.type === "image" && source.type === "url") {
      attachments.push(mimeType === undefined ? { kind: "url", url: source.url } : { kind: "url", url: source.url, mimeType });
    } else {
      return { ok: false, refusal: { reason: "shape1_cannot_carry", index, kind: part.type } };
    }
  }
  return { ok: true, attachments };
}

/** {@link shape1FormOf}'s attachments, or `undefined` when any part has no shape-1 form. */
export function shape1AttachmentsOf(parts: readonly UserPart[]): TurnAttachment[] | undefined {
  const form = shape1FormOf(parts);
  return form.ok ? form.attachments : undefined;
}

/** A plain sentence for a refusal: the hook's `error` beside `PARTS_INVALID`. */
export function describeUserPartRefusal(refusal: UserPartRefusal): string {
  switch (refusal.reason) {
    case "unsupported_kind":
      return `Part ${refusal.index + 1} is a ${refusal.type}, which a message cannot carry.`;
    case "source_unsupported":
      return `Part ${refusal.index + 1} cannot be sent that way; attach the file itself or send a link.`;
    case "missing_media_type":
      return `Part ${refusal.index + 1} does not say what type of file it is.`;
    case "not_base64":
      return `Part ${refusal.index + 1} is not base64 data.`;
    case "too_large":
      return `Part ${refusal.index + 1} is too large to send.`;
    case "total_too_large":
      return "These attachments are too large to send together.";
    case "too_many_parts":
      return `A message can carry at most ${refusal.max} attachments.`;
    case "too_many_file_refs":
      return `A message can carry at most ${refusal.max} uploaded files.`;
    case "too_many":
      return `A message can carry at most ${refusal.max} ${refusal.kind === "audio" ? "recording" : "images"}.`;
    case "not_https":
      return `Part ${refusal.index + 1} is not an https link.`;
    case "url_too_long":
      return `Part ${refusal.index + 1}'s link is too long.`;
    case "bad_file_id":
      return `Part ${refusal.index + 1} names no uploaded file, or one whose id is too long.`;
    case "file_source_needs_thread":
      return `Part ${refusal.index + 1} is an uploaded file, which can only be sent in a conversation that has already started.`;
    case "shape1_cannot_carry":
      return `Part ${refusal.index + 1} cannot be sent to this agent yet: its runtime takes only attached JPEG, PNG, GIF or WebP images.`;
  }
}
