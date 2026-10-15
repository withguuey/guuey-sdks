// @vitest-environment jsdom
/**
 * guuey#2293 — `<GuueyChat attachments>`: the composer's image affordance.
 * Off by default (an existing host renders and sends exactly what it did);
 * on, a person picks or pastes images, sees each as a preview with its own
 * Remove button, and sends them with or without words. A refused file is
 * named in a status line, and a runtime that does not acknowledge the images
 * reads as its own error, not as a generic failure.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentInvokeAdapters, InvokeRequest } from "@guuey/agent-client";
import { GuueyChat } from "./guuey-chat.js";
import { PARTS } from "./parts.js";
import { defaultChatStrings } from "../strings.js";

afterEach(cleanup);

const PNG_1PX_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function pngFile(name = "page.png"): File {
  return new File([Uint8Array.from(atob(PNG_1PX_BASE64), (c) => c.charCodeAt(0))], name, { type: "image/png" });
}

/** How many images an invoke body carries (the transport's body is untyped JSON). */
function attachmentCount(body: unknown): number {
  if (typeof body !== "object" || body === null || !("attachments" in body)) return 0;
  return Array.isArray(body.attachments) ? body.attachments.length : 0;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A pod that acknowledges every image it is sent, unless `acknowledge` is false. */
function podAdapters(opts: { acknowledge?: boolean } = {}) {
  const calls: InvokeRequest[] = [];
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => null, save: () => undefined },
    generateId: (() => {
      let n = 0;
      return () => `cmid-${n++}`;
    })(),
    transport: async function* (req) {
      calls.push(req);
      const sent = attachmentCount(req.body);
      yield sse("session", {
        threadId: "t-img",
        ...(opts.acknowledge !== false && sent > 0 ? { attachments: { accepted: sent } } : {}),
      });
      yield sse("message", { type: "text.delta", delta: "Here are your flashcards." });
      yield sse("done", { stopReason: "end" });
    },
  };
  return { adapters, calls };
}

/** Renders with `attachments` on, unless `{ prop: "absent" }` leaves the prop off entirely. */
function renderChat(adapters: AgentInvokeAdapters, opts: { prop?: "on" | "absent" } = {}) {
  return render(
    <GuueyChat
      endpointUrl="https://pod.example/agent/invoke"
      adapters={adapters}
      {...(opts.prop === "absent" ? {} : { attachments: true })}
    />,
  );
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("no file input");
  return input;
}

function pick(container: HTMLElement, ...files: File[]): void {
  fireEvent.change(fileInput(container), { target: { files } });
}

describe("<GuueyChat attachments> (guuey#2293)", () => {
  it("is off by default: no attach control, no file input, and the body carries no attachments key", async () => {
    const { adapters, calls } = podAdapters();
    const { container } = renderChat(adapters, { prop: "absent" });
    expect(screen.queryByRole("button", { name: defaultChatStrings.attachImage })).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).not.toHaveProperty("attachments");
  });

  it("on: a labelled attach button opens a file input that accepts exactly the allowlist", () => {
    const { adapters } = podAdapters();
    const { container } = renderChat(adapters);
    const attach = screen.getByRole("button", { name: defaultChatStrings.attachImage });
    expect(attach.getAttribute("part")).toBe(PARTS.composerAttach);
    const input = fileInput(container);
    expect(input.accept).toBe("image/jpeg,image/png,image/gif,image/webp");
    expect(input.multiple).toBe(true);
    let opened = false;
    input.addEventListener("click", () => {
      opened = true;
    });
    fireEvent.click(attach);
    expect(opened).toBe(true);
  });

  it("a picked image shows as a preview with its own Remove button; Remove takes it away", async () => {
    const { adapters } = podAdapters();
    const { container } = renderChat(adapters);
    pick(container, pngFile("page.png"));
    const preview = await screen.findByRole("img", { name: "page.png" });
    expect(preview.getAttribute("src")).toBe(`data:image/png;base64,${PNG_1PX_BASE64}`);
    expect(container.querySelector(`[part~="${PARTS.attachments}"]`)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: defaultChatStrings.removeAttachment("page.png") }));
    expect(screen.queryByRole("img", { name: "page.png" })).toBeNull();
    expect(container.querySelector(`[part~="${PARTS.attachments}"]`)).toBeNull();
  });

  it("sends the image with the typed words, then clears the preview", async () => {
    const { adapters, calls } = podAdapters();
    const { container } = renderChat(adapters);
    pick(container, pngFile());
    await screen.findByRole("img", { name: "page.png" });
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "make flashcards" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({
      input: "make flashcards",
      attachments: [{ kind: "inline", mimeType: "image/png", data: PNG_1PX_BASE64 }],
    });
    expect(screen.queryByRole("img", { name: "page.png" })).toBeNull();
    await waitFor(() => expect(screen.getByText("Here are your flashcards.")).toBeTruthy());
  });

  it("an image with no words can be sent: Send enables, and the input is the kit's neutral line", async () => {
    const { adapters, calls } = podAdapters();
    const { container } = renderChat(adapters);
    const send = screen.getByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    pick(container, pngFile());
    await screen.findByRole("img", { name: "page.png" });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ input: defaultChatStrings.attachmentsOnlyInput });
    expect(attachmentCount(calls[0]?.body)).toBe(1);
  });

  it("a pasted image joins the previews; pasted text is left to the textarea", async () => {
    const { adapters } = podAdapters();
    renderChat(adapters);
    const input = screen.getByLabelText("Message");
    fireEvent.paste(input, { clipboardData: { files: [pngFile("pasted.png")], getData: () => "" } });
    expect(await screen.findByRole("img", { name: "pasted.png" })).toBeTruthy();
  });

  it("a refused file is named in a polite status line and never previewed", async () => {
    const { adapters } = podAdapters();
    const { container } = renderChat(adapters);
    pick(container, new File([new Uint8Array([1, 2])], "memo.webm", { type: "audio/webm" }));
    const status = await screen.findByText(defaultChatStrings.attachmentRefused("memo.webm", "unsupported_type"));
    expect(status.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("a fifth image is refused by the count cap; the first four stay", async () => {
    const { adapters } = podAdapters();
    const { container } = renderChat(adapters);
    pick(container, pngFile("1.png"), pngFile("2.png"), pngFile("3.png"), pngFile("4.png"), pngFile("5.png"));
    await screen.findByText(defaultChatStrings.attachmentRefused("5.png", "too_many"));
    expect(screen.getAllByRole("img")).toHaveLength(4);
  });

  it("a runtime that does not acknowledge the images reads as its own error, not a generic failure", async () => {
    const { adapters, calls } = podAdapters({ acknowledge: false });
    const { container } = renderChat(adapters);
    pick(container, pngFile());
    await screen.findByRole("img", { name: "page.png" });
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "make flashcards" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(await screen.findByText(defaultChatStrings.errorAttachmentsUnsupported)).toBeTruthy();
    expect(screen.queryByText("Here are your flashcards.")).toBeNull();
  });
});
