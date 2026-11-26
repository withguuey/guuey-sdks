// @vitest-environment jsdom
/**
 * `<GuueyChat parts>`: the composer's attach affordance, one switch per part
 * kind. Off by default (an existing host renders and sends exactly what it
 * did); with images on, a person picks or pastes images, sees each as a
 * preview with its own Remove button, and sends them with or without words;
 * with another kind on, a file of that kind is shown by its name and sent as
 * its part. A refused file is named in a status line, and a runtime that does
 * not acknowledge the parts reads as its own error, not as a generic failure.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentInvokeAdapters, InvokeRequest } from "@guuey/agent-client";
import { GuueyChat, type GuueyChatProps } from "./guuey-chat.js";
import { PARTS } from "./parts.js";
import { defaultChatStrings } from "../strings.js";

afterEach(cleanup);

const PNG_1PX_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function pngFile(name = "page.png"): File {
  return new File([Uint8Array.from(atob(PNG_1PX_BASE64), (c) => c.charCodeAt(0))], name, { type: "image/png" });
}

/** The content blocks of a shape-2 body's one message (the transport's body is untyped JSON). */
function contentOf(body: unknown): unknown[] {
  if (typeof body !== "object" || body === null || !("messages" in body) || !Array.isArray(body.messages)) return [];
  const message: unknown = body.messages[0];
  if (typeof message !== "object" || message === null || !("content" in message)) return [];
  return Array.isArray(message.content) ? message.content : [];
}

/** How many parts of each kind a body carries. */
function partCounts(body: unknown): { [kind: string]: number } {
  const counts: { [kind: string]: number } = {};
  for (const block of contentOf(body)) {
    if (typeof block !== "object" || block === null || !("type" in block) || typeof block.type !== "string") continue;
    if (block.type !== "text") counts[block.type] = (counts[block.type] ?? 0) + 1;
  }
  return counts;
}

/** The words a body carries: its text block's text. */
function textOf(body: unknown): string | undefined {
  for (const block of contentOf(body)) {
    if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
      return block.text;
    }
  }
  return undefined;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A pod that acknowledges every part it is sent, unless `acknowledge` is false. */
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
      const sent = partCounts(req.body);
      yield sse("session", {
        threadId: "t-img",
        ...(opts.acknowledge !== false && Object.keys(sent).length > 0 ? { accepts: { parts: sent } } : {}),
      });
      yield sse("message", { type: "text.delta", delta: "Here are your flashcards." });
      yield sse("done", { stopReason: "end" });
    },
  };
  return { adapters, calls };
}

/** Renders with images on, unless `{ prop: "absent" }` leaves the prop off entirely or `parts` names other kinds. */
function renderChat(adapters: AgentInvokeAdapters, opts: { prop?: "on" | "absent"; parts?: GuueyChatProps["parts"] } = {}) {
  return render(
    <GuueyChat
      endpointUrl="https://pod.example/agent/invoke"
      adapters={adapters}
      {...(opts.prop === "absent" ? {} : { parts: opts.parts ?? { image: true } })}
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

describe("<GuueyChat parts>", () => {
  it("is off by default: no attach control, no file input, and the body carries no part", async () => {
    const { adapters, calls } = podAdapters();
    const { container } = renderChat(adapters, { prop: "absent" });
    expect(screen.queryByRole("button", { name: defaultChatStrings.attachImage })).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(partCounts(calls[0]?.body)).toEqual({});
  });

  it("images on: a labelled attach button opens a file input that suggests exactly the image types", () => {
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
    expect(contentOf(calls[0]?.body)).toEqual([
      { type: "text", text: "make flashcards" },
      { type: "image", source: { type: "base64", mediaType: "image/png", data: PNG_1PX_BASE64 } },
    ]);
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
    expect(textOf(calls[0]?.body)).toBe(defaultChatStrings.attachmentsOnlyInput);
    expect(partCounts(calls[0]?.body)).toEqual({ image: 1 });
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

  it("each count cap names its own kind: up to 4 images, only one recording, up to 16 attachments", async () => {
    expect(defaultChatStrings.attachmentRefused("5.png", "too_many")).toMatch(/up to 4 images/);
    expect(defaultChatStrings.recordingRefusedTooMany("b.wav")).toMatch(/only one recording/);
    expect(defaultChatStrings.attachmentRefusedTooManyParts("17.pdf")).toMatch(/up to 16 attachments/);
    const { adapters } = podAdapters();
    const { container } = renderChat(adapters, { parts: { document: true } });
    const docs = Array.from({ length: 17 }, (_, i) => new File(["%PDF-1.4"], `${i + 1}.pdf`, { type: "application/pdf" }));
    pick(container, ...docs);
    await screen.findByText(defaultChatStrings.attachmentRefusedTooManyParts("17.pdf"));
    expect(screen.getByText("16.pdf")).toBeTruthy();
  });

  it("a runtime that does not acknowledge the parts reads as its own error, not a generic failure", async () => {
    const { adapters, calls } = podAdapters({ acknowledge: false });
    const { container } = renderChat(adapters);
    pick(container, pngFile());
    await screen.findByRole("img", { name: "page.png" });
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "make flashcards" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(await screen.findByText(defaultChatStrings.errorPartsUnsupported)).toBeTruthy();
    expect(screen.queryByText("Here are your flashcards.")).toBeNull();
  });

  it("another kind on: the picker suggests its types too, and the attach button reads as a file", () => {
    const { adapters } = podAdapters();
    const { container } = renderChat(adapters, { parts: { image: true, document: true } });
    expect(screen.getByRole("button", { name: defaultChatStrings.attachFile })).toBeTruthy();
    expect(fileInput(container).accept).toBe("image/jpeg,image/png,image/gif,image/webp,application/pdf");
  });

  it("a document is shown by its name and sent as a document part titled with it; no words send the files line", async () => {
    const { adapters, calls } = podAdapters();
    const { container } = renderChat(adapters, { parts: { document: true } });
    pick(container, new File(["%PDF-1.4"], "terms.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("terms.pdf")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(contentOf(calls[0]?.body)).toEqual([
      { type: "text", text: defaultChatStrings.filesOnlyInput },
      { type: "document", source: { type: "base64", mediaType: "application/pdf", data: btoa("%PDF-1.4") }, title: "terms.pdf" },
    ]);
  });

  it("a type off the suggested list is still taken when its kind is on (the runtime judges types)", async () => {
    const { adapters, calls } = podAdapters();
    const { container } = renderChat(adapters, { parts: { audio: true } });
    pick(container, new File([new Uint8Array([1, 2, 3])], "memo.webm", { type: "audio/webm" }));
    expect(await screen.findByText("memo.webm")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(partCounts(calls[0]?.body)).toEqual({ audio: 1 });
  });

  it("a second recording is refused by the count cap", async () => {
    const { adapters } = podAdapters();
    const { container } = renderChat(adapters, { parts: { audio: true } });
    pick(
      container,
      new File([new Uint8Array([1, 2, 3])], "a.wav", { type: "audio/wav" }),
      new File([new Uint8Array([1, 2, 3])], "b.wav", { type: "audio/wav" }),
    );
    // The recording cap names a recording, never the image cap.
    await screen.findByText(defaultChatStrings.recordingRefusedTooMany("b.wav"));
    expect(screen.queryByText(defaultChatStrings.attachmentRefused("b.wav", "too_many"))).toBeNull();
    expect(screen.getByText("a.wav")).toBeTruthy();
  });
});
