// @vitest-environment jsdom
/**
 * `<ChatHeader>` standalone (guuey#1169): the row a host renders above its
 * own `<Transcript>` is the row `<GuueyChat header>` draws — same markup,
 * same class names, same `part`. The `<GuueyChat>` side of the contract is
 * pinned in `guuey-chat.test.tsx`; this file pins the component itself and
 * that the two render the same bytes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatHeader } from "./chat-header.js";
import { PARTS } from "./parts.js";

afterEach(cleanup);

describe("ChatHeader — the kit's one head row, rendered by a host (guuey#1169)", () => {
  it("renders <header class=guuey-chat-header part=header> with the title", () => {
    const { container } = render(
      <ChatHeader header={{ title: <span data-testid="t">Agent</span> }} />
    );
    const header = container.firstElementChild;
    expect(header?.tagName).toBe("HEADER");
    expect(header?.className).toBe("guuey-chat-header");
    expect(header?.getAttribute("part")).toBe(PARTS.header);
    expect(header?.querySelector(".guuey-chat-header-title [data-testid='t']")?.textContent).toBe(
      "Agent"
    );
  });

  it("title only ⇒ no actions wrapper and no close control", () => {
    const { container } = render(<ChatHeader header={{ title: "Agent" }} />);
    expect(container.querySelector(".guuey-chat-header-actions")).toBeNull();
    expect(container.querySelector(".guuey-chat-header-close")).toBeNull();
  });

  it("host actions render in the actions slot, with no close when onClose is absent", () => {
    const onStop = vi.fn();
    const { container } = render(
      <ChatHeader
        header={{
          title: "Agent",
          actions: (
            <button type="button" onClick={onStop}>
              Stop
            </button>
          ),
        }}
      />
    );
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop.closest(".guuey-chat-header-actions")).not.toBeNull();
    expect(container.querySelector(".guuey-chat-header-close")).toBeNull();
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("onClose renders the close with the default string, overridable through strings", () => {
    const onClose = vi.fn();
    const { rerender } = render(<ChatHeader header={{ title: "Agent", onClose }} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <ChatHeader header={{ title: "Agent", onClose }} strings={{ headerClose: "Schließen" }} />
    );
    expect(screen.getByRole("button", { name: "Schließen" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("the full row's markup is stable (title → actions → close)", () => {
    expect(
      renderToStaticMarkup(
        <ChatHeader header={{ title: "Agent", actions: <i>a</i>, onClose: () => {} }} />
      )
    ).toBe(
      '<header class="guuey-chat-header" part="header"><div class="guuey-chat-header-title">Agent</div>' +
        '<div class="guuey-chat-header-actions"><i>a</i><button type="button" class="guuey-chat-header-close" aria-label="Close">' +
        '<span aria-hidden="true">×</span></button></div></header>'
    );
  });
});
