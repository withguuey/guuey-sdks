/**
 * The web composer's image reader (guuey#2293): a picked or pasted file
 * becomes one inline image attachment, or a named refusal.
 *
 * The rules are `@guuey/agent-client`'s (the allowlist and the per-image cap);
 * this module only gets a browser `File` into that shape. Before the cap is
 * checked, a still image whose long edge is over {@link DOWNSCALE_LONG_EDGE_PX}
 * is redrawn at that size where the browser can (a 2D canvas over
 * `createImageBitmap`). The model API resizes past that edge anyway, so the
 * redraw costs nothing the model would see and turns a phone photo of a few MB
 * into a few hundred KB. A GIF is never redrawn (it would lose its animation).
 * Where the browser cannot redraw, the original bytes are judged as they are.
 */
import {
  IMAGE_ATTACHMENT_MAX_BASE64_CHARS,
  IMAGE_ATTACHMENT_MIME_TYPES,
  isImageAttachmentMimeType,
  type ImageAttachment,
} from "@guuey/agent-client";

/** The file input's `accept`: exactly the allowlist. */
export const ATTACHMENT_ACCEPT = IMAGE_ATTACHMENT_MIME_TYPES.join(",");

/** The long edge a larger still image is redrawn to. */
export const DOWNSCALE_LONG_EDGE_PX = 1568;

/** JPEG and WebP re-encode quality for a redrawn image. */
const DOWNSCALE_QUALITY = 0.85;

/**
 * Returns a smaller image for `file`, or `null` to keep the file as it is
 * (already small enough, or the browser cannot redraw it).
 */
export type ImageDownscaler = (file: Blob) => Promise<Blob | null>;

/** Why the composer did not take a file. */
export type AttachmentRefusalReason = "unsupported_type" | "too_large" | "too_many" | "unreadable";

export type ReadImageFileResult =
  | { ok: true; name: string; attachment: ImageAttachment; previewUrl: string }
  | { ok: false; name: string; reason: Exclude<AttachmentRefusalReason, "too_many"> };

/**
 * The browser's own redraw: a 2D canvas over `createImageBitmap`, at most
 * {@link DOWNSCALE_LONG_EDGE_PX} on the long edge, in the file's own type (JPEG
 * stays JPEG, PNG keeps its transparency). `null` where the image is already
 * small enough or the browser has no way to redraw it.
 */
export const canvasDownscaler: ImageDownscaler = async (file) => {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  const bitmap = await createImageBitmap(file);
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (longEdge <= DOWNSCALE_LONG_EDGE_PX) return null;
    const scale = DOWNSCALE_LONG_EDGE_PX / longEdge;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const type = file.type === "image/png" || file.type === "image/webp" ? file.type : "image/jpeg";
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, DOWNSCALE_QUALITY));
  } finally {
    bitmap.close();
  }
};

/** A blob's bytes as a `data:` URL (FileReader: every browser and jsdom have it). */
function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("FileReader returned no data URL"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Read one picked or pasted file. A type off the allowlist is refused without
 * reading it; a file the browser cannot read is `unreadable`; an image still
 * over the per-image cap after the redraw is `too_large`.
 */
export async function readImageFile(
  file: File,
  options: { downscale?: ImageDownscaler } = {},
): Promise<ReadImageFileResult> {
  const name = file.name;
  if (!isImageAttachmentMimeType(file.type)) return { ok: false, name, reason: "unsupported_type" };
  const downscale = options.downscale ?? canvasDownscaler;
  let image: Blob = file;
  if (file.type !== "image/gif") {
    // A redraw that fails (a corrupt file, a decoder the browser lacks) keeps
    // the original: the cap below still judges it, and the model API will
    // refuse a file it cannot decode with its own words.
    const smaller = await downscale(file).catch((): null => null);
    if (smaller !== null && isImageAttachmentMimeType(smaller.type)) image = smaller;
  }
  let dataUrl: string;
  try {
    dataUrl = await readDataUrl(image);
  } catch {
    return { ok: false, name, reason: "unreadable" };
  }
  const comma = dataUrl.indexOf(",");
  const data = comma === -1 ? "" : dataUrl.slice(comma + 1);
  const mimeType = image.type;
  if (!isImageAttachmentMimeType(mimeType) || data === "") return { ok: false, name, reason: "unreadable" };
  if (data.length > IMAGE_ATTACHMENT_MAX_BASE64_CHARS) return { ok: false, name, reason: "too_large" };
  return {
    ok: true,
    name,
    attachment: { kind: "inline", mimeType, data },
    previewUrl: `data:${mimeType};base64,${data}`,
  };
}
