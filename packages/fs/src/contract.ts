/**
 * The GuueyFS 3-layer contract: layer names, the env-var/mount-point constants the
 * Router injects, and the pure storage-path mapper shared by every FsSource adapter
 * (LocalFsSource here, JuiceFsSource in slice 4). See spec §4.
 */

export type LayerName = "app" | "home" | "session";

/** Canonical layer order (read precedence is the reverse — see overlay.ts). */
export const LAYER_NAMES: readonly LayerName[] = ["app", "home", "session"];

/** Env vars the Router injects so agent code reaches the home/app layers portably. */
export const ENV_HOME_DIR = "GUUEY_HOME_DIR";
export const ENV_APP_DIR = "GUUEY_APP_DIR";

/** Absolute mount points pinned inside the production bubblewrap sandbox (slice 5). */
export const MOUNT_APP = "/app";
export const MOUNT_HOME = "/home";
export const MOUNT_SESSION = "/session";

/** The three resolved layer roots for one (app, user, session). */
export interface Layers {
  /** read-only (CoW) shared per-app layer */
  appDir: string;
  /** read-write durable per-user cross-session memory */
  homeDir: string;
  /** read-write per-session working dir (becomes the worker's cwd) */
  sessionDir: string;
}

/** Identity selecting a layer set. */
export interface LayerKey {
  appId: string;
  userId: string;
  sessionId: string;
}

/** Throws if `value` is not a single safe path segment (guards path traversal). */
export function assertSafeSegment(value: string, label: string): void {
  if (!value || value === "." || value === ".." || /[/\\\0]/.test(value)) {
    throw new Error(
      `Invalid ${label}: ${JSON.stringify(value)} — must be a single non-empty path segment with no separators.`
    );
  }
}

/**
 * Storage-relative path **segments** for a layer (spec §4 S3 layout). Returning
 * segments (not a joined string) keeps this pure and separator-agnostic: LocalFsSource
 * joins with `path.join`; a future JuiceFsSource/S3 adapter joins with `/`.
 */
export function layerSegments(key: LayerKey, layer: LayerName): string[] {
  assertSafeSegment(key.appId, "appId");
  switch (layer) {
    case "app":
      return [key.appId, "shared"];
    case "home":
      assertSafeSegment(key.userId, "userId");
      return [key.appId, "users", key.userId, "memory"];
    case "session":
      assertSafeSegment(key.userId, "userId");
      assertSafeSegment(key.sessionId, "sessionId");
      return [key.appId, "users", key.userId, "sessions", key.sessionId];
  }
}
