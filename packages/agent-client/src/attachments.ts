/**
 * Image attachments on a turn: the allowlist, the caps and the one judge
 * (guuey#2293).
 *
 * V1 carries images only, inline as base64, on the runtime's existing
 * `InvokeAttachment` union (its `inline` member: `{ kind, mimeType, data }`).
 * Audio is not accepted: the default model framework has no audio input, so
 * voice is dictation into the text on the device.
 *
 * The caps are sized to the request path, not to taste:
 *  - one image at most {@link IMAGE_ATTACHMENT_MAX_BASE64_CHARS} base64
 *    characters (about 3.75 MB of image), under the model API's 5 MB
 *    per-image limit however that limit is counted;
 *  - one turn's images at most {@link IMAGE_ATTACHMENTS_MAX_TOTAL_BASE64_CHARS}
 *    characters, sized so a typical turn fits the 8 MiB frame that carries
 *    it to the agent's executor together with the conversation's history,
 *    its tool credentials and the rest of the turn (the runtime holds the
 *    same number). It is not a worst-case bound: the runtime refuses a turn
 *    whose frame would still be too large. It is also well under the 10 MB
 *    request limit in front of the agent runtime, so a valid body is never
 *    refused at the edge;
 *  - at most {@link IMAGE_ATTACHMENTS_MAX_COUNT} images in one turn.
 *
 * `useAgentInvoke` runs {@link validateImageAttachments} at its one send path,
 * so a refused list never reaches the wire. The runtime judges the list again
 * and never trusts this one.
 */

/** The image types every model framework adapter accepts. */
export const IMAGE_ATTACHMENT_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

/** One of {@link IMAGE_ATTACHMENT_MIME_TYPES}. */
export type ImageAttachmentMimeType = (typeof IMAGE_ATTACHMENT_MIME_TYPES)[number];

/** At most this many images in one turn. */
export const IMAGE_ATTACHMENTS_MAX_COUNT = 4;

/** One image's base64 text is at most this many characters. */
export const IMAGE_ATTACHMENT_MAX_BASE64_CHARS = 5_000_000;

/** One turn's images together are at most this many base64 characters. */
export const IMAGE_ATTACHMENTS_MAX_TOTAL_BASE64_CHARS = 6_000_000;

/**
 * One image on the wire: the runtime's `inline` attachment. `data` is the
 * image's bytes in standard base64, with no `data:` prefix and no line breaks.
 */
export interface ImageAttachment {
  kind: "inline";
  mimeType: ImageAttachmentMimeType;
  data: string;
}

/**
 * One image by link (guuey#2293, the link door): an `https` URL the app
 * already has (its own storage, a presigned link). The runtime fetches it once
 * through its relay guards and hands the bytes to the model as it does an
 * inline image; the client never fetches it. A presigned URL is a bearer: it
 * is sent once, on this turn's body, and this package neither logs nor stores
 * it. `mimeType` rides only when it is one of the allowlisted types; the
 * runtime ignores it for a link and reads the type from the fetched bytes.
 * Links are for a signed-in person: a guest's turn with a link is refused
 * before it runs (`ATTACHMENTS_INVALID`), while an inline image still works.
 */
export interface ImageLinkAttachment {
  kind: "url";
  url: string;
  mimeType?: ImageAttachmentMimeType;
}

/** What a turn's `attachments` carries on the wire: images inline or by link. */
export type TurnAttachment = ImageAttachment | ImageLinkAttachment;

/**
 * What a caller hands the judge. Wider than {@link TurnAttachment} on purpose:
 * a JavaScript caller (or a host reading a file it did not type) is not held
 * by the type, so the judge reads strings and decides. An inline image sets
 * `mimeType` and `data`; a link sets `url` (and may set `mimeType`).
 */
export interface ImageAttachmentCandidate {
  readonly kind: string;
  readonly mimeType?: string;
  readonly data?: string;
  readonly url?: string;
}

/** Why a list was refused. `index` names the first image that broke a rule. */
export type ImageAttachmentRefusal =
  | { reason: "too_many"; max: number }
  | { reason: "unsupported_kind"; index: number }
  | { reason: "unsupported_type"; index: number; mimeType: string }
  | { reason: "not_base64"; index: number }
  | { reason: "too_large"; index: number; max: number }
  | { reason: "total_too_large"; max: number }
  | { reason: "not_https"; index: number };

export type ImageAttachmentsVerdict =
  | { ok: true; attachments: TurnAttachment[] }
  | { ok: false; refusal: ImageAttachmentRefusal };

/** Whether `mimeType` is on {@link IMAGE_ATTACHMENT_MIME_TYPES}. */
export function isImageAttachmentMimeType(mimeType: string): mimeType is ImageAttachmentMimeType {
  return (IMAGE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Standard base64: the 64-letter alphabet, padded to a multiple of 4, nothing else. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Judge a turn's images against the V1 rules, all or nothing: either every
 * image passes and the list comes back in its wire shape, or the first broken
 * rule is named and nothing should be sent.
 */
export function validateImageAttachments(list: readonly ImageAttachmentCandidate[]): ImageAttachmentsVerdict {
  if (list.length > IMAGE_ATTACHMENTS_MAX_COUNT) {
    return { ok: false, refusal: { reason: "too_many", max: IMAGE_ATTACHMENTS_MAX_COUNT } };
  }
  const attachments: TurnAttachment[] = [];
  let total = 0;
  for (const [index, candidate] of list.entries()) {
    const { kind, mimeType = "", data = "", url = "" } = candidate;
    if (kind === "url") {
      // The runtime is the one judge of a link (its host allowlist, the fetched
      // bytes' type and size) and refuses it with ATTACHMENTS_INVALID. The client
      // keeps only a link that is not https off the wire, and sends it as given.
      if (!url.startsWith("https://")) return { ok: false, refusal: { reason: "not_https", index } };
      attachments.push(isImageAttachmentMimeType(mimeType) ? { kind, url, mimeType } : { kind, url });
      continue;
    }
    if (kind !== "inline") return { ok: false, refusal: { reason: "unsupported_kind", index } };
    if (!isImageAttachmentMimeType(mimeType)) return { ok: false, refusal: { reason: "unsupported_type", index, mimeType } };
    if (data.length > IMAGE_ATTACHMENT_MAX_BASE64_CHARS) {
      return { ok: false, refusal: { reason: "too_large", index, max: IMAGE_ATTACHMENT_MAX_BASE64_CHARS } };
    }
    if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) {
      return { ok: false, refusal: { reason: "not_base64", index } };
    }
    total += data.length;
    attachments.push({ kind: "inline", mimeType, data });
  }
  if (total > IMAGE_ATTACHMENTS_MAX_TOTAL_BASE64_CHARS) {
    return { ok: false, refusal: { reason: "total_too_large", max: IMAGE_ATTACHMENTS_MAX_TOTAL_BASE64_CHARS } };
  }
  return { ok: true, attachments };
}

/** A plain sentence for a refusal: the hook's `error` beside `ATTACHMENTS_INVALID`. */
export function describeImageAttachmentRefusal(refusal: ImageAttachmentRefusal): string {
  switch (refusal.reason) {
    case "too_many":
      return `A message can carry at most ${refusal.max} images.`;
    case "unsupported_kind":
      return `Attachment ${refusal.index + 1} is not an inline image.`;
    case "unsupported_type":
      return `Attachment ${refusal.index + 1} is ${refusal.mimeType}; only JPEG, PNG, GIF and WebP images can be sent.`;
    case "not_base64":
      return `Attachment ${refusal.index + 1} is not base64 image data.`;
    case "too_large":
      return `Attachment ${refusal.index + 1} is too large to send.`;
    case "total_too_large":
      return "These images are too large to send together.";
    case "not_https":
      return `Attachment ${refusal.index + 1} is not an https link.`;
  }
}
