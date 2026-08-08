/**
 * guuey#127 — the generic locator reader: a host-supplied `resources/read`
 * transport assembled into a `UiResourceReader`. Every trust rule the
 * platform reader established holds here: deny == miss == placeholder, and
 * the sandbox-trust channel derives from the REQUESTED uri, never the
 * response.
 */
import { describe, expect, it, vi } from "vitest";
import { createMcpUiResourceReader, uiResourceChannel } from "./reader.js";

const SHELL = "<html>card</html>";

describe("uiResourceChannel", () => {
  it("routes ui://ggui/ locators to the ggui-CSP page, everything else self-only", () => {
    expect(uiResourceChannel("ui://ggui/render/sess-1/hash-1")).toBe("ggui");
    expect(uiResourceChannel("ui://weather/card-3")).toBe("inline");
    expect(uiResourceChannel("ui://gguiX/imposter")).toBe("inline");
  });
});

describe("createMcpUiResourceReader", () => {
  it("resolves a text entry to an inline mount, passing mimeType through", async () => {
    const read = createMcpUiResourceReader({
      readResource: async () => ({
        uri: "ui://weather/card-3",
        mimeType: "text/html",
        text: SHELL,
      }),
    });
    await expect(read("ui://weather/card-3")).resolves.toEqual({
      channel: "inline",
      resource: { uri: "ui://weather/card-3", mimeType: "text/html", text: SHELL },
    });
  });

  it("channels a ui://ggui/ locator to the ggui-CSP page", async () => {
    const read = createMcpUiResourceReader({
      readResource: async () => ({ uri: "ui://ggui/render/s/h", text: SHELL }),
    });
    await expect(read("ui://ggui/render/s/h")).resolves.toMatchObject({ channel: "ggui" });
  });

  it("derives the channel from the REQUESTED uri, never the response uri", async () => {
    // A server answering an inline locator with a foreign ui://ggui/ uri must
    // not steer its HTML into the ggui-CSP host page.
    const read = createMcpUiResourceReader({
      readResource: async () => ({ uri: "ui://ggui/render/s/h", text: SHELL }),
    });
    await expect(read("ui://weather/card-3")).resolves.toMatchObject({ channel: "inline" });
  });

  it("passes a blob-only entry through (hosts decode via resourceHtml)", async () => {
    const read = createMcpUiResourceReader({
      readResource: async () => ({ uri: "ui://weather/card-3", blob: "PGI+aGk8L2I+" }),
    });
    await expect(read("ui://weather/card-3")).resolves.toEqual({
      channel: "inline",
      resource: { uri: "ui://weather/card-3", blob: "PGI+aGk8L2I+" },
    });
  });

  it("drops extra wire fields from the mounted payload", async () => {
    const entry = { uri: "ui://weather/card-3", text: SHELL, _meta: { ui: {} } };
    const read = createMcpUiResourceReader({ readResource: async () => entry });
    const mount = await read("ui://weather/card-3");
    expect(mount?.resource).toEqual({ uri: "ui://weather/card-3", text: SHELL });
  });

  it("a transport miss is undefined (placeholder), same as a deny", async () => {
    const read = createMcpUiResourceReader({ readResource: async () => undefined });
    await expect(read("ui://weather/card-3")).resolves.toBeUndefined();
  });

  it("a thrown transport error is undefined — never an error surface", async () => {
    const readResource = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const read = createMcpUiResourceReader({ readResource });
    await expect(read("ui://weather/card-3")).resolves.toBeUndefined();
    expect(readResource).toHaveBeenCalledWith("ui://weather/card-3");
  });

  it("re-narrows at runtime: an entry with neither text nor blob is a miss", async () => {
    // Host transports may be plain JS — the annotation is not trusted.
    const read = createMcpUiResourceReader({
      readResource: async () => ({ uri: "ui://weather/card-3" }),
    });
    await expect(read("ui://weather/card-3")).resolves.toBeUndefined();
  });
});
