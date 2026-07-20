import { describe, expect, it } from "vitest";
import { homeDir, appDir, sessionDir, ENV_HOME_DIR, ENV_APP_DIR } from "./index.js";

describe("@guuey/fs public API", () => {
  it("re-exports the roots helper + its env-var constants", () => {
    expect(ENV_HOME_DIR).toBe("GUUEY_HOME_DIR");
    expect(ENV_APP_DIR).toBe("GUUEY_APP_DIR");
    expect(homeDir({ [ENV_HOME_DIR]: "/home" })).toBe("/home");
    expect(appDir({ [ENV_APP_DIR]: "/app" })).toBe("/app");
    expect(sessionDir(() => "/session")).toBe("/session");
  });
});
