import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFsSource } from "./local-fs-source.js";

describe("LocalFsSource", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "guuey-fs-"));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("resolves the three layer dirs under the base and creates them", async () => {
    const src = new LocalFsSource({ baseDir: base });
    const layers = await src.resolveLayers({ appId: "app1", userId: "u1", sessionId: "s1" });

    expect(layers.appDir).toBe(join(base, "app1", "shared"));
    expect(layers.homeDir).toBe(join(base, "app1", "users", "u1", "memory"));
    expect(layers.sessionDir).toBe(join(base, "app1", "users", "u1", "sessions", "s1"));

    for (const dir of [layers.appDir, layers.homeDir, layers.sessionDir]) {
      expect((await stat(dir)).isDirectory()).toBe(true);
    }
  });

  it("defaults the base to ./.guuey/fs when no baseDir is given", async () => {
    const src = new LocalFsSource();
    const layers = await src.resolveLayers({ appId: "a", userId: "u", sessionId: "s" });
    // resolved against cwd; assert the project-local segment, not ~/.guuey
    expect(layers.homeDir).toContain(join(".guuey", "fs", "a", "users", "u", "memory"));
    // clean up the dir this created under cwd
    await rm(join(".guuey"), { recursive: true, force: true });
  });
});
