import type { LayerName } from "./contract.js";

/**
 * Whether a given relative path exists in each layer. The caller supplies this from
 * real `stat()`s; this module stays pure so the copy-on-write rules live in one
 * tested place. The real union/FUSE mount that consumes these rules is slices 4–5.
 */
export interface LayerPresence {
  app: boolean;
  home: boolean;
  session: boolean;
}

/** Read resolution: the topmost present layer wins (session > home > app); null if absent. */
export function resolveRead(presence: LayerPresence): LayerName | null {
  if (presence.session) return "session";
  if (presence.home) return "home";
  if (presence.app) return "app";
  return null;
}

export interface WriteResolution {
  /** Writable layer the write lands in — never the read-only `app` base. */
  target: Exclude<LayerName, "app">;
  /** Set when the file currently exists ONLY in the read-only app base and must be
   *  copied up into `target` before the write (copy-on-write); null otherwise. */
  copyUpFrom: "app" | null;
}

/**
 * Write resolution with copy-up. Writes never mutate the read-only app base: durable
 * writes land in `home` (default), ephemeral ones in `session`. A file that exists
 * ONLY in the app base is copied up into the target first.
 */
export function resolveWrite(
  presence: LayerPresence,
  opts: { ephemeral?: boolean } = {}
): WriteResolution {
  const target: Exclude<LayerName, "app"> = opts.ephemeral ? "session" : "home";
  const onlyInApp = presence.app && !presence.home && !presence.session;
  return { target, copyUpFrom: onlyInApp ? "app" : null };
}
