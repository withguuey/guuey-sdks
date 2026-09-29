// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";
import { GUUEY_CHAT_THEME, type GuueyChatFace, type GuueyChatTheme } from "../theme.js";
import { calmPolicy } from "../policy.js";
import { planTranscript } from "../plan.js";
import { facesCss, Transcript, useHostFaces } from "../react.js";
import { useHostFaces as fromFaces } from "./faces.js";

afterEach(cleanup);

/**
 * `@guuey/chat/react` exports `useHostFaces`, so a host can load the theme's
 * faces into its document before any `<Transcript>` exists (an empty thread
 * draws the host's own header and empty state). The kit's injection is once
 * per document per rule set, so a host call plus the transcript's own call
 * add one set of faces, never two.
 *
 * The registry of injected rule sets lives for the whole document, so each
 * test uses its own family.
 */
function themeWith(face: GuueyChatFace): GuueyChatTheme {
  return { ...GUUEY_CHAT_THEME, typography: { ...GUUEY_CHAT_THEME.typography, faces: [face] } };
}

function facesFor(family: string): Element[] {
  return Array.from(document.head.querySelectorAll("style[data-guuey-faces]")).filter((el) =>
    (el.textContent ?? "").includes(`font-family:"${family}"`),
  );
}

function HostChrome({ theme, children }: { theme: GuueyChatTheme; children?: ReactNode }) {
  useHostFaces(facesCss(theme.typography.faces));
  return <header>{children}</header>;
}

const oneTurnPlan = () =>
  planTranscript(
    {
      result: null,
      assistantText: "",
      status: "ready",
      statusElapsedMs: 0,
      activeTool: null,
      error: null,
      prompts: [],
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi" },
      ],
    },
    calmPolicy(),
  );

const noopCtx = {
  onToggle: () => {},
  resolvedMounts: new Map<string, never>(),
  onViewPhase: () => {},
};

describe("@guuey/chat/react — useHostFaces for a host's own chrome", () => {
  it("is the kit's own hook (the one <Transcript> calls), by identity", () => {
    expect(useHostFaces).toBe(fromFaces);
  });

  it("a host that renders no <Transcript> (an empty thread) gets the theme's faces in its document", () => {
    const theme = themeWith({ family: "Host Empty Face", src: "https://fonts.example.test/host-empty.woff2", weight: "400" });
    render(<HostChrome theme={theme}>Helper</HostChrome>);
    expect(document.querySelector(".guuey-chat")).toBeNull();
    const styles = facesFor("Host Empty Face");
    expect(styles).toHaveLength(1);
    expect(styles[0]!.textContent).toContain('src:url("https://fonts.example.test/host-empty.woff2")');
  });

  it("the host's call and a later <Transcript> with the same theme add one set of faces, not two", () => {
    const theme = themeWith({ family: "Host Shared Face", src: "https://fonts.example.test/host-shared.woff2" });
    const { rerender } = render(<HostChrome theme={theme} />);
    expect(facesFor("Host Shared Face")).toHaveLength(1);
    rerender(
      <HostChrome theme={theme}>
        <Transcript plan={oneTurnPlan()} theme={theme} mode="light" {...noopCtx} />
      </HostChrome>,
    );
    expect(document.querySelector(".guuey-chat")).not.toBeNull();
    expect(facesFor("Host Shared Face")).toHaveLength(1);
  });
});
