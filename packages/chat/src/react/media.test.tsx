// @vitest-environment jsdom
/**
 * guuey#2369 — the web R7 renderer loads only what the plan decided:
 * inline audio bytes play from a `blob:` object URL revoked on unmount, an
 * off-origin https URL is a chip with an "open link" action and no element
 * that fetches it, and refused media is a labelled chip.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DefaultMedia, type TranscriptItemContext } from "./components.js";
import { defaultChatStrings } from "../strings.js";
import type { MediaItem } from "../types.js";

const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
afterEach(() => {
  cleanup();
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

const ctx: TranscriptItemContext = {
  strings: defaultChatStrings,
  onToggle: vi.fn(),
  resolvedMounts: new Map(),
  onViewPhase: vi.fn(),
};

const media = (over: Partial<MediaItem>): MediaItem => ({
  kind: "media",
  key: "media.t1.0",
  expanded: true,
  media: "image",
  source: { type: "url", url: "https://evil.test/p.png" },
  name: null,
  presentation: "inline",
  display: { kind: "chip", reason: "attachment" },
  toolCallId: "t1",
  ...over,
});

describe("DefaultMedia (guuey#2369)", () => {
  it("inline audio bytes play from a blob: URL that is revoked on unmount", () => {
    const create = vi.fn(() => "blob:https://host.test/audio-1");
    const revoke = vi.fn();
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    const { container, unmount } = render(
      <DefaultMedia
        item={media({
          media: "audio",
          source: { type: "base64", mediaType: "audio/wav", data: "UklGRg==" },
          display: { kind: "audio-bytes", mediaType: "audio/wav", data: "UklGRg==" },
        })}
        ctx={ctx}
      />,
    );
    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(audio!.getAttribute("src")).toBe("blob:https://host.test/audio-1");
    expect(create).toHaveBeenCalledTimes(1);
    unmount();
    expect(revoke).toHaveBeenCalledWith("blob:https://host.test/audio-1");
  });

  it("an off-origin https URL is a chip with an open-link action and no image element", () => {
    const { container } = render(
      <DefaultMedia item={media({ display: { kind: "link", url: "https://evil.test/p.png" } })} ctx={ctx} />,
    );
    expect(container.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: defaultChatStrings.mediaOpenLink });
    expect(link.getAttribute("href")).toBe("https://evil.test/p.png");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("a data: image renders without a link around it", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    const { container } = render(<DefaultMedia item={media({ display: { kind: "image", src } })} ctx={ctx} />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe(src);
    expect(container.querySelector("a")).toBeNull();
  });

  it("an oversized image is a labelled chip, not an image", () => {
    const { container } = render(
      <DefaultMedia item={media({ display: { kind: "chip", reason: "oversized" } })} ctx={ctx} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(defaultChatStrings.mediaOversized);
  });
});
