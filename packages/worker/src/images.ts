/**
 * The turn's images (`Invoke.attachments`): the one image check (its type and
 * its base64) that every reader of an invoke's images applies, and what a
 * worker's hello announces when it hands them to its model.
 */
import {
  INVOKE_IMAGES_CAPABILITY,
  INVOKE_IMAGE_MIME_TYPES,
  type Invoke,
  type InvokeImageMimeType,
  type JsonValue,
} from "./protocol.js";

/** Whether `v` is one of {@link INVOKE_IMAGE_MIME_TYPES}. */
export function isInvokeImageMimeType(v: JsonValue | undefined): v is InvokeImageMimeType {
  return typeof v === "string" && (INVOKE_IMAGE_MIME_TYPES as readonly string[]).includes(v);
}

/** The standard base64 alphabet, with at most two `=` of padding at the end. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Whether `data` is an image's bytes as {@link InvokeImageAttachment} carries
 * them: non-empty standard base64 (RFC 4648 §4), padded to a multiple of 4,
 * with no `data:` prefix and no line breaks.
 */
export function isStandardBase64(data: string): boolean {
  return data.length > 0 && data.length % 4 === 0 && BASE64.test(data);
}

/**
 * The capabilities a worker that hands the invoke's images to its model
 * announces in that invoke's hello: {@link INVOKE_IMAGES_CAPABILITY} when the
 * invoke carried images, nothing otherwise (an invoke without images keeps
 * exactly the hello it had before images existed).
 */
export function invokeImagesCapabilities(invoke: Pick<Invoke, "attachments">): string[] {
  return invoke.attachments !== undefined && invoke.attachments.length > 0 ? [INVOKE_IMAGES_CAPABILITY] : [];
}
