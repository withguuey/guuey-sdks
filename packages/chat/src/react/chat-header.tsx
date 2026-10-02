/**
 * The kit's ONE head row (guuey#1150, consumers guuey#1169).
 *
 * `<GuueyChat header={…}>` renders this as the first child of its surface. A
 * host that owns its own composer and mounts `<Transcript>` directly (it never
 * mounts `<GuueyChat>`) renders the same component above its transcript, so
 * every surface that draws a chat head draws THIS one: the same markup, the
 * same class names, the same `::part(header)` hook. There is no second copy
 * of the row to keep in step.
 *
 * Outside a `.guuey-chat-surface` the theme stamp is not an ancestor, so the
 * row's `var(--guuey-chat-X, var(--_guuey-chat-X))` reads resolve only where
 * the host states them; such a host styles the row through the class names
 * (the light-DOM contract), as it styles the rest of its own chrome.
 */
import type { ReactNode } from "react";

import { defaultChatStrings, type ChatStrings } from "../strings.js";
import { PARTS } from "./parts.js";

/**
 * The header slot (guuey#1150): the ONE head row over a conversation —
 * title, the host's own controls, and an optional close.
 */
export interface GuueyChatHeader {
  /** The row's title — the agent's name, a brand mark, anything renderable. */
  title: ReactNode;
  /**
   * Renders the kit's close control (rightmost in the row, accessible
   * name `strings.headerClose`) and fires on its click. Absent → no close
   * control at all: a docked or full-page surface has nothing to close.
   */
  onClose?: () => void;
  /**
   * The host's own controls, rendered right of the title and LEFT of the
   * close (Stop, clear, expand — whatever the host's design calls for).
   * The kit never invents controls here.
   */
  actions?: ReactNode;
}

export interface ChatHeaderProps {
  header: GuueyChatHeader;
  /**
   * The strings the row reads (`headerClose`, the close control's name).
   * Absent → the kit's defaults; `<GuueyChat>` passes its merged strings.
   */
  strings?: Pick<ChatStrings, "headerClose">;
}

/**
 * `<header class="guuey-chat-header">` with `guuey-chat-header-title`,
 * `guuey-chat-header-actions` (present only when there is something to put
 * in it) and `guuey-chat-header-close`.
 */
export function ChatHeader({ header, strings = defaultChatStrings }: ChatHeaderProps): ReactNode {
  return (
    <header className="guuey-chat-header" part={PARTS.header}>
      <div className="guuey-chat-header-title">{header.title}</div>
      {(header.actions !== undefined || header.onClose !== undefined) && (
        <div className="guuey-chat-header-actions">
          {header.actions}
          {header.onClose !== undefined && (
            <button
              type="button"
              className="guuey-chat-header-close"
              aria-label={strings.headerClose}
              onClick={header.onClose}
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>
      )}
    </header>
  );
}
