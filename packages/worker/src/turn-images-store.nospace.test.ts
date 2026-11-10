/**
 * guuey#2293: a full session storage (ENOSPC, or a quota's EDQUOT) is the
 * person's "no room" face, never a crash and never a silent drop. The disk
 * cannot be filled in a test, so the open is made to fail the way a full disk
 * fails it.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const failWith = vi.hoisted(() => ({ code: "ENOSPC" }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      if (String(args[0]).includes(".tmp-")) throw Object.assign(new Error(`${failWith.code}: no space left`), { code: failWith.code });
      return real.openSync(...args);
    },
  };
});

const { TURN_IMAGES_DIR, TURN_IMAGES_FACES, storeTurnImages } = await import("./turn-images-store.js");

let root: string;
let fs: { app: string; home: string; session: string };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turn-images-nospace-"));
  fs = { app: join(root, "app"), home: join(root, "home"), session: join(root, "session") };
  for (const dir of Object.values(fs)) mkdirSync(dir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const image = { kind: "inline" as const, mimeType: "image/png" as const, data: Buffer.from([1, 2, 3]).toString("base64") };

describe("a full session storage", () => {
  for (const code of ["ENOSPC", "EDQUOT"]) {
    it(`${code} is the no-room face, and leaves nothing behind`, () => {
      failWith.code = code;
      expect(storeTurnImages({ fs, attachments: [image] })).toBe(TURN_IMAGES_FACES.no_space);
      expect(readdirSync(join(fs.session, TURN_IMAGES_DIR))).toEqual([]);
    });
  }

  it("any other open failure is the could-not-store face", () => {
    failWith.code = "EIO";
    expect(storeTurnImages({ fs, attachments: [image] })).toBe(TURN_IMAGES_FACES.write_failed);
  });
});
