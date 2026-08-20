/**
 * guuey#127 — the generic locator reader: a host-supplied `resources/read`
 * transport assembled into a `UiResourceReader`. Every trust rule the
 * platform reader established holds here: deny == miss == placeholder, and
 * the sandbox-trust channel derives from the REQUESTED uri, never the
 * response.
 */
import { describe, expect, it, vi } from "vitest";
import { createMcpUiResourceReader, declaredResourceCsp, uiResourceChannel } from "./reader.js";

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

// ─── Per-resource declared CSP (guuey#312 — the phase-2 growth) ────────────
//
// CAPTURE-DERIVED fixture — real wire bytes from a ggui dev read
// (2026-08-20, pod ggui-protocol-0a6d38e19b46: fresh trier app →
// weekly-availability render → raw MCP client `resources/read`, trier torn
// down after). Load-bearing placement the capture pins: the block rides
// `contents[0]._meta.ui.csp` — result-level `_meta` is ABSENT on the wire,
// so a transport MUST hand over the CONTENTS ENTRY (this module's
// documented contract). The shell HTML is deliberately not reproduced here
// (it inlines a render envelope); SHELL stands in — the csp door never
// reads the body. This render was gadget-less, so csp == template baseline
// (a gadget-augmented variant would union extra origins in).
describe("declaredResourceCsp (guuey#312)", () => {
  const CAPTURED_URI = "ui://ggui/render/render_f619920f-bd61-4f70-9f09-64d6f69c0b5b/44136fa355b3678a";
  const CAPTURED_META = {
    ui: {
      csp: {
        connectDomains: [
          "https://assets.dev.mcp.sandbox.ggui.ai",
          "wss://assets.dev.mcp.sandbox.ggui.ai",
          "wss://dev.mcp.sandbox.ggui.ai",
          "https://dev.mcp.sandbox.ggui.ai",
        ],
        resourceDomains: ["https://assets.dev.mcp.sandbox.ggui.ai"],
      },
    },
  };

  it("rides the resolved mount when the read result declares it (real ggui wire shape)", async () => {
    const read = createMcpUiResourceReader({
      readResource: async () => ({
        uri: CAPTURED_URI,
        mimeType: "text/html;profile=mcp-app",
        text: SHELL,
        _meta: CAPTURED_META,
      }),
    });
    await expect(read(CAPTURED_URI)).resolves.toEqual({
      channel: "ggui",
      resource: { uri: CAPTURED_URI, mimeType: "text/html;profile=mcp-app", text: SHELL },
      csp: {
        connectDomains: [
          "https://assets.dev.mcp.sandbox.ggui.ai",
          "wss://assets.dev.mcp.sandbox.ggui.ai",
          "wss://dev.mcp.sandbox.ggui.ai",
          "https://dev.mcp.sandbox.ggui.ai",
        ],
        resourceDomains: ["https://assets.dev.mcp.sandbox.ggui.ai"],
      },
    });
  });

  it("all four spec domain arrays survive the schema door", () => {
    const csp = declaredResourceCsp({
      uri: "ui://a",
      text: SHELL,
      _meta: {
        ui: {
          csp: {
            connectDomains: ["https://api.example"],
            resourceDomains: ["https://cdn.example"],
            frameDomains: ["https://player.example"],
            baseUriDomains: ["https://base.example"],
          },
        },
      },
    });
    expect(csp).toEqual({
      connectDomains: ["https://api.example"],
      resourceDomains: ["https://cdn.example"],
      frameDomains: ["https://player.example"],
      baseUriDomains: ["https://base.example"],
    });
  });

  it("absent _meta / absent ui / absent csp → undefined (undeclared, never fabricated)", () => {
    expect(declaredResourceCsp({ uri: "ui://a", text: SHELL })).toBeUndefined();
    expect(declaredResourceCsp({ uri: "ui://a", text: SHELL, _meta: {} })).toBeUndefined();
    expect(declaredResourceCsp({ uri: "ui://a", text: SHELL, _meta: { ui: {} } })).toBeUndefined();
  });

  it("malformed declarations collapse to undefined — a bad declaration widens nothing", () => {
    // Not an object at each level of the walk.
    expect(declaredResourceCsp({ uri: "ui://a", text: SHELL, _meta: "nope" })).toBeUndefined();
    expect(
      declaredResourceCsp({ uri: "ui://a", text: SHELL, _meta: { ui: "nope" } }),
    ).toBeUndefined();
    // csp present but spec-invalid (numbers where the schema wants strings).
    expect(
      declaredResourceCsp({
        uri: "ui://a",
        text: SHELL,
        _meta: { ui: { csp: { connectDomains: [42] } } },
      }),
    ).toBeUndefined();
    expect(
      declaredResourceCsp({ uri: "ui://a", text: SHELL, _meta: { ui: { csp: "nope" } } }),
    ).toBeUndefined();
  });

  it("a malformed declaration does NOT sink the mount — the resource still resolves, undeclared", async () => {
    const read = createMcpUiResourceReader({
      readResource: async () => ({
        uri: "ui://weather/card-3",
        text: SHELL,
        _meta: { ui: { csp: { connectDomains: [42] } } },
      }),
    });
    await expect(read("ui://weather/card-3")).resolves.toEqual({
      channel: "inline",
      resource: { uri: "ui://weather/card-3", text: SHELL },
    });
  });
});
