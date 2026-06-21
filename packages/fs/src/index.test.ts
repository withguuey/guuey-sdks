import { describe, expect, it } from "vitest";
import { LocalFsSource, layerSegments, homeDir, resolveWrite, ENV_HOME_DIR } from "./index.js";
import type { FsSource, Layers, LayerKey, LayerName, LayerPresence } from "./index.js";

describe("@guuey/fs public API", () => {
  it("re-exports the contract, adapter, roots, and overlay surface", () => {
    expect(typeof LocalFsSource).toBe("function");
    expect(layerSegments({ appId: "a", userId: "u", sessionId: "s" }, "app")).toEqual([
      "a",
      "shared",
    ]);
    expect(homeDir({ [ENV_HOME_DIR]: "/home" })).toBe("/home");
    expect(resolveWrite({ app: true, home: false, session: false }).copyUpFrom).toBe("app");
    // type-only references compile:
    const _t: [FsSource, Layers, LayerKey, LayerName, LayerPresence] | null = null;
    expect(_t).toBeNull();
  });
});
