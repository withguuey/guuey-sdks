// @vitest-environment jsdom
/**
 * guuey#2293 — the web composer's image reader: a picked or pasted file
 * becomes one inline image attachment, judged by `@guuey/agent-client`'s V1
 * rules (the allowlist and the per-image cap), after an optional downscale.
 */
import { describe, expect, it } from "vitest";
import { IMAGE_ATTACHMENT_MAX_BASE64_CHARS } from "@guuey/agent-client";
import {
  attachmentAcceptFor,
  partKindOfFile,
  readImageFile,
  readPartFile,
  type ImageDownscaler,
} from "./composer-attachments.js";

/** A 1×1 transparent PNG's bytes. */
const PNG_1PX_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

const noDownscale: ImageDownscaler = async () => null;

describe("readImageFile", () => {
  it("reads a PNG into an inline attachment whose data is the file's base64, with a preview URL", async () => {
    const file = new File([bytesOf(PNG_1PX_BASE64)], "dot.png", { type: "image/png" });
    const result = await readImageFile(file, { downscale: noDownscale });
    expect(result).toEqual({
      ok: true,
      name: "dot.png",
      attachment: { kind: "inline", mimeType: "image/png", data: PNG_1PX_BASE64 },
      previewUrl: `data:image/png;base64,${PNG_1PX_BASE64}`,
    });
  });

  it("refuses a type off the allowlist without reading it (audio is not an attachment in V1)", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "note.webm", { type: "audio/webm" });
    expect(await readImageFile(file, { downscale: noDownscale })).toEqual({
      ok: false,
      name: "note.webm",
      reason: "unsupported_type",
    });
    const heic = new File([new Uint8Array([1])], "IMG_0001.HEIC", { type: "image/heic" });
    expect((await readImageFile(heic, { downscale: noDownscale })).ok).toBe(false);
  });

  it("refuses an image over the per-image cap after the downscale had its chance", async () => {
    // 3 bytes → 4 base64 characters: one byte-triple over the cap's worth.
    const bytes = new Uint8Array((IMAGE_ATTACHMENT_MAX_BASE64_CHARS / 4) * 3 + 3);
    const file = new File([bytes], "huge.jpg", { type: "image/jpeg" });
    expect(await readImageFile(file, { downscale: noDownscale })).toEqual({
      ok: false,
      name: "huge.jpg",
      reason: "too_large",
    });
  });

  it("uses the downscaler's smaller image when it returns one, under the downscaled type", async () => {
    const big = new File([new Uint8Array(4096)], "photo.jpg", { type: "image/jpeg" });
    const small = new Blob([bytesOf(PNG_1PX_BASE64)], { type: "image/png" });
    const seen: Blob[] = [];
    const result = await readImageFile(big, {
      downscale: async (file) => {
        seen.push(file);
        return small;
      },
    });
    expect(seen).toEqual([big]);
    expect(result).toMatchObject({ ok: true, name: "photo.jpg", attachment: { mimeType: "image/png", data: PNG_1PX_BASE64 } });
  });

  it("never downscales a GIF (a redraw would drop its animation)", async () => {
    const gif = new File([new Uint8Array([71, 73, 70])], "spin.gif", { type: "image/gif" });
    let called = false;
    const result = await readImageFile(gif, {
      downscale: async () => {
        called = true;
        return null;
      },
    });
    expect(called).toBe(false);
    expect(result).toMatchObject({ ok: true, attachment: { mimeType: "image/gif", data: "R0lG" } });
  });

  it("the default downscaler leaves the file as it is where the browser cannot redraw (no createImageBitmap)", async () => {
    const file = new File([bytesOf(PNG_1PX_BASE64)], "dot.png", { type: "image/png" });
    expect(await readImageFile(file)).toMatchObject({ ok: true, attachment: { data: PNG_1PX_BASE64 } });
  });

  it("the picker's accept list is the turned-on kinds' suggested types", () => {
    expect(attachmentAcceptFor(["image"])).toBe("image/jpeg,image/png,image/gif,image/webp");
    expect(attachmentAcceptFor(["audio", "document"])).toBe("audio/wav,audio/mpeg,application/pdf");
    expect(attachmentAcceptFor([])).toBe("");
  });
});

describe("partKindOfFile — the kind a picked file is, among the turned-on kinds", () => {
  const typed = (type: string): Blob => new Blob([], { type });

  it("a suggested list naming the type wins, then the type's family, else a file", () => {
    const all = ["image", "audio", "file", "document"] as const;
    expect(partKindOfFile(typed("image/png"), all)).toBe("image");
    expect(partKindOfFile(typed("image/heic"), all)).toBe("image");
    expect(partKindOfFile(typed("audio/webm"), all)).toBe("audio");
    expect(partKindOfFile(typed("application/pdf"), all)).toBe("document");
    expect(partKindOfFile(typed("text/csv"), all)).toBe("file");
    expect(partKindOfFile(typed("application/zip"), all)).toBe("file");
  });

  it("a kind the host did not turn on is no kind", () => {
    expect(partKindOfFile(typed("audio/webm"), ["image"])).toBeUndefined();
    expect(partKindOfFile(typed("application/pdf"), ["image", "file"])).toBeUndefined();
  });
});

describe("readPartFile — a file that is not an image, read as it is", () => {
  it("keeps its type and bytes; a file with no type is sent as the generic binary type", async () => {
    expect(await readPartFile(new File(["a,b"], "rows.csv", { type: "text/csv" }))).toEqual({
      ok: true,
      name: "rows.csv",
      mediaType: "text/csv",
      data: btoa("a,b"),
    });
    expect(await readPartFile(new File(["x"], "notes"))).toMatchObject({ ok: true, mediaType: "application/octet-stream" });
  });

  it("an empty file is unreadable", async () => {
    expect(await readPartFile(new File([], "empty.txt", { type: "text/plain" }))).toEqual({ ok: false, name: "empty.txt", reason: "unreadable" });
  });
});
