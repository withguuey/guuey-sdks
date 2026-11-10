/**
 * guuey#2293: the store's write path under a hostile or failing tree. The
 * temporary name is made predictable here (it is random in use) so a symlink
 * can be planted at it, and the write can be made to fail after the open, the
 * way a disk that fills mid-write fails it.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FIXED = Buffer.from("0011223344556677", "hex");
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, randomBytes: () => FIXED };
});
const writeFails = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    // The store's one call shape: writeSync(fd, buffer, offset, length).
    writeSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number) => {
      if (writeFails.on) throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
      return real.writeSync(fd, buffer, offset, length);
    },
  };
});

const { TURN_IMAGES_DIR, TURN_IMAGES_FACES, attachmentFileName, storeTurnImages } = await import("./turn-images-store.js");

const image = { kind: "inline" as const, mimeType: "image/png" as const, data: Buffer.from([9, 8, 7]).toString("base64") };
let root: string;
let fs: { app: string; home: string; session: string };
let umask: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turn-images-hostile-"));
  fs = { app: join(root, "app"), home: join(root, "home"), session: join(root, "session") };
  for (const dir of Object.values(fs)) mkdirSync(dir);
  writeFails.on = false;
  umask = process.umask(0o022);
});
afterEach(() => {
  process.umask(umask);
  rmSync(root, { recursive: true, force: true });
});

const tempPath = (): string => join(fs.session, `${attachmentFileName(image)}.tmp-${FIXED.toString("hex")}`);

describe("the temporary file", () => {
  it("is opened exclusive and without following a link: a symlink planted at its name is never written through", () => {
    mkdirSync(join(fs.session, TURN_IMAGES_DIR));
    const target = join(root, "target");
    writeFileSync(target, "untouched");
    symlinkSync(target, tempPath());
    expect(storeTurnImages({ fs, attachments: [image] })).toBe(TURN_IMAGES_FACES.write_failed);
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  it("a write that fails after the open is the no-room face and leaves neither the temporary nor the final file", () => {
    writeFails.on = true;
    expect(storeTurnImages({ fs, attachments: [image] })).toBe(TURN_IMAGES_FACES.no_space);
    expect(readdirSync(join(fs.session, TURN_IMAGES_DIR))).toEqual([]);
  });

  it("is created 0600 whatever the umask allows", () => {
    expect(storeTurnImages({ fs, attachments: [image] })).toBeUndefined();
    expect(lstatSync(join(fs.session, attachmentFileName(image))).mode & 0o777).toBe(0o600);
  });
});
