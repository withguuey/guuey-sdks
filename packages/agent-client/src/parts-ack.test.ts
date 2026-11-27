import { describe, expect, it } from "vitest";
import { readAccepts } from "./input-kinds.js";
import { countPartKinds, partsAcknowledged } from "./parts-ack.js";
import type { UserPart } from "./user-parts.js";

const image: UserPart = { type: "image", source: { type: "url", url: "https://cdn.example/a.png" } };
const audio: UserPart = { type: "audio", source: { type: "base64", mediaType: "audio/wav", data: "AAAA" } };

describe("partsAcknowledged: shape 1 (images only, under accepts.attachments)", () => {
  it("a turn without images is acknowledged whatever the frame says", () => {
    expect(partsAcknowledged({}, { shape: 1, images: 0 })).toBe(true);
  });

  it("every image must be counted: equal passes, short or absent is refused", () => {
    expect(partsAcknowledged({ attachments: 2 }, { shape: 1, images: 2 })).toBe(true);
    expect(partsAcknowledged({ attachments: 1 }, { shape: 1, images: 2 })).toBe(false);
    expect(partsAcknowledged({}, { shape: 1, images: 2 })).toBe(false);
  });

  it("shape 1 never reads accepts.parts", () => {
    expect(partsAcknowledged({ parts: { image: 2 } }, { shape: 1, images: 2 })).toBe(false);
  });
});

describe("partsAcknowledged: shape 2 (every kind sent, under accepts.parts)", () => {
  it("a turn without parts is acknowledged, with or without accepts.parts", () => {
    expect(partsAcknowledged({}, { shape: 2, parts: {} })).toBe(true);
    expect(partsAcknowledged({ parts: {} }, { shape: 2, parts: {} })).toBe(true);
  });

  it("images count under accepts.parts.image: equal passes, short, zero or absent is refused", () => {
    expect(partsAcknowledged({ parts: { image: 2 } }, { shape: 2, parts: { image: 2 } })).toBe(true);
    expect(partsAcknowledged({ parts: { image: 1 } }, { shape: 2, parts: { image: 2 } })).toBe(false);
    expect(partsAcknowledged({ parts: { image: 0 } }, { shape: 2, parts: { image: 2 } })).toBe(false);
    expect(partsAcknowledged({ parts: {} }, { shape: 2, parts: { image: 2 } })).toBe(false);
    expect(partsAcknowledged({}, { shape: 2, parts: { image: 2 } })).toBe(false);
  });

  it("a count above what was sent is not an acknowledgement: the counts must be equal", () => {
    expect(partsAcknowledged({ parts: { image: 3 } }, { shape: 2, parts: { image: 2 } })).toBe(false);
    expect(partsAcknowledged({ attachments: 3 }, { shape: 1, images: 2 })).toBe(false);
  });

  it("the old image key does not acknowledge a shape-2 image (one home: accepts.parts)", () => {
    expect(partsAcknowledged({ attachments: 2 }, { shape: 2, parts: { image: 2 } })).toBe(false);
  });

  it("mixed: images acknowledged but another kind refused reads as refused", () => {
    expect(partsAcknowledged({ parts: { image: 1, audio: 0 } }, { shape: 2, parts: { image: 1, audio: 1 } })).toBe(false);
    expect(partsAcknowledged({ parts: { image: 1 } }, { shape: 2, parts: { image: 1, audio: 1 } })).toBe(false);
    expect(partsAcknowledged({ parts: { image: 1, audio: 1 } }, { shape: 2, parts: { image: 1, audio: 1 } })).toBe(true);
  });

  it("a kind the turn did not send is never asked about", () => {
    expect(partsAcknowledged({ parts: { image: 1, audio: 0 } }, { shape: 2, parts: { image: 1 } })).toBe(true);
  });
});

describe("partsAcknowledged over a session frame read by readAccepts", () => {
  it("a shape-2 frame carrying accepts.parts acknowledges the turn it counts", () => {
    const frame = { type: "session", threadId: "t", accepts: { inputKinds: [], requestShape: 2, parts: { image: 2 } } };
    expect(partsAcknowledged(readAccepts(frame), { shape: 2, parts: { image: 2 } })).toBe(true);
  });

  it("a frame with only the old image keys does not acknowledge a shape-2 image turn", () => {
    const frame = { type: "session", accepts: { inputKinds: [], attachments: 2 }, attachments: { accepted: 2 } };
    expect(partsAcknowledged(readAccepts(frame), { shape: 2, parts: { image: 2 } })).toBe(false);
    expect(partsAcknowledged(readAccepts(frame), { shape: 1, images: 2 })).toBe(true);
  });

  it("a malformed count is dropped by readAccepts, so it acknowledges nothing", () => {
    const frame = { type: "session", accepts: { parts: { image: "2" } } };
    expect(partsAcknowledged(readAccepts(frame), { shape: 2, parts: { image: 2 } })).toBe(false);
  });
});

describe("countPartKinds", () => {
  it("counts each kind present and leaves the others absent", () => {
    expect(countPartKinds([image, audio, image])).toEqual({ image: 2, audio: 1 });
    expect(countPartKinds([])).toEqual({});
  });
});
