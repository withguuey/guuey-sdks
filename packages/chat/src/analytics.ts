/**
 * The inline chat's three usage events — the same vocabulary the embedded
 * widget hands a host page, stamped `surface: "inline"` so a read can tell
 * an inline `<GuueyChat>` from the widget's launcher panel.
 *
 *   - `helper_opened`       — the first visitor interaction per mount: focus
 *                              on the kit composer, a host's own input
 *                              reported through `GuueyChatHandle.markOpened`,
 *                              or the first visitor turn, whichever is first.
 *   - `helper_message_sent` — every visitor turn, 1-based within the mount
 *                              (the composer, a handle send, a suggestion
 *                              chip, a card's `ui/message`, a reply after a
 *                              listen). A retry of a failed send is the same
 *                              turn, not a new one.
 *   - `helper_cta_clicked`  — a click on a link rendered by the chat.
 *
 * Off unless the host opts in. Nothing is initialised and nothing is stored:
 * `true` hands each event to the host page's own PostHog client
 * (`window.posthog.capture`) when the page has one, and a function receives
 * the same calls. No transcript text ever rides: counts, the app id, the
 * generative-UI switch and a link's origin + path.
 *
 * React-free and pure apart from the sink: a throwing sink is contained, so
 * analytics can never break a send.
 */

/** The three event names. */
export type ChatAnalyticsEventName = "helper_opened" | "helper_message_sent" | "helper_cta_clicked";

/** The app's generative-UI switch as the read splits on it. */
export type ChatAnalyticsGui = "on" | "off";

export interface ChatAnalyticsOpenedProps {
  app_id: string;
  surface: "inline";
  gui: ChatAnalyticsGui;
}

export interface ChatAnalyticsMessageSentProps {
  app_id: string;
  /** The 1-based turn count within this mount — never the text. */
  turn: number;
  surface: "inline";
  gui: ChatAnalyticsGui;
}

export interface ChatAnalyticsCtaClickedProps {
  app_id: string;
  /** The link's `data-cta`, else its origin + path (never its query or hash); just the scheme for `mailto:` / `tel:`. */
  cta: string;
  surface: "inline";
  gui: ChatAnalyticsGui;
}

export interface ChatAnalyticsEventMap {
  helper_opened: ChatAnalyticsOpenedProps;
  helper_message_sent: ChatAnalyticsMessageSentProps;
  helper_cta_clicked: ChatAnalyticsCtaClickedProps;
}

export type ChatAnalyticsProps = ChatAnalyticsEventMap[ChatAnalyticsEventName];

/**
 * Where an event goes. Pass an arrow such as `(e, p) => posthog.capture(e, p)`,
 * never `posthog.capture` itself: a detached method loses its receiver.
 */
export type ChatAnalyticsSink = (event: ChatAnalyticsEventName, properties: ChatAnalyticsProps) => void;

export interface ChatAnalyticsOptions {
  /** `true` (the default) = the host page's `window.posthog`; a function = your own client. */
  capture?: true | ChatAnalyticsSink;
  /**
   * The app's generative-UI switch as its public card reports it
   * (`gguiEnabled`): `false` stamps `gui: "off"`; `true`, `null` and absent
   * stamp `"on"`, the runtime's own default.
   */
  gguiEnabled?: boolean | null;
}

/** The `analytics` prop: `false`/absent = off; `true` = the host's `window.posthog`; a function or options otherwise. */
export type ChatAnalyticsSetting = boolean | ChatAnalyticsSink | ChatAnalyticsOptions;

/** `false` = off; `true`, `null` and absent = on. */
export function chatAnalyticsGui(gguiEnabled: boolean | null | undefined): ChatAnalyticsGui {
  return gguiEnabled === false ? "off" : "on";
}

/**
 * A link's CTA id: the element's own `data-cta` when it declares one, else
 * the href's origin + path — never its query or hash (a URL may carry a
 * visitor's data there). A non-http(s) href is reduced to its scheme, so an
 * address never rides. `null` = nothing countable.
 */
export function chatCtaIdFor(anchor: { dataset?: DOMStringMap; href: string }): string | null {
  const declared = anchor.dataset?.["cta"];
  if (declared !== undefined && declared.trim() !== "") return declared.trim();
  const href = anchor.href.trim();
  if (href === "") return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    // Not an absolute URL: there is no origin to report, so nothing is counted.
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return url.protocol;
  return `${url.origin}${url.pathname}`;
}

/**
 * The host page's own PostHog client at CALL time (a snippet may install it
 * after the chat mounts), called as a method on the global — posthog-js
 * reads its own `this`. Absent → the event is dropped.
 */
export function hostPosthogSink(): ChatAnalyticsSink {
  return (event, properties) => {
    const client: unknown = Reflect.get(globalThis, "posthog");
    if (typeof client !== "object" || client === null || !("capture" in client)) return;
    const capture = client.capture;
    if (typeof capture !== "function") return;
    Reflect.apply(capture, client, [event, properties]);
  };
}

/** The setting → its sink and switch, or `null` when analytics is off. */
export function resolveChatAnalytics(
  setting: ChatAnalyticsSetting | undefined,
): { sink: ChatAnalyticsSink; gui: ChatAnalyticsGui } | null {
  if (setting === undefined || setting === false) return null;
  if (setting === true) return { sink: hostPosthogSink(), gui: "on" };
  if (typeof setting === "function") return { sink: setting, gui: "on" };
  const capture = setting.capture ?? true;
  return {
    sink: capture === true ? hostPosthogSink() : capture,
    gui: chatAnalyticsGui(setting.gguiEnabled),
  };
}

export interface ChatAnalytics {
  /** A visitor interaction; only the first per tracker emits. */
  opened(): void;
  /** One visitor turn (also the first interaction when nothing came before it). */
  messageSent(): void;
  /** A click on a link, by its CTA id (see {@link chatCtaIdFor}). */
  ctaClicked(cta: string): void;
}

/**
 * One tracker per chat mount. `read` is consulted at EMIT time, so a host
 * that turns analytics on, or learns its app's switch, after mount is read
 * live — and the opened flag and turn count never reset on a re-render.
 * Off (`read()` → null) or no app id → nothing emits, and nothing counts.
 */
export function createChatAnalytics(
  read: () => { appId: string | undefined; setting: ChatAnalyticsSetting | undefined },
): ChatAnalytics {
  let opened = false;
  let turns = 0;
  const target = (): { appId: string; sink: ChatAnalyticsSink; gui: ChatAnalyticsGui } | null => {
    const { appId, setting } = read();
    if (appId === undefined || appId === "") return null;
    // The host's options object is read here, outside `emit`'s containment of
    // the sink itself. A host getter that throws must never break the chat's
    // send: it counts nothing for this event and says why, like a failed sink.
    let resolved: ReturnType<typeof resolveChatAnalytics>;
    try {
      resolved = resolveChatAnalytics(setting);
    } catch (err) {
      console.warn("[guuey] analytics options could not be read", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
    return resolved === null ? null : { appId, ...resolved };
  };
  const emit = <E extends ChatAnalyticsEventName>(
    sink: ChatAnalyticsSink,
    event: E,
    properties: ChatAnalyticsEventMap[E],
  ): void => {
    try {
      sink(event, properties);
    } catch (err) {
      console.warn("[guuey] analytics sink failed", { event, error: err instanceof Error ? err.message : String(err) });
    }
  };
  const openedWith = (t: { appId: string; sink: ChatAnalyticsSink; gui: ChatAnalyticsGui }): void => {
    if (opened) return;
    opened = true;
    emit(t.sink, "helper_opened", { app_id: t.appId, surface: "inline", gui: t.gui });
  };
  return {
    opened() {
      const t = target();
      if (t !== null) openedWith(t);
    },
    messageSent() {
      const t = target();
      if (t === null) return;
      openedWith(t);
      turns += 1;
      emit(t.sink, "helper_message_sent", { app_id: t.appId, turn: turns, surface: "inline", gui: t.gui });
    },
    ctaClicked(cta) {
      const t = target();
      if (t === null) return;
      emit(t.sink, "helper_cta_clicked", { app_id: t.appId, cta, surface: "inline", gui: t.gui });
    },
  };
}
