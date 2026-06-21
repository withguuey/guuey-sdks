import { describe, expect, it } from "vitest";
import { GUUEY_FS_PACKAGE } from "./index.js";

describe("@guuey/fs", () => {
  it("is importable", () => {
    expect(GUUEY_FS_PACKAGE).toBe("@guuey/fs");
  });
});
