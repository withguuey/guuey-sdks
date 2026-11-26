/**
 * A turn's user parts: the per-kind allowlists, the caps and the ONE judge (request shape 2).
 *
 * A part is one of the protocol's four user block kinds (`image`, `audio`, `file`, `document`), each carrying an
 * `AgSource`. The judge mirrors the runtime's rules so a refused part never reaches the wire. It is a courtesy, never
 * the check: the runtime judges every part again and never trusts this one.
 *
 * The rules:
 *  - images are exactly as before ({@link validateImageAttachments}'s caps): at most 4, 5,000,000 base64 characters
 *    each, by `base64` or an `https` link;
 *  - at most ONE audio part per turn;
 *  - every inline part (image, audio, file, document) shares ONE room of
 *    {@link IMAGE_ATTACHMENTS_MAX_TOTAL_BASE64_CHARS} base64 characters, with
 *    {@link IMAGE_ATTACHMENT_MAX_BASE64_CHARS} per part;
 *  - a link is `https` and at most {@link PART_URL_MAX_CHARS} characters;
 *  - `source: file` (an uploaded object) is refused by name until uploads exist;
 *  - a kind the agent's runtime did not acknowledge is refused (`not_accepted`), never dropped.
 */
import type { AgBlock } from "@silverprotocol/core";
import {
  IMAGE_ATTACHMENT_MAX_BASE64_CHARS,
  IMAGE_ATTACHMENT_MIME_TYPES,
  IMAGE_ATTACHMENTS_MAX_COUNT,
  IMAGE_ATTACHMENTS_MAX_TOTAL_BASE64_CHARS,
  type TurnAttachment,
} from "./attachments.js";

/** The four user part kinds: the protocol's own block types. */
export const USER_PART_KINDS = ["image", "audio", "file", "document"] as const;

/** One of {@link USER_PART_KINDS}. */
export type UserPartKind = (typeof USER_PART_KINDS)[number];

/** A user part on the wire: exactly the protocol's block of that kind. */
export type UserPart = Extract<AgBlock, { type: UserPartKind }>;

/** The media types each kind takes (the runtime's lists; a type off them is refused before the send). */
export const USER_PART_MIME_TYPES: { readonly [kind in UserPartKind]: readonly string[] } = Object.freeze({
  image: IMAGE_ATTACHMENT_MIME_TYPES,
  audio: Object.freeze(["audio/wav", "audio/mpeg"]),
  file: Object.freeze(["text/plain", "text/markdown", "text/csv", "application/json"]),
  document: Object.freeze(["application/pdf"]),
});

/** At most this many audio parts in one turn. */
export const AUDIO_PARTS_MAX_COUNT = 1;

/** A part's link is at most this many characters. */
export const PART_URL_MAX_CHARS = 4096;

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

/** Which kinds the agent's runtime acknowledged on its last `session` frame (`accepts.parts`). */
export type AcceptedPartKinds = ReadonlySet<UserPartKind>;

/** Why a list was refused. `index` names the first part that broke a rule. */
export type UserPartRefusal =
  | { reason: "unsupported_kind"; index: number; type: string }
  | { reason: "not_accepted"; index: number; kind: UserPartKind }
  | { reason: "source_unsupported"; index: number; source: string }
  | { reason: "unsupported_type"; index: number; kind: UserPartKind; mediaType: string }
  | { reason: "not_base64"; index: number }
  | { reason: "too_large"; index: number; max: number }
  | { reason: "total_too_large"; max: number }
  | { reason: "too_many"; kind: UserPartKind; max: number }
  | { reason: "not_https"; index: number }
  | { reason: "url_too_long"; index: number; max: number };

export type UserPartsVerdict = { ok: true; parts: UserPart[] } | { ok: false; refusal: UserPartRefusal };

/** Standard base64: the 64-letter alphabet, padded to a multiple of 4, nothing else. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether `type` is one of {@link USER_PART_KINDS}. */
export function isUserPartKind(type: string): type is UserPartKind {
  return (USER_PART_KINDS as readonly string[]).includes(type);
}

/**
 * Judge a turn's parts, all or nothing: every part passes and the list comes back in its wire shape, or the first broken
 * rule is named and nothing is sent. `accepted` is what the runtime acknowledged; images are judged against it too.
 */
export function validateUserParts(list: readonly UserPartCandidate[], accepted: AcceptedPartKinds): UserPartsVerdict {
  const parts: UserPart[] = [];
  const counts: { [kind in UserPartKind]: number } = { image: 0, audio: 0, file: 0, document: 0 };
  let total = 0;
  for (const [index, candidate] of list.entries()) {
    const { type, source } = candidate;
    if (!isUserPartKind(type)) return { ok: false, refusal: { reason: "unsupported_kind", index, type } };
    if (!accepted.has(type)) return { ok: false, refusal: { reason: "not_accepted", index, kind: type } };
    counts[type] += 1;
    if (type === "image" && counts.image > IMAGE_ATTACHMENTS_MAX_COUNT) {
      return { ok: false, refusal: { reason: "too_many", kind: "image", max: IMAGE_ATTACHMENTS_MAX_COUNT } };
    }
    if (type === "audio" && counts.audio > AUDIO_PARTS_MAX_COUNT) {
      return { ok: false, refusal: { reason: "too_many", kind: "audio", max: AUDIO_PARTS_MAX_COUNT } };
    }
    const mediaType = source.mediaType ?? "";
    if (source.type === "url") {
      const url = source.url ?? "";
      if (!url.startsWith("https://")) return { ok: false, refusal: { reason: "not_https", index } };
      if (url.length > PART_URL_MAX_CHARS) {
        return { ok: false, refusal: { reason: "url_too_long", index, max: PART_URL_MAX_CHARS } };
      }
      const known = USER_PART_MIME_TYPES[type].includes(mediaType);
      parts.push(partOf(type, { type: "url", url, ...(known ? { mediaType } : {}) }, candidate));
      continue;
    }
    if (source.type !== "base64") {
      return { ok: false, refusal: { reason: "source_unsupported", index, source: source.type } };
    }
    if (!USER_PART_MIME_TYPES[type].includes(mediaType)) {
      return { ok: false, refusal: { reason: "unsupported_type", index, kind: type, mediaType } };
    }
    const data = source.data ?? "";
    if (data.length > IMAGE_ATTACHMENT_MAX_BASE64_CHARS) {
      return { ok: false, refusal: { reason: "too_large", index, max: IMAGE_ATTACHMENT_MAX_BASE64_CHARS } };
    }
    if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) {
      return { ok: false, refusal: { reason: "not_base64", index } };
    }
    total += data.length;
    parts.push(partOf(type, { type: "base64", mediaType, data }, candidate));
  }
  if (total > IMAGE_ATTACHMENTS_MAX_TOTAL_BASE64_CHARS) {
    return { ok: false, refusal: { reason: "total_too_large", max: IMAGE_ATTACHMENTS_MAX_TOTAL_BASE64_CHARS } };
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

/**
 * Shape 1's form of a judged list: images only, as today's `attachments`. A list with any other kind has no shape-1
 * form, so it answers `undefined` and the caller refuses the turn (`PARTS_NOT_ACCEPTED`) rather than dropping a part.
 */
export function shape1AttachmentsOf(parts: readonly UserPart[]): TurnAttachment[] | undefined {
  const attachments: TurnAttachment[] = [];
  for (const part of parts) {
    if (part.type !== "image") return undefined;
    const source = part.source;
    if (source.type === "base64") {
      const mimeType = IMAGE_ATTACHMENT_MIME_TYPES.find((t) => t === source.mediaType);
      if (mimeType === undefined) return undefined;
      attachments.push({ kind: "inline", mimeType, data: source.data });
    } else if (source.type === "url") {
      const mimeType = IMAGE_ATTACHMENT_MIME_TYPES.find((t) => t === source.mediaType);
      attachments.push(mimeType === undefined ? { kind: "url", url: source.url } : { kind: "url", url: source.url, mimeType });
    } else {
      return undefined;
    }
  }
  return attachments;
}

/** A plain sentence for a refusal: the hook's `error` beside `PARTS_INVALID` / `PARTS_NOT_ACCEPTED`. */
export function describeUserPartRefusal(refusal: UserPartRefusal): string {
  switch (refusal.reason) {
    case "unsupported_kind":
      return `Part ${refusal.index + 1} is a ${refusal.type}, which a message cannot carry.`;
    case "not_accepted":
      return `This agent does not take ${refusal.kind} yet.`;
    case "source_unsupported":
      return `Part ${refusal.index + 1} cannot be sent that way yet; attach the file itself or send a link.`;
    case "unsupported_type":
      return `Part ${refusal.index + 1} is ${refusal.mediaType || "an unknown type"}, which a ${refusal.kind} part cannot be.`;
    case "not_base64":
      return `Part ${refusal.index + 1} is not base64 data.`;
    case "too_large":
      return `Part ${refusal.index + 1} is too large to send.`;
    case "total_too_large":
      return "These attachments are too large to send together.";
    case "too_many":
      return `A message can carry at most ${refusal.max} ${refusal.kind === "audio" ? "recording" : "images"}.`;
    case "not_https":
      return `Part ${refusal.index + 1} is not an https link.`;
    case "url_too_long":
      return `Part ${refusal.index + 1}'s link is too long.`;
  }
}
