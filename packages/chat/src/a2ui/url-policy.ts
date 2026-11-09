/**
 * What an A2UI surface may load and what it may open (guuey#2366, spec §7.2
 * and §7.3). Platform-free, decided in the plan, never in a component.
 *
 * Policy A (ruling 3): an image loads only from `data:` raster bytes, a
 * `blob:` URL, or an `https:` URL on the guuey media host
 * (`guueyusercontent.com` or a subdomain of it), with no userinfo and the
 * default port. The host match is the media row's own (`isMediaOrigin` over
 * `DEFAULT_MEDIA_ORIGINS`), on the parsed, lower-cased, IDNA-normalized
 * hostname. An agent-chosen URL is never fetched by the viewer.
 *
 * Links (a `Button.href`, a `Text` link): `https:` only, no userinfo, and the
 * host is shown beside the label so a label cannot hide its target.
 */
import { DEFAULT_MEDIA_ORIGINS, isMediaOrigin } from "../media.js";
import { A2UI_LIMITS } from "./limits.js";

/** Raster image bytes inline; SVG is refused (it is a document that can carry script). */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/i;

/** The parsed URL when it is an `https:` URL within the URL bound and with no userinfo. */
function parseHttps(url: string): URL | null {
  if (url.length > A2UI_LIMITS.urlUnits || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
  return parsed;
}

/** True when an image `src` may load under policy A. */
export function isPolicyAImageSrc(src: string): boolean {
  if (DATA_IMAGE.test(src)) return true;
  if (/^blob:/i.test(src)) return src.length <= A2UI_LIMITS.urlUnits;
  const parsed = parseHttps(src);
  return parsed !== null && isMediaOrigin(parsed.href, DEFAULT_MEDIA_ORIGINS);
}

/** An openable link: the normalized URL and the host shown beside its label. */
export interface A2uiLink {
  url: string;
  /** `URL.host`: the ASCII (punycode) hostname, with a non-default port. */
  host: string;
}

/** The link a `Button.href` or a `Text` link opens, or `null` when it draws inert. */
export function httpsLink(url: string): A2uiLink | null {
  const parsed = parseHttps(url);
  return parsed === null ? null : { url: parsed.href, host: parsed.host };
}

/** How an `Image` draws: loaded, a chip that offers to open its https URL, or a plain chip. */
export type A2uiImageDisplay = { kind: "image"; src: string } | ({ kind: "link" } & A2uiLink) | { kind: "chip" };

/** The planned display of an `Image.src` (policy A; anything else never loads). */
export function a2uiImageDisplay(src: string): A2uiImageDisplay {
  if (isPolicyAImageSrc(src)) return { kind: "image", src };
  const link = httpsLink(src);
  return link === null ? { kind: "chip" } : { kind: "link", ...link };
}
