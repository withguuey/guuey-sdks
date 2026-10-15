/**
 * R7's load decision (guuey#2369) — platform-free, shared by the web and
 * native renderers through the planned {@link MediaItem.display}.
 *
 * The viewer's device loads media ONLY from bytes the transcript already
 * holds or from the guuey media origin:
 *
 * - `data:` base64 of a raster `image/*` or an `audio/*` type, under the
 *   policy's byte cap (over it, a chip: "too large to show");
 * - `blob:` object URLs (in-memory bytes on the viewer's own origin);
 * - `https:` URLs whose origin is in `policy.media.origins`.
 *
 * Any other `https:` URL is an agent-chosen address: fetching it on render
 * would tell that server who read the message and when, and could carry
 * conversation data out in its query string with no click. So it never
 * loads — it becomes a chip with an explicit "open link" action. SVG is
 * refused inline (it is a document format that can carry script), and every
 * other scheme or source shape is an unloadable chip.
 */
import type { AgSource } from "@silverprotocol/core";

/** Why a media row renders as a plain chip instead of loading. */
export type MediaChipReason =
  /** A file/document, or the policy's `chipOnly` — an attachment by design. */
  | "attachment"
  /** Inline bytes over `policy.media.maxInlineBytes`. */
  | "oversized"
  /** A type never shown inline (SVG, or a type that does not match the row). */
  | "refused-type"
  /** A source this kit cannot load (a provider file id, a non-https URL, malformed base64). */
  | "unsupported";

/** What a renderer does with one media row — decided in the plan, never in the component. */
export type MediaDisplay =
  /** Load this src in an image element: a `data:image/*`, `blob:` or media-origin URL. */
  | { kind: "image"; src: string }
  /** Load this src in an audio element: a `blob:` or media-origin URL. */
  | { kind: "audio"; src: string }
  /**
   * Inline audio bytes: the web renderer wraps them in a `blob:` object URL
   * (revoked on unmount); the native renderer shows a chip.
   */
  | { kind: "audio-bytes"; mediaType: string; data: string }
  /** An https URL off the media origins: a chip whose action opens it — never fetched on render. */
  | { kind: "link"; url: string }
  /** A plain chip, with the reason. */
  | { kind: "chip"; reason: MediaChipReason };

/** The policy slice the decision reads (`TranscriptPolicy["media"]`'s load fields). */
export interface MediaLoadPolicy {
  /**
   * Origins the viewer may fetch media from. An entry is an exact https
   * origin (`https://host[:port]`) or a subdomain wildcard
   * (`https://*.host`, which matches subdomains, not the bare host).
   */
  origins: readonly string[];
  /** The decoded-byte cap on inline (`data:` / base64) media. */
  maxInlineBytes: number;
}

/**
 * The guuey media origin — its own registrable domain, so no guuey.com
 * cookie is readable there. The bare host and its per-environment
 * subdomains.
 */
export const DEFAULT_MEDIA_ORIGINS: readonly string[] = [
  "https://guueyusercontent.com",
  "https://*.guueyusercontent.com",
];

/** 5 MiB decoded — the default inline byte cap. */
export const DEFAULT_MAX_INLINE_MEDIA_BYTES = 5 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/i;

/** The decoded size of a base64 payload (no decode needed). */
export function base64DecodedBytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

function isSvg(mediaType: string): boolean {
  return /^image\/svg/i.test(mediaType);
}

/** True when `entry` admits `url` (exact origin, or a `*.` subdomain wildcard). */
function originMatches(url: URL, entry: string): boolean {
  const m = /^https:\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d+))?$/i.exec(entry.trim());
  if (m === null) return false;
  const wildcard = m[1] !== undefined;
  const host = (m[2] ?? "").toLowerCase();
  const port = m[3] === undefined || m[3] === "443" ? "" : m[3];
  if (url.port !== port) return false;
  const hostname = url.hostname.toLowerCase();
  return wildcard ? hostname.endsWith(`.${host}`) : hostname === host;
}

/** True when an https URL's origin is on the media-origin list. */
export function isMediaOrigin(url: string, origins: readonly string[]): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") return false;
  return origins.some((entry) => originMatches(parsed, entry));
}

type InlineKind = "image" | "audio";

/** The decision for inline base64 bytes of a declared media type. */
function fromBytes(
  kind: InlineKind,
  mediaType: string,
  data: string,
  policy: MediaLoadPolicy,
): MediaDisplay {
  if (!MEDIA_TYPE.test(mediaType)) return { kind: "chip", reason: "unsupported" };
  const family = mediaType.slice(0, mediaType.indexOf("/")).toLowerCase();
  if (family !== kind || isSvg(mediaType)) return { kind: "chip", reason: "refused-type" };
  if (!BASE64.test(data)) return { kind: "chip", reason: "unsupported" };
  if (base64DecodedBytes(data) > policy.maxInlineBytes) return { kind: "chip", reason: "oversized" };
  return kind === "image"
    ? { kind: "image", src: `data:${mediaType};base64,${data}` }
    : { kind: "audio-bytes", mediaType, data };
}

/** The decision for a URL source. */
function fromUrl(kind: InlineKind, url: string, mediaType: string | undefined, policy: MediaLoadPolicy): MediaDisplay {
  const dataUrl = /^data:([^;,]+);base64,(.*)$/is.exec(url);
  if (dataUrl !== null) return fromBytes(kind, dataUrl[1] ?? "", dataUrl[2] ?? "", policy);
  if (/^blob:/i.test(url)) {
    return mediaType !== undefined && isSvg(mediaType)
      ? { kind: "chip", reason: "refused-type" }
      : { kind, src: url };
  }
  if (!URL.canParse(url) || new URL(url).protocol !== "https:") return { kind: "chip", reason: "unsupported" };
  if (!isMediaOrigin(url, policy.origins)) return { kind: "link", url };
  if (mediaType !== undefined && isSvg(mediaType)) return { kind: "chip", reason: "refused-type" };
  return { kind, src: url };
}

/**
 * Decide how one R7 row renders. `inline` is the planned presentation: a
 * chip-presented row (files, documents, `chipOnly`) never loads, but keeps
 * an "open link" action when its source is an https URL.
 */
export function mediaDisplay(
  media: "image" | "audio" | "file" | "document",
  source: AgSource,
  inline: boolean,
  policy: MediaLoadPolicy,
): MediaDisplay {
  if (!inline || (media !== "image" && media !== "audio")) {
    if (source.type === "url" && URL.canParse(source.url) && new URL(source.url).protocol === "https:") {
      return { kind: "link", url: source.url };
    }
    return { kind: "chip", reason: "attachment" };
  }
  switch (source.type) {
    case "base64":
      return fromBytes(media, source.mediaType, source.data, policy);
    case "url":
      return fromUrl(media, source.url, source.mediaType, policy);
    case "file":
      return { kind: "chip", reason: "unsupported" };
  }
}
