/**
 * `Invoke.attachments`, the turn's images, across a rolling release: the
 * current parser keeps a well-formed list whole and drops a malformed one
 * whole (never part of it, never a throw); the previous worker's parser
 * (the one before invoke images, frozen in `fixtures/parse-control.pre-thread-id.prev.ts`:
 * the parser of the 0.31.1 release served today, which predates both the
 * invoke's threadId and its images, so one frozen copy stands for both)
 * reads a new Router's invoke and ignores the images, which is why such a
 * worker never announces `invoke.images.v1`. The one image check both the
 * parser and the Router's invoke validator apply is exported and pinned here.
 */
import { describe, expect, it } from "vitest";
import { parseControl } from "./parse.js";
import { parseControl as parseControlPrev } from "./fixtures/parse-control.pre-thread-id.prev.js";
import { invokeImagesCapabilities } from "./images.js";
import { isInvokeImageMimeType, isStandardBase64 } from "./index.js";
import { INVOKE_IMAGES_CAPABILITY, INVOKE_IMAGE_MIME_TYPES, type Invoke } from "./protocol.js";

const PNG = { kind: "inline", mimeType: "image/png", data: "iVBORw0KGgo=" };
const GIF = { kind: "inline", mimeType: "image/gif", data: "R0lGODlh" };
const OLD_INVOKE = {
  type: "invoke",
  input: "Make flashcards from this page.",
  identity: { userId: "u1", authMode: "authenticated" },
  fs: { app: "/app", home: "/home", session: "/session" },
  history: [],
};
const NEW_INVOKE = { ...OLD_INVOKE, attachments: [PNG, GIF] };

function invokeOf(line: object): Invoke {
  const msg = parseControl(JSON.stringify(line));
  if (msg.type !== "invoke") throw new Error("not an invoke");
  return msg;
}

describe("the current parseControl reads the turn's images", () => {
  it("keeps a well-formed list whole, in order", () => {
    expect(invokeOf(NEW_INVOKE).attachments).toEqual([PNG, GIF]);
  });

  it("an invoke without images has no attachments key", () => {
    expect(invokeOf(OLD_INVOKE)).not.toHaveProperty("attachments");
    expect(invokeOf({ ...OLD_INVOKE, attachments: [] })).not.toHaveProperty("attachments");
  });

  const malformed: Array<[string, unknown]> = [
    ["not an array", "iVBORw0KGgo="],
    ["a url attachment", [PNG, { kind: "url", url: "https://example.com/a.png" }]],
    ["a storage attachment", [{ kind: "storage", ref: "storage://x" }]],
    ["a type off the allowlist", [PNG, { kind: "inline", mimeType: "image/heic", data: "AAAA" }]],
    ["audio", [{ kind: "inline", mimeType: "audio/mpeg", data: "AAAA" }]],
    ["empty data", [{ kind: "inline", mimeType: "image/png", data: "" }]],
    ["a data: URL prefix", [{ kind: "inline", mimeType: "image/png", data: "data:image/png;base64,AAAA" }]],
    ["unpadded base64", [{ kind: "inline", mimeType: "image/png", data: "AAAAA" }]],
    ["a line break", [{ kind: "inline", mimeType: "image/png", data: "AAAA\nAAAA" }]],
    ["non-string data", [{ kind: "inline", mimeType: "image/png", data: 7 }]],
    ["a non-object entry", [PNG, "image"]],
  ];
  for (const [what, attachments] of malformed) {
    it(`drops the WHOLE list on ${what}, never throwing`, () => {
      const parsed = invokeOf({ ...OLD_INVOKE, attachments });
      expect(parsed).not.toHaveProperty("attachments");
      expect(parsed.input).toBe(OLD_INVOKE.input);
    });
  }

  it("accepts every allowlisted type", () => {
    for (const mimeType of INVOKE_IMAGE_MIME_TYPES) {
      expect(invokeOf({ ...OLD_INVOKE, attachments: [{ kind: "inline", mimeType, data: "AAAA" }] }).attachments).toHaveLength(1);
    }
  });
});

describe("the one image check, exported for every reader of an invoke's images", () => {
  it("isInvokeImageMimeType: exactly the allowlist, nothing else", () => {
    for (const mimeType of INVOKE_IMAGE_MIME_TYPES) expect(isInvokeImageMimeType(mimeType)).toBe(true);
    for (const other of ["image/heic", "image/svg+xml", "audio/mpeg", "IMAGE/PNG", "image/png ", "", undefined, 7, null]) {
      expect(isInvokeImageMimeType(other)).toBe(false);
    }
  });

  it("isStandardBase64: non-empty, padded to a multiple of 4, the standard alphabet only", () => {
    for (const ok of ["AAAA", "iVBORw0KGgo=", "AA==", "+/+/", "R0lGODlh"]) expect(isStandardBase64(ok)).toBe(true);
    for (const bad of ["", "AAAAA", "AAA", "A===", "AA=A", "data:image/png;base64,AAAA", "AAAA\nAAAA", "AA-_", "AAAA AAAA"]) {
      expect(isStandardBase64(bad)).toBe(false);
    }
  });
});

describe("the previous worker's parseControl (frozen; release's 0.31.1 parser) × a new Router's invoke with images", () => {
  it("reads it as the same turn without images: no throw, no attachments key", () => {
    const fromNew = parseControlPrev(JSON.stringify(NEW_INVOKE));
    expect(fromNew).toEqual(parseControlPrev(JSON.stringify(OLD_INVOKE)));
    expect("attachments" in fromNew).toBe(false);
  });

  it("the current parser differs from it ONLY by the images", () => {
    expect(invokeOf(NEW_INVOKE)).toEqual({ ...parseControlPrev(JSON.stringify(NEW_INVOKE)), attachments: [PNG, GIF] });
  });
});

describe("invokeImagesCapabilities: what a worker that reads the images announces", () => {
  it("invoke.images.v1 exactly when the invoke carries images", () => {
    expect(invokeImagesCapabilities(invokeOf(NEW_INVOKE))).toEqual([INVOKE_IMAGES_CAPABILITY]);
    expect(invokeImagesCapabilities(invokeOf(OLD_INVOKE))).toEqual([]);
    expect(invokeImagesCapabilities({ attachments: [] })).toEqual([]);
    expect(INVOKE_IMAGES_CAPABILITY).toBe("invoke.images.v1");
  });
});
