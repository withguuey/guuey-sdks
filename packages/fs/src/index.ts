/**
 * @guuey/fs — GuueyFS per-(app,user,session) 3-layer filesystem contract, the
 * FsSource port, the dev LocalFsSource adapter, the injected-roots helper, and the
 * pure overlay/CoW semantics. See docs/superpowers/specs/2026-06-21-agent-runtime-guueyfs-design.md.
 */

export {
  LAYER_NAMES,
  ENV_HOME_DIR,
  ENV_APP_DIR,
  MOUNT_APP,
  MOUNT_HOME,
  MOUNT_SESSION,
  assertSafeSegment,
  layerSegments,
} from "./contract.js";
export type { LayerName, Layers, LayerKey } from "./contract.js";

export type { FsSource } from "./fs-source.js";
export { LocalFsSource } from "./local-fs-source.js";
export type { LocalFsSourceOptions } from "./local-fs-source.js";

export { homeDir, appDir, sessionDir } from "./roots.js";

export { resolveRead, resolveWrite } from "./overlay.js";
export type { LayerPresence, WriteResolution } from "./overlay.js";
