/**
 * React entry point (`@guuey/mcp-apps-host/react`).
 *
 * `<GuueyView>` is the one React-coupled surface — the root subpath stays
 * React-free (narrowing, rehydration, the relay, `attachViewHost` itself),
 * so server-side consumers never import React at all. The component is a
 * CONVENIENCE composition of the framework-agnostic primitive: iframe
 * creation + the sandbox invariant + the handshake + lifecycle. A host
 * that needs a different composition (a transcript renderer, a non-React
 * surface) uses `attachViewHost` directly.
 *
 * ## Sandbox posture (invariant, not preference)
 *
 * `sandbox="allow-scripts"` WITHOUT `allow-same-origin`: a `srcdoc` frame
 * inherits its embedder's origin, so granting both would run
 * agent-generated HTML AS the embedding page — reach into its DOM and its
 * signed-in session, an XSS by construction. Dropping `allow-same-origin`
 * puts the document in an opaque origin instead. Extra flags ride ON TOP
 * via {@link GuueyViewProps.dangerouslyAddSandboxFlags} — named the way it
 * is because every flag it adds widens what agent-generated HTML can do.
 * `allow="clipboard-write"` is delegated by default: generated views own
 * copy buttons, and without the delegation every one of them silently
 * no-ops inside the opaque origin.
 *
 * ## Who paints which state
 *
 * While `"negotiating"`, the component shows a small non-blocking status
 * line — never a bare blank frame (guuey#186 audit). On `"connected"` the
 * view owns its pixels (and its own failures) and the line disappears. On
 * `"no-handshake"` the meaning is channel-aware: a `"ggui"` shell always
 * negotiates, so silence is a boot failure and is labeled as one; an
 * `"inline"` card is arbitrary tenant HTML with no handshake obligation,
 * so the status line simply retires and the document stands as rendered.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { attachViewHost, viewDocumentHtml, type AttachViewHostConfig } from "./view-host.js";
import type { ViewHostPhase } from "./view-host-protocol.js";
import type { ResolvedViewMount } from "./card-mount.js";

export { attachViewHost, viewDocumentHtml } from "./view-host.js";
export type { AttachViewHostConfig, ViewFrameLike, ViewHostEvents } from "./view-host.js";
export type { ViewHostPhase } from "./view-host-protocol.js";
export type { ResolvedViewMount, ViewMount, ViewMountChannel } from "./card-mount.js";

/** Accessible name for a mounted view when the caller has nothing better. */
const DEFAULT_TITLE = "Generated view";

export interface GuueyViewProps
  extends Pick<
    AttachViewHostConfig,
    "hostCapabilities" | "hostInfo" | "hostContext" | "onCallTool" | "negotiationTimeoutMs"
  > {
  /** The resolved card to mount (see `toolResultViewMount`/`resolveViewMount`). */
  mount: ResolvedViewMount;
  /**
   * Sandbox flags appended to the safe default (`allow-scripts`). Every
   * entry widens what agent-generated HTML may do — `allow-same-origin`
   * in particular hands it the embedder's origin. Prefer leaving unset.
   */
  dangerouslyAddSandboxFlags?: string[];
  /** Permissions-Policy delegation for the frame. Default `clipboard-write`. */
  allow?: string;
  /** Accessible frame title. Default "Generated view". */
  title?: string;
  className?: string;
  style?: CSSProperties;
  /** Observe the negotiation phase (the same states the default UI labels). */
  onPhaseChange?: (phase: ViewHostPhase) => void;
  /**
   * Replace the default status/failure line for a phase. Return `null` for
   * "render nothing". The default: a quiet "Negotiating with view…" line
   * while `"negotiating"`; a labeled failure for `"no-handshake"` on the
   * `"ggui"` channel; nothing once `"connected"` (the view owns its
   * pixels) and nothing for a silent `"inline"` card.
   */
  renderStatus?: (phase: ViewHostPhase) => ReactNode;
}

const statusLineStyle: CSSProperties = {
  position: "absolute",
  insetInlineStart: 8,
  insetBlockEnd: 8,
  margin: 0,
  padding: "2px 8px",
  fontSize: 12,
  lineHeight: "18px",
  opacity: 0.65,
  pointerEvents: "none",
};

function defaultStatus(phase: ViewHostPhase, channel: ResolvedViewMount["channel"]): ReactNode {
  if (phase === "negotiating") {
    return <p style={statusLineStyle}>Negotiating with view…</p>;
  }
  if (phase === "no-handshake" && channel === "ggui") {
    // A ggui shell negotiates unconditionally before painting, so silence
    // here is a boot failure with no other author — label it (role=alert
    // so it is announced, not just drawn).
    return (
      <p role="alert" style={{ ...statusLineStyle, opacity: 1, pointerEvents: "auto" }}>
        This view did not start — it never negotiated with the host.
      </p>
    );
  }
  return null;
}

/**
 * Mount a resolved view and play the MCP Apps Host for it. See the module
 * docblock for the sandbox and state contracts.
 */
export function GuueyView(props: GuueyViewProps): ReactNode {
  const {
    mount,
    dangerouslyAddSandboxFlags,
    allow,
    title,
    className,
    style,
    onPhaseChange,
    renderStatus,
    ...hostConfig
  } = props;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<ViewHostPhase>("negotiating");
  const html = viewDocumentHtml(mount.resource);

  // The attachment is keyed to the mounted DOCUMENT, not to every render's
  // fresh callback identities — host config rides a ref so the effect's
  // dependency list is honestly just the document identity.
  const latest = useRef({ hostConfig, onPhaseChange });
  latest.current = { hostConfig, onPhaseChange };

  useEffect(() => {
    // Keyed to the same identity the frame is (the resource uri): a new
    // document boots fresh, and the previous negotiation's phase must not
    // paper over it.
    setPhase("negotiating");
    const frame = frameRef.current;
    if (frame === null || html === undefined) return;
    const resourceUri = mount.resource.uri;
    return attachViewHost(frame, {
      ...latest.current.hostConfig,
      resourceUri,
      onPhaseChange: (next) => {
        setPhase(next);
        latest.current.onPhaseChange?.(next);
      },
    });
  }, [mount.resource.uri, html]);

  if (html === undefined) {
    // A resolved mount with no document is producer-side breakage; an
    // empty frame would be a lie. Label it, in the same voice as the
    // no-handshake state.
    return (
      <div className={className} style={{ position: "relative", ...style }}>
        <p role="alert" style={{ ...statusLineStyle, opacity: 1, pointerEvents: "auto" }}>
          This view could not be displayed — its resource carries no document.
        </p>
      </div>
    );
  }

  return (
    <div className={className} style={{ position: "relative", ...style }}>
      <iframe
        ref={frameRef}
        // Remount on a new resource rather than reusing the frame: a view
        // runtime boots once from the document it was handed, so swapping
        // `srcDoc` in place would leave the old boot running against new
        // markup.
        key={mount.resource.uri}
        srcDoc={html}
        title={title ?? DEFAULT_TITLE}
        sandbox={["allow-scripts", ...(dangerouslyAddSandboxFlags ?? [])].join(" ")}
        allow={allow ?? "clipboard-write"}
        style={{ display: "block", width: "100%", height: "100%", border: 0 }}
      />
      {renderStatus !== undefined ? renderStatus(phase) : defaultStatus(phase, mount.channel)}
    </div>
  );
}
