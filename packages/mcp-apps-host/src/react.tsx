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
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { attachViewHost, viewDocumentHtml, type AttachViewHostConfig } from "./view-host.js";
import { attachSandboxPageDelivery } from "./sandbox-page.js";
import type { ViewCspDiagnosis, ViewHostPhase } from "./view-host-protocol.js";
import type { ResolvedViewMount } from "./card-mount.js";

export { attachViewHost, viewDocumentHtml } from "./view-host.js";
export type { AttachViewHostConfig, ViewCspEvents, ViewFrameLike, ViewHostEvents } from "./view-host.js";
export {
  attachSandboxPageDelivery,
  isSandboxProxyReady,
  SANDBOX_PROXY_READY_METHOD,
  SANDBOX_RESOURCE_READY_METHOD,
  type SandboxPageDeliveryConfig,
} from "./sandbox-page.js";
export type { ViewCspDiagnosis, ViewCspOrigins, ViewHostPhase } from "./view-host-protocol.js";
export type { ResolvedViewMount, ViewMount, ViewMountChannel } from "./card-mount.js";

/** Accessible name for a mounted view when the caller has nothing better. */
const DEFAULT_TITLE = "Generated view";

export interface GuueyViewProps
  extends Pick<
    AttachViewHostConfig,
    | "hostCapabilities"
    | "hostInfo"
    | "hostContext"
    | "onCallTool"
    | "onUpdateModelContext"
    | "onUserMessage"
    | "onOpenLink"
    | "onReadResource"
    | "onSizeChanged"
    | "negotiationTimeoutMs"
    | "cspOrigins"
    | "onCspDiagnosis"
  > {
  /** The resolved card to mount (see `toolResultViewMount`/`resolveViewMount`). */
  mount: ResolvedViewMount;
  /**
   * Opt into the TWO-ORIGIN mount: instead of `srcdoc`, the frame loads
   * this host-served sandbox page (guuey's `/mcp-app-sandbox` pattern — the
   * caller builds the full URL, channel/app query included) and the
   * document is delivered over the page's relay protocol
   * (`attachSandboxPageDelivery`). Why: a `srcdoc` frame INHERITS the
   * embedder's CSP, so its egress confinement is whatever the page happens
   * to carry; the sandbox page is served WITH the per-request CSP that
   * confines the mount — and the untrusted document lands in the page's
   * own inner opaque frame, never in this one. In this mode the frame's
   * `sandbox` gains `allow-same-origin` — REQUIRED and safe: the frame
   * holds the cross-origin RELAY PAGE (which must run as its real origin
   * for its CSP + referrer checks to mean anything), never agent HTML.
   * The page must be a genuinely different origin; a same-origin URL is
   * refused with a labeled state, never mounted.
   *
   * `null` (as opposed to absent) means the two-origin mount is REQUIRED
   * by the embedder's posture but no page is configured — the mount is
   * refused with the same labeled state, and srcdoc is NEVER fallen back
   * to (falling back would silently trade the caller's egress confinement
   * for the page's CSP; the widget/Studio convergence posture).
   */
  sandboxPageUrl?: string | null;
  /**
   * Apply the view's own size reports (`ui/notifications/size-changed` —
   * spec surface) to the frame: a reported HEIGHT becomes the frame's
   * height; width stays the container's (a transcript column owns its
   * width). Default OFF — the primitive changes nothing for existing
   * hosts; a caller's {@link AttachViewHostConfig.onSizeChanged} observer
   * fires either way.
   */
  autoResize?: boolean;
  /**
   * Sandbox flags appended to the safe default (`allow-scripts`). Every
   * entry widens what agent-generated HTML may do — `allow-same-origin`
   * in particular hands it the embedder's origin. Prefer leaving unset.
   * In `sandboxPageUrl` mode these forward to the INNER frame via the
   * page's relay (which strips `allow-same-origin` regardless).
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
   * pixels) and nothing for a silent `"inline"` card. The second argument
   * is the CSP diagnosis when the tripwire caught one (see
   * {@link AttachViewHostConfig.cspOrigins}) — the default label folds it
   * in; a custom renderer decides how to show it.
   */
  renderStatus?: (phase: ViewHostPhase, diagnosis?: ViewCspDiagnosis) => ReactNode;
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

function defaultStatus(
  phase: ViewHostPhase,
  channel: ResolvedViewMount["channel"],
  diagnosis: ViewCspDiagnosis | undefined,
): ReactNode {
  if (phase === "negotiating") {
    return <p style={statusLineStyle}>Negotiating with view…</p>;
  }
  // A CSP diagnosis (guuey#235) is the WHY behind a silent frame — on any
  // channel: a blocked runtime bundle never gets to negotiate, so the
  // tripwire's verdict outranks the channel heuristic below. Actionable
  // over accurate-but-mute: name the blocked URI and the allowance.
  if (phase === "no-handshake" && diagnosis !== undefined) {
    return (
      <p role="alert" style={{ ...statusLineStyle, opacity: 1, pointerEvents: "auto" }}>
        {diagnosis.message}
      </p>
    );
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
    sandboxPageUrl,
    autoResize,
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
  // The CSP tripwire's verdict for THIS document, if any (guuey#235).
  const [diagnosis, setDiagnosis] = useState<ViewCspDiagnosis | undefined>(undefined);
  // The view's own size report, applied only under `autoResize`.
  const [reportedHeight, setReportedHeight] = useState<number | undefined>(undefined);
  const html = viewDocumentHtml(mount.resource);

  // Vet the sandbox page once per URL. Same-origin is REFUSED (the widget's
  // ResourceMount precedent, generalized): the whole point of the page is
  // being a different origin — same-origin would hand the relay page (and
  // through `allow-same-origin`, everything it can reach) the embedder's
  // own origin. `null` — page mode required but unconfigured — refuses the
  // same way: srcdoc is never a silent fallback for a confinement posture.
  const sandboxPage: URL | "refused" | undefined = useMemo(() => {
    if (sandboxPageUrl === undefined) return undefined;
    if (sandboxPageUrl === null) return "refused";
    let url: URL;
    try {
      url = new URL(sandboxPageUrl);
    } catch {
      return "refused";
    }
    if (typeof window !== "undefined" && url.origin === window.location.origin) return "refused";
    return url;
  }, [sandboxPageUrl]);
  const page = sandboxPage instanceof URL ? sandboxPage : undefined;

  // The attachment is keyed to the mounted DOCUMENT, not to every render's
  // fresh callback identities — host config rides a ref so the effect's
  // dependency list is honestly just the document identity.
  const latest = useRef({ hostConfig, onPhaseChange, dangerouslyAddSandboxFlags, autoResize });
  latest.current = { hostConfig, onPhaseChange, dangerouslyAddSandboxFlags, autoResize };

  useEffect(() => {
    // Keyed to the same identity the frame is (the resource uri): a new
    // document boots fresh, and the previous negotiation's phase must not
    // paper over it — nor must the previous document's reported size.
    setPhase("negotiating");
    setDiagnosis(undefined);
    setReportedHeight(undefined);
    const frame = frameRef.current;
    if (frame === null || html === undefined) return;
    if (sandboxPageUrl !== undefined && page === undefined) return; // refused config — nothing mounts
    const resourceUri = mount.resource.uri;
    // guuey#312: the resolved mount's DECLARED per-resource CSP
    // (`_meta.ui.csp`, spec-schema-validated at the reader) is the CSP
    // tripwire's default filter — the declaration finally doing host-side
    // work. An explicit `cspOrigins` prop always wins; both absent keeps
    // the tripwire inert exactly as before.
    const cspOrigins = latest.current.hostConfig.cspOrigins ?? mount.csp;
    const detachHost = attachViewHost(frame, {
      ...latest.current.hostConfig,
      ...(cspOrigins !== undefined ? { cspOrigins } : {}),
      resourceUri,
      onPhaseChange: (next) => {
        setPhase(next);
        latest.current.onPhaseChange?.(next);
      },
      onCspDiagnosis: (found) => {
        setDiagnosis(found);
        latest.current.hostConfig.onCspDiagnosis?.(found);
      },
      onSizeChanged: (size) => {
        if (latest.current.autoResize === true && size.height !== undefined) {
          setReportedHeight(size.height);
        }
        latest.current.hostConfig.onSizeChanged?.(size);
      },
    });
    if (page === undefined) return detachHost;
    // Two-origin mode: the page announces readiness, the document is
    // delivered over its relay (re-delivered on a reload's re-announce),
    // and the view-host handshake crosses the same relay transparently.
    const flags = latest.current.dangerouslyAddSandboxFlags;
    const detachDelivery = attachSandboxPageDelivery(frame, {
      pageOrigin: page.origin,
      html,
      ...(flags !== undefined && flags.length > 0
        ? { sandbox: ["allow-scripts", ...flags].join(" ") }
        : {}),
    });
    return () => {
      detachDelivery();
      detachHost();
    };
  }, [mount.resource.uri, html, sandboxPageUrl, page]);

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

  if (sandboxPageUrl !== undefined && page === undefined) {
    // A missing (null), malformed, or SAME-ORIGIN sandbox page is a
    // configuration state, not a property of the card — refused, labeled,
    // never mounted, and never silently downgraded to srcdoc. The copy
    // names the configuration cause (an operator can act on it) without
    // ever printing the offending URL.
    return (
      <div className={className} style={{ position: "relative", ...style }}>
        <p role="alert" style={{ ...statusLineStyle, opacity: 1, pointerEvents: "auto" }}>
          {sandboxPageUrl === null
            ? "Interactive view unavailable — no sandbox page is configured."
            : "Interactive view unavailable — the sandbox page is not usable from this origin."}
        </p>
      </div>
    );
  }

  return (
    <div className={className} style={{ position: "relative", ...style }}>
      <iframe
        ref={frameRef}
        // Remount on a new resource (or mount mode) rather than reusing the
        // frame: a view runtime boots once from the document it was handed,
        // so swapping `srcDoc` in place would leave the old boot running
        // against new markup.
        key={`${page?.href ?? "srcdoc"}::${mount.resource.uri}`}
        {...(page !== undefined ? { src: page.href } : { srcDoc: html })}
        title={title ?? DEFAULT_TITLE}
        // srcdoc mode: the INVARIANT — agent HTML in an opaque origin, extra
        // flags only widen knowingly. Page mode: the frame holds the
        // cross-origin RELAY PAGE, which must run as its real origin
        // (`allow-same-origin`) for its CSP/referrer machinery to exist at
        // all; the agent HTML lands in the page's own inner opaque frame,
        // and the caller's extra flags travel to THAT frame via the relay.
        sandbox={
          page !== undefined
            ? "allow-scripts allow-same-origin allow-forms"
            : ["allow-scripts", ...(dangerouslyAddSandboxFlags ?? [])].join(" ")
        }
        allow={allow ?? "clipboard-write"}
        // Under `autoResize`, the view's own height report wins over the
        // fill-the-container default (width stays the container's — a
        // transcript column owns its width).
        style={{
          display: "block",
          width: "100%",
          height: autoResize === true && reportedHeight !== undefined ? reportedHeight : "100%",
          border: 0,
        }}
      />
      {renderStatus !== undefined
        ? renderStatus(phase, diagnosis)
        : defaultStatus(phase, mount.channel, diagnosis)}
    </div>
  );
}
