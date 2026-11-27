/**
 * guuey#2293 (F2): the turn's images as each model provider's content parts:
 * ONE converter that the no-code host and every code-mode worker share, so a
 * builder's own worker hands images to its model with one call. Pure and
 * dependency-free: the parts are written structurally, so each SDK's own type
 * accepts them without this package importing any SDK.
 *
 * Every converter keeps ONE order: the images in the order the person sent
 * them, then the session context and the turn context the invoke carries (each
 * one framed block, turn-context.ts), then the turn's own text LAST: `text` when
 * given (a worker that folds history into the text passes its own), else the
 * turn's model text (`modelInputOf`), with the two context tags escaped in it.
 * Without images or context each returns exactly the text-only shape the turn
 * always sent.
 */
import { modelInputOf } from "./model-text.js";
import type { InlineMediaPart, Invoke, InvokeImageMimeType } from "./protocol.js";
import { contextFramesOf, escapeOwnText } from "./turn-context.js";
import { frameTurnFiles, turnPartsDelivery, type PartsTarget } from "./turn-parts.js";

/** The fields of an invoke a converter reads. `fs` is needed only when the turn carries parts (it names their files). */
export type ImageTurn = Pick<Invoke, "input" | "inputKind" | "attachments" | "turnContext" | "sessionContext"> & {
  parts?: Invoke["parts"];
  fs?: Invoke["fs"];
};

/**
 * How a content helper delivers the turn's parts: `fileTools` says whether the model can open a stored file this turn
 * (a Read-class tool), which decides each non-native file's line in the note. It must match the worker's serveNative
 * `parts.fileTools`, the hello's word for the same turn.
 */
export interface PartsOptions {
  fileTools?: boolean;
}

/** The turn's parts for `target`: the native ones, and the ONE `<message_files>` note for the rest (if any). */
function partsFor(turn: ImageTurn, target: PartsTarget, fileTools: boolean): { native: InlineMediaPart[]; note: string | undefined } {
  if ((turn.parts ?? []).length === 0) return { native: [], note: undefined };
  if (turn.fs === undefined) throw new TypeError("a turn with parts needs its fs: the stored files are named under fs.session");
  const { native, lines } = turnPartsDelivery({ parts: turn.parts, fs: turn.fs }, target, fileTools);
  return { native, note: frameTurnFiles(lines) };
}

/** One Anthropic Messages content block of a user turn: an image, or text. */
export type AnthropicUserBlock =
  | { type: "image"; source: { type: "base64"; media_type: InvokeImageMimeType; data: string } }
  | { type: "text"; text: string };

/**
 * Claude (Anthropic Messages, the Claude Agent SDK): an image block per image, the files note (Claude takes no part
 * natively: every part is a file), a text block per context frame, then the text block.
 */
export function anthropicUserContent(
  turn: ImageTurn,
  text: string = modelInputOf(turn),
  options: PartsOptions = {},
): AnthropicUserBlock[] {
  const { note } = partsFor(turn, "claude", options.fileTools === true);
  return [
    ...(turn.attachments ?? []).map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mimeType, data: image.data },
    })),
    ...(note === undefined ? [] : [{ type: "text" as const, text: note }]),
    ...contextFramesOf(turn).map((frame) => ({ type: "text" as const, text: frame })),
    { type: "text" as const, text: escapeOwnText(text) },
  ];
}

/**
 * One OpenAI user-message content part: an image (a base64 `data:` URL), a file (a base64 `data:` URL, with its
 * filename when the person gave one), audio (Chat Completions only: base64, wav or mp3), or text.
 */
export type OpenAiUserPart =
  | { type: "input_image"; image: string }
  | { type: "input_file"; file: string; filename?: string }
  | { type: "audio"; audio: string; format: "wav" | "mp3" }
  | { type: "input_text"; text: string };

/** How {@link openaiTurnInput} builds: for the Agents SDK's default Responses API, or for a Chat Completions model. */
export interface OpenAiTurnOptions extends PartsOptions {
  /** The worker runs a Chat Completions model, which also takes wav and mp3 audio natively. */
  chatCompletions?: boolean;
}

function openaiNative(part: InlineMediaPart): OpenAiUserPart {
  const { mediaType, data } = part.source;
  if (part.type === "audio") return { type: "audio", audio: data, format: /wav/i.test(mediaType) ? "wav" : "mp3" };
  const filename = part.type === "file" ? part.filename : part.title;
  return { type: "input_file", file: `data:${mediaType};base64,${data}`, ...(filename ? { filename } : {}) };
}

/**
 * OpenAI (the Agents SDK's `run` input): the model text when the turn carries
 * no images, parts or context, as it always was; otherwise one user message
 * whose content is an `input_image` per image, the native parts, the files
 * note, an `input_text` per context frame, then the text.
 */
export function openaiTurnInput(
  turn: ImageTurn,
  text: string = modelInputOf(turn),
  options: OpenAiTurnOptions = {},
): string | Array<{ role: "user"; content: OpenAiUserPart[] }> {
  const images = turn.attachments ?? [];
  const { native, note } = partsFor(
    turn,
    options.chatCompletions === true ? "openai-chat-completions" : "openai-responses",
    options.fileTools === true,
  );
  const frames = contextFramesOf(turn);
  const own = escapeOwnText(text);
  if (images.length === 0 && native.length === 0 && note === undefined && frames.length === 0) return own;
  return [
    {
      role: "user",
      content: [
        ...images.map((image) => ({ type: "input_image" as const, image: `data:${image.mimeType};base64,${image.data}` })),
        ...native.map(openaiNative),
        ...(note === undefined ? [] : [{ type: "input_text" as const, text: note }]),
        ...frames.map((frame) => ({ type: "input_text" as const, text: frame })),
        { type: "input_text" as const, text: own },
      ],
    },
  ];
}

/** One Gemini part (`@google/genai` `Part`): text, or inline data (an image or a native part). */
export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

/**
 * Gemini (Google ADK, `@google/genai`): an `inlineData` part per image and per native part, the files note, a text
 * part per context frame, then the text part.
 */
export function geminiUserParts(
  turn: ImageTurn,
  text: string = modelInputOf(turn),
  options: PartsOptions = {},
): GeminiPart[] {
  const { native, note } = partsFor(turn, "gemini", options.fileTools === true);
  return [
    ...(turn.attachments ?? []).map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })),
    ...native.map((part) => ({ inlineData: { mimeType: part.source.mediaType, data: part.source.data } })),
    ...(note === undefined ? [] : [{ text: note }]),
    ...contextFramesOf(turn).map((frame) => ({ text: frame })),
    { text: escapeOwnText(text) },
  ];
}
