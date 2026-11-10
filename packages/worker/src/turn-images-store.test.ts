import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InvokeImageAttachment } from "./protocol.js";
import {
  TURN_IMAGES_DIR,
  TURN_IMAGES_FACES,
  TURN_IMAGES_MAX,
  TURN_IMAGE_MAX_BYTES,
  TurnImagesError,
  attachmentFileName,
  saveTurnImages,
  storeTurnImages,
} from "./turn-images-store.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const png = (bytes: Buffer = PNG_BYTES): InvokeImageAttachment => ({ kind: "inline", mimeType: "image/png", data: bytes.toString("base64") });
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

let root: string;
let fs: { app: string; home: string; session: string };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turn-images-"));
  fs = { app: join(root, "app"), home: join(root, "home"), session: join(root, "session") };
  for (const dir of Object.values(fs)) mkdirSync(dir);
});
afterEach(() => {
  chmodSync(fs.session, 0o700);
  rmSync(root, { recursive: true, force: true });
});

describe("attachmentFileName: the one name, from the bytes and the type alone", () => {
  it("is attachments/<sha256 of the decoded bytes>.<ext from the fixed map>", () => {
    expect(attachmentFileName(png())).toBe(`${TURN_IMAGES_DIR}/${sha(PNG_BYTES)}.png`);
    expect(attachmentFileName({ kind: "inline", mimeType: "image/jpeg", data: PNG_BYTES.toString("base64") })).toMatch(/\.jpg$/);
    expect(attachmentFileName({ kind: "inline", mimeType: "image/webp", data: PNG_BYTES.toString("base64") })).toMatch(/\.webp$/);
    expect(attachmentFileName({ kind: "inline", mimeType: "image/gif", data: PNG_BYTES.toString("base64") })).toMatch(/\.gif$/);
  });
});

describe("saveTurnImages", () => {
  it("writes exactly the decoded bytes under the one name, mode 0600, and returns it", () => {
    const stored = saveTurnImages({ fs, attachments: [png()] });
    expect(stored).toEqual([{ path: attachmentFileName(png()), bytes: PNG_BYTES.length }]);
    const file = join(fs.session, stored[0]!.path);
    expect(readFileSync(file).equals(PNG_BYTES)).toBe(true);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });

  it("stores nothing, and creates no directory, for a turn without images", () => {
    expect(saveTurnImages({ fs })).toEqual([]);
    expect(saveTurnImages({ fs, attachments: [] })).toEqual([]);
    expect(readdirSync(fs.session)).toEqual([]);
  });

  it("leaves a final name that already holds the same image as it is (same hash, same bytes)", () => {
    saveTurnImages({ fs, attachments: [png()] });
    expect(() => saveTurnImages({ fs, attachments: [png(), png()] })).not.toThrow();
    expect(readdirSync(join(fs.session, TURN_IMAGES_DIR))).toEqual([`${sha(PNG_BYTES)}.png`]);
  });

  it("refuses an image over TURN_IMAGE_MAX_BYTES, and writes none of the turn's images", () => {
    const big = Buffer.alloc(TURN_IMAGE_MAX_BYTES + 1, 7);
    const err = (() => {
      try {
        saveTurnImages({ fs, attachments: [png(), png(big)] });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(TurnImagesError);
    expect((err as TurnImagesError).problem).toBe("too_large");
    expect(readdirSync(fs.session)).toEqual([]);
  });

  it("accepts an image of exactly TURN_IMAGE_MAX_BYTES", () => {
    const edge = Buffer.alloc(TURN_IMAGE_MAX_BYTES, 1);
    expect(saveTurnImages({ fs, attachments: [png(edge)] })[0]!.bytes).toBe(TURN_IMAGE_MAX_BYTES);
  });

  it(`refuses more than ${String(TURN_IMAGES_MAX)} images`, () => {
    const many = Array.from({ length: TURN_IMAGES_MAX + 1 }, (_, i) => png(Buffer.from([i])));
    expect(() => saveTurnImages({ fs, attachments: many })).toThrow(expect.objectContaining({ problem: "too_many" }));
  });

  it("refuses an attachments entry that is a symlink, and writes nothing through it", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(fs.session, TURN_IMAGES_DIR));
    expect(() => saveTurnImages({ fs, attachments: [png()] })).toThrow(expect.objectContaining({ problem: "not_a_directory" }));
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses an attachments entry that is a file", () => {
    writeFileSync(join(fs.session, TURN_IMAGES_DIR), "x");
    expect(() => saveTurnImages({ fs, attachments: [png()] })).toThrow(expect.objectContaining({ problem: "not_a_directory" }));
  });

  it("refuses a final name planted as a symlink, and never follows it", () => {
    mkdirSync(join(fs.session, TURN_IMAGES_DIR));
    const target = join(root, "target");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(fs.session, attachmentFileName(png())));
    expect(() => saveTurnImages({ fs, attachments: [png()] })).toThrow(expect.objectContaining({ problem: "not_a_directory" }));
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  it("a write that fails leaves no file under the final name and no temporary file", () => {
    mkdirSync(join(fs.session, TURN_IMAGES_DIR));
    chmodSync(join(fs.session, TURN_IMAGES_DIR), 0o500);
    try {
      expect(() => saveTurnImages({ fs, attachments: [png()] })).toThrow(expect.objectContaining({ problem: "write_failed" }));
      expect(readdirSync(join(fs.session, TURN_IMAGES_DIR))).toEqual([]);
    } finally {
      chmodSync(join(fs.session, TURN_IMAGES_DIR), 0o700);
    }
  });
});

describe("storeTurnImages: a refusal is the person's face, never a crash", () => {
  it("is undefined when the images are stored", () => {
    expect(storeTurnImages({ fs, attachments: [png()] })).toBeUndefined();
  });

  it("returns the face for a refusal", () => {
    expect(storeTurnImages({ fs, attachments: [png(Buffer.alloc(TURN_IMAGE_MAX_BYTES + 1))] })).toBe(TURN_IMAGES_FACES.too_large);
  });
});
