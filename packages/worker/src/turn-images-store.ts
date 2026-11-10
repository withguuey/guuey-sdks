/**
 * guuey#2293: the turn's images, stored as files in the turn's own session
 * storage (`Invoke.fs.session`), so the agent's tools can open them this turn.
 * The worker writes them itself (inside its own tree, so nothing trusted
 * writes into it); `@guuey/host` and {@link serveNative} with `images: true`
 * call {@link storeTurnImages} before the turn runs.
 *
 * The rules:
 * - A file's name comes only from its bytes and its type:
 *   `attachments/<sha256 of the decoded bytes>.<ext>`, the extension from a
 *   fixed map of the accepted types. Nothing a person or a URL supplies ever
 *   reaches the path. {@link attachmentFileName} is the one function, so any
 *   reader names the same file.
 * - The bytes on disk are exactly the bytes judged: the strict base64 is
 *   decoded once, and that one buffer is checked, hashed and written.
 * - Each image is held to {@link TURN_IMAGE_MAX_BYTES} here too, on top of the
 *   Router's own check, and a turn to {@link TURN_IMAGES_MAX} images.
 * - `attachments` must be a real directory (never a symlink). Each file is
 *   written under a temporary name opened with `O_CREAT | O_EXCL | O_NOFOLLOW`
 *   (mode 0600) and renamed into place, so a failed write leaves no partial
 *   file under the final name. A final name that already exists as a file
 *   holds the same bytes (same hash), so it is left as it is; one that exists
 *   as anything else is refused.
 * - A failure is a face the person sees, never a crash and never a silent
 *   drop: {@link storeTurnImages} returns the face's text.
 *
 * Where the session storage lasts only the turn (a hosted turn today), the file
 * lasts only the turn: nothing here promises it is there on a later turn.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Invoke, InvokeImageAttachment, InvokeImageMimeType } from "./protocol.js";

/** The directory, inside the session storage, that holds the turn's images. */
export const TURN_IMAGES_DIR = "attachments";
/**
 * The largest image, in decoded bytes: the Router's own per-image limit
 * (5,000,000 base64 characters, which is 3,750,000 bytes), checked here again.
 */
export const TURN_IMAGE_MAX_BYTES = 3_750_000;
/** The most images one turn stores. */
export const TURN_IMAGES_MAX = 16;

const EXTENSIONS: Readonly<Record<InvokeImageMimeType, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Why the turn's images could not be stored. */
export type TurnImagesProblem = "too_many" | "too_large" | "not_a_directory" | "no_space" | "write_failed";

/** What the person sees for each {@link TurnImagesProblem}. */
export const TURN_IMAGES_FACES: Readonly<Record<TurnImagesProblem, string>> = {
  too_many: "This message has more photos than this agent accepts at once. Send fewer and try again.",
  too_large: "This photo is larger than this agent accepts. Send a smaller one.",
  not_a_directory: "This photo could not be stored for this conversation.",
  no_space: "There is no room left to store this photo in this conversation.",
  write_failed: "This photo could not be stored for this conversation.",
};

/** A refusal while storing the turn's images; `problem` names the face. */
export class TurnImagesError extends Error {
  constructor(
    readonly problem: TurnImagesProblem,
    detail: string,
  ) {
    super(detail);
    this.name = "TurnImagesError";
  }
}

function nameOf(bytes: Buffer, mimeType: InvokeImageMimeType): string {
  return `${TURN_IMAGES_DIR}/${createHash("sha256").update(bytes).digest("hex")}.${EXTENSIONS[mimeType]}`;
}

/**
 * The file an image is stored as, relative to the session storage:
 * `attachments/<sha256 of the decoded bytes>.<ext>`. Pure, so any reader of
 * the turn (the agent's own tools) finds the file under the name the writer
 * used. The file lasts as long as the session storage it is in.
 */
export function attachmentFileName(image: InvokeImageAttachment): string {
  return nameOf(Buffer.from(image.data, "base64"), image.mimeType);
}

function errnoOf(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

function failure(err: unknown, what: string): TurnImagesError {
  const code = errnoOf(err);
  const problem: TurnImagesProblem = code === "ENOSPC" || code === "EDQUOT" ? "no_space" : "write_failed";
  return new TurnImagesError(problem, `${what}: ${code ?? (err instanceof Error ? err.message : String(err))}`);
}

function ensureImagesDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (errnoOf(err) !== "EEXIST") throw failure(err, "creating the attachments directory");
  }
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw new TurnImagesError("not_a_directory", "attachments exists and is not a directory");
}

/** Whether `path` exists as a regular file; refuses anything else that exists there. */
function existingFile(path: string): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if (errnoOf(err) === "ENOENT") return false;
    throw failure(err, "reading an attachment's name");
  }
  if (!stat.isFile()) throw new TurnImagesError("not_a_directory", "an attachment's name exists and is not a file");
  return true;
}

function writeOnce(path: string, bytes: Buffer): void {
  if (existingFile(path)) return;
  const temp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  let fd: number;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (err) {
    throw failure(err, "opening an attachment");
  }
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    closeSync(fd);
    renameSync(temp, path);
  } catch (err) {
    const cause = failure(err, "writing an attachment");
    try {
      closeSync(fd);
    } catch (closeErr) {
      if (errnoOf(closeErr) !== "EBADF") throw failure(closeErr, "closing an attachment");
    }
    try {
      unlinkSync(temp);
    } catch (unlinkErr) {
      if (errnoOf(unlinkErr) !== "ENOENT") throw failure(unlinkErr, "removing a partial attachment");
    }
    throw cause;
  }
}

/** One image stored for the turn: its name relative to the session storage, and its size. */
export interface StoredTurnImage {
  path: string;
  bytes: number;
}

/**
 * Store the turn's images in its session storage. Returns one entry per image,
 * in the order sent. Throws {@link TurnImagesError} on a refusal.
 */
export function saveTurnImages(turn: Pick<Invoke, "attachments" | "fs">): StoredTurnImage[] {
  const images = turn.attachments ?? [];
  if (images.length === 0) return [];
  if (images.length > TURN_IMAGES_MAX) {
    throw new TurnImagesError("too_many", `${String(images.length)} images, at most ${String(TURN_IMAGES_MAX)}`);
  }
  const decoded = images.map((image) => {
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length > TURN_IMAGE_MAX_BYTES) {
      throw new TurnImagesError("too_large", `${String(bytes.length)} bytes, at most ${String(TURN_IMAGE_MAX_BYTES)}`);
    }
    return { bytes, name: nameOf(bytes, image.mimeType) };
  });
  ensureImagesDir(join(turn.fs.session, TURN_IMAGES_DIR));
  return decoded.map(({ bytes, name }) => {
    writeOnce(join(turn.fs.session, name), bytes);
    return { path: name, bytes: bytes.length };
  });
}

/**
 * {@link saveTurnImages} for a turn runner: `undefined` when the images are
 * stored (or there are none), else the face the person sees. The runner ends
 * the turn with that face instead of running it.
 */
export function storeTurnImages(turn: Pick<Invoke, "attachments" | "fs">): string | undefined {
  try {
    saveTurnImages(turn);
    return undefined;
  } catch (err) {
    if (err instanceof TurnImagesError) {
      process.stderr.write(`[guuey] turn images not stored: ${err.problem} (${err.message})\n`);
      return TURN_IMAGES_FACES[err.problem];
    }
    throw err;
  }
}
