import { describe, expect, it } from "vitest";
import {
  assertSafeSegment,
  layerSegments,
  ENV_HOME_DIR,
  ENV_APP_DIR,
  LAYER_NAMES,
} from "./contract.js";

describe("contract constants", () => {
  it("exposes the env var names and the three layer names", () => {
    expect(ENV_HOME_DIR).toBe("GUUEY_HOME_DIR");
    expect(ENV_APP_DIR).toBe("GUUEY_APP_DIR");
    expect(LAYER_NAMES).toEqual(["app", "home", "session"]);
  });
});

describe("layerSegments", () => {
  const key = { appId: "app1", userId: "user1", sessionId: "sess1" };
  it("maps app → <appId>/shared", () => {
    expect(layerSegments(key, "app")).toEqual(["app1", "shared"]);
  });
  it("maps home → <appId>/users/<userId>/memory", () => {
    expect(layerSegments(key, "home")).toEqual(["app1", "users", "user1", "memory"]);
  });
  it("maps session → <appId>/users/<userId>/sessions/<sessionId>", () => {
    expect(layerSegments(key, "session")).toEqual(["app1", "users", "user1", "sessions", "sess1"]);
  });
  it("rejects path-traversal in any used segment", () => {
    expect(() => layerSegments({ ...key, userId: "../etc" }, "home")).toThrow(/userId/);
    expect(() => layerSegments({ ...key, appId: "a/b" }, "app")).toThrow(/appId/);
    expect(() => layerSegments({ ...key, sessionId: ".." }, "session")).toThrow(/sessionId/);
  });
});

describe("assertSafeSegment", () => {
  it("accepts a plain segment", () => {
    expect(() => assertSafeSegment("abc-123", "x")).not.toThrow();
  });
  it("rejects empty, dotdot, and separators", () => {
    expect(() => assertSafeSegment("", "x")).toThrow();
    expect(() => assertSafeSegment("..", "x")).toThrow();
    expect(() => assertSafeSegment("a/b", "x")).toThrow();
    expect(() => assertSafeSegment("a\\b", "x")).toThrow();
  });
});
