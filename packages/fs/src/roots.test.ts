import { describe, expect, it } from "vitest";
import { homeDir, appDir, sessionDir } from "./roots.js";

describe("injected-roots helper", () => {
  it("reads home/app from the provided env", () => {
    const env = { GUUEY_HOME_DIR: "/home", GUUEY_APP_DIR: "/app" };
    expect(homeDir(env)).toBe("/home");
    expect(appDir(env)).toBe("/app");
  });

  it("throws a clear error when a root env var is unset", () => {
    expect(() => homeDir({})).toThrow(/GUUEY_HOME_DIR/);
    expect(() => appDir({})).toThrow(/GUUEY_APP_DIR/);
  });

  it("returns the cwd for the session dir", () => {
    expect(sessionDir(() => "/session")).toBe("/session");
  });
});
