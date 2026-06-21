import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FsSource } from "./fs-source.js";
import { type LayerKey, type Layers, layerSegments } from "./contract.js";

export interface LocalFsSourceOptions {
  /** Base dir for the dev FS tree. Default: ./.guuey/fs (project-local, NOT ~/.guuey). */
  baseDir?: string;
}

/**
 * Dev adapter: resolves each layer to a directory under a project-local base and
 * creates it. The on-disk layout mirrors the production S3 layout (spec §4), so a
 * builder inspecting `./.guuey/fs/...` sees exactly the structure prod will have.
 */
export class LocalFsSource implements FsSource {
  private readonly base: string;

  constructor(opts: LocalFsSourceOptions = {}) {
    this.base = resolve(opts.baseDir ?? join(".guuey", "fs"));
  }

  async resolveLayers(key: LayerKey): Promise<Layers> {
    const appDir = join(this.base, ...layerSegments(key, "app"));
    const homeDir = join(this.base, ...layerSegments(key, "home"));
    const sessionDir = join(this.base, ...layerSegments(key, "session"));
    await Promise.all([
      mkdir(appDir, { recursive: true }),
      mkdir(homeDir, { recursive: true }),
      mkdir(sessionDir, { recursive: true }),
    ]);
    return { appDir, homeDir, sessionDir };
  }
}
