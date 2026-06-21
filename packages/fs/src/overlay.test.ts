import { describe, expect, it } from "vitest";
import { resolveRead, resolveWrite } from "./overlay.js";

describe("resolveRead (precedence session > home > app)", () => {
  it("returns the topmost present layer", () => {
    expect(resolveRead({ app: true, home: true, session: true })).toBe("session");
    expect(resolveRead({ app: true, home: true, session: false })).toBe("home");
    expect(resolveRead({ app: true, home: false, session: false })).toBe("app");
  });
  it("returns null when absent everywhere", () => {
    expect(resolveRead({ app: false, home: false, session: false })).toBeNull();
  });
});

describe("resolveWrite (CoW)", () => {
  it("defaults durable writes to home", () => {
    expect(resolveWrite({ app: false, home: true, session: false })).toEqual({
      target: "home",
      copyUpFrom: null,
    });
  });
  it("routes ephemeral writes to session", () => {
    expect(resolveWrite({ app: false, home: false, session: true }, { ephemeral: true })).toEqual({
      target: "session",
      copyUpFrom: null,
    });
  });
  it("copies up from app when the file lives only in the read-only base", () => {
    expect(resolveWrite({ app: true, home: false, session: false })).toEqual({
      target: "home",
      copyUpFrom: "app",
    });
  });
  it("does not copy up when the file already exists in a writable layer", () => {
    expect(resolveWrite({ app: true, home: true, session: false })).toEqual({
      target: "home",
      copyUpFrom: null,
    });
  });
});
