import type { LayerKey, Layers } from "./contract.js";

/**
 * Resolves the three GuueyFS layer roots for a session. Implementations MUST ensure
 * the returned directories exist. Adapters: `LocalFsSource` (dev, this slice) and
 * `JuiceFsSource` (prod, slice 4). This is the seam the Router (slice 2) depends on.
 *
 * (Object-form of the spec's `resolveLayers(appId, userId, sessionId)` — an object
 * key avoids positional-argument mistakes.)
 */
export interface FsSource {
  resolveLayers(key: LayerKey): Promise<Layers>;
}
