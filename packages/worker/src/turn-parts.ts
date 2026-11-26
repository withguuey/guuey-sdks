/**
 * The turn's message parts other than text and images (`Invoke.parts`: audio, file, document), and the ONE delivery
 * rule for them (design v7 D1): a part the worker's framework takes natively is passed as that framework's own block;
 * every other part is stored as a file in the turn's session storage, under the same rules as turn images
 * (turn-images-store.ts), and the user turn carries ONE framed `<message_files>` note naming each file's path, media
 * type and size. Nothing is dropped.
 *
 * Pure: the planner and the note never touch the disk, and a stored file's name comes only from its bytes and its media
 * type (`attachments/<sha256>.<ext>`), so the store and the note always name the same file.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isStandardBase64 } from "./images.js";
import type { Invoke, InvokePart, InvokePartType, JsonValue, PartState } from "./protocol.js";
import { INVOKE_PART_TYPES, PARTS_CAPABILITY, TURN_PART_MAX_BYTES, TURN_PARTS_MAX, partCapability } from "./protocol.js";
import { MESSAGE_FILES_TAG, escapeContextData } from "./turn-context.js";
import { TURN_IMAGES_DIR, TurnImagesError, writeTurnFile, type TurnImagesProblem } from "./turn-images-store.js";

/**
 * The model APIs a content helper builds for, each with its own native set (by source at the pinned SDKs):
 * - `claude`: none beyond images. The Anthropic API has no audio block, and a document block is not something the
 *   worker's stored-session measure reads (cli-session-hash.ts accepts text and image only), so a native document
 *   would break a resume; documents go as files, which Claude's Read tool opens.
 * - `openai-responses` (the Agents SDK's default API): file and document as `input_file`.
 * - `openai-chat-completions` (a builder's opt-in model): file and document as `input_file`, plus audio as
 *   `input_audio` for wav and mp3 only.
 * - `gemini` (Google ADK): audio, and PDF or text documents and files, as `inlineData`.
 */
export type PartsTarget = "claude" | "openai-responses" | "openai-chat-completions" | "gemini";

const OPENAI_AUDIO: readonly string[] = ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"];
const isPdfOrText = (base: string): boolean => base === "application/pdf" || base.startsWith("text/");

/**
 * A media type the worker accepts: `type/subtype`, optionally `; key=value` parameters, each part an RFC 6838 token,
 * at most {@link MEDIA_TYPE_MAX} characters. Nothing else (no space but after `;`, no newline, no quote), so a media type
 * can never forge a line of the files note or break out of a `data:` URL.
 */
const TOKEN = "[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}";
const MEDIA_TYPE = new RegExp(`^${TOKEN}/${TOKEN}(?:; ?${TOKEN}=${TOKEN})*$`);
export const MEDIA_TYPE_MAX = 255;
/** Whether `mediaType` is one the worker accepts ({@link MEDIA_TYPE}). */
export function isMediaType(mediaType: string): boolean {
  return mediaType.length <= MEDIA_TYPE_MAX && MEDIA_TYPE.test(mediaType);
}
/** The `type/subtype` of a media type, lowercased, without its parameters. */
export function baseMediaType(mediaType: string): string {
  return (mediaType.split(";")[0] ?? "").trim().toLowerCase();
}

/** Whether `target` takes `part` as its own block. Everything else is delivered as a file. */
export function isNativePart(part: InvokePart, target: PartsTarget): boolean {
  const base = baseMediaType(part.source.mediaType);
  switch (target) {
    case "claude":
      return false;
    case "openai-responses":
      // `input_file` takes PDF and text; other file types are delivered as files.
      return part.type !== "audio" && isPdfOrText(base);
    case "openai-chat-completions":
      return part.type === "audio" ? OPENAI_AUDIO.includes(base) : isPdfOrText(base);
    case "gemini":
      return part.type === "audio" ? base.startsWith("audio/") : isPdfOrText(base);
  }
}

/**
 * The types a model can open as a stored FILE with a file tool: what the pinned Claude CLI's Read tool reads (PDF and
 * text; it refuses audio and other binary files: "This tool cannot read binary files", pinned by
 * claude-cli.integration.test.ts). The one reader measured; a worker without file tools opens none.
 */
const isReadableAsFile = (base: string): boolean =>
  base === "application/pdf" || base.startsWith("text/") || base === "application/json";

/**
 * How `part` reaches the model for `target` ({@link PartState}): natively; or as a stored file it can open (`fileTools`
 * and a readable type); or as a stored file it cannot open (`file-unreadable`, the note says so).
 */
export function partStateOf(part: InvokePart, target: PartsTarget, fileTools: boolean): PartState {
  if (isNativePart(part, target)) return "native";
  return fileTools && isReadableAsFile(baseMediaType(part.source.mediaType)) ? "file" : "file-unreadable";
}

/**
 * The fixed extension map: the stored file's extension comes from its media type alone, and anything not listed is
 * `bin`. A person's filename never reaches the path.
 */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "application/json": "json",
};
/** The extension of a stored part: from the fixed map (own entries only), else `bin`. */
export function partExtension(mediaType: string): string {
  const base = baseMediaType(mediaType);
  return Object.hasOwn(EXTENSIONS, base) ? (EXTENSIONS[base] ?? "bin") : "bin";
}

/**
 * A part delivered as a file: its path (absolute, inside the session storage), media type, size in bytes, and whether
 * the model can open it this turn.
 */
export interface DeliveredFile {
  path: string;
  mediaType: string;
  bytes: number;
  readable: boolean;
}

/**
 * A turn's parts split by the one rule: the parts its framework takes natively, the files the rest become, and each
 * part's {@link PartState} in the order sent (the hello's `parts`).
 */
export interface TurnPartsDelivery {
  native: InvokePart[];
  files: DeliveredFile[];
  states: PartState[];
}

/** The decoded bytes of a part and the name it is stored under, relative to the session storage. */
export function storedPartOf(part: InvokePart): { bytes: Buffer; name: string } {
  const bytes = Buffer.from(part.source.data, "base64");
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { bytes, name: `${TURN_IMAGES_DIR}/${hash}.${partExtension(part.source.mediaType)}` };
}

/** The turn's parts split for `target`, in the order sent. Pure: it names the files {@link storeTurnParts} writes. */
export function turnPartsDelivery(
  turn: Pick<Invoke, "parts" | "fs">,
  target: PartsTarget,
  fileTools: boolean,
): TurnPartsDelivery {
  const native: InvokePart[] = [];
  const files: DeliveredFile[] = [];
  const states: PartState[] = [];
  for (const part of turn.parts ?? []) {
    const state = partStateOf(part, target, fileTools);
    states.push(state);
    if (state === "native") {
      native.push(part);
      continue;
    }
    const { bytes, name } = storedPartOf(part);
    files.push({
      path: join(turn.fs.session, name),
      mediaType: part.source.mediaType,
      bytes: bytes.length,
      readable: state === "file",
    });
  }
  return { native, files, states };
}

/** The constant first line inside every `<message_files>` note. Never varies. */
export const MESSAGE_FILES_LEAD =
  "Files the person attached to this message, saved for this conversation. Open them with your file tools.";
/** What the note says after a file the model cannot open this turn. Never varies. */
export const MESSAGE_FILE_UNREADABLE =
  "attached, but you cannot open this type of file here; tell the person";

/** The ONE `<message_files>` note for the delivered files, or `undefined` when there are none. */
export function frameTurnFiles(files: readonly DeliveredFile[]): string | undefined {
  if (files.length === 0) return undefined;
  // Escaped as ONE string after the join, so no tag can be split across two lines.
  const line = (f: DeliveredFile) =>
    `- ${f.path} (${f.mediaType}, ${String(f.bytes)} bytes)${f.readable ? "" : `: ${MESSAGE_FILE_UNREADABLE}`}`;
  const body = escapeContextData(files.map(line).join("\n"));
  return `<${MESSAGE_FILES_TAG}>\n${MESSAGE_FILES_LEAD}\n${body}\n</${MESSAGE_FILES_TAG}>`;
}

/**
 * The hello capabilities of a worker that delivers this invoke's parts for `target`: {@link PARTS_CAPABILITY} and one
 * `invoke.<kind>.v1` per kind it took natively. Nothing on an invoke without parts, so such a hello is unchanged. The
 * per-part truth rides the hello's `parts` ({@link turnPartsDelivery}'s `states`).
 */
export function invokePartsCapabilities(turn: Pick<Invoke, "parts" | "fs">, target: PartsTarget): string[] {
  if ((turn.parts ?? []).length === 0) return [];
  const kinds = new Set((turn.parts ?? []).filter((p) => isNativePart(p, target)).map((p) => p.type));
  return [PARTS_CAPABILITY, ...INVOKE_PART_TYPES.filter((t) => kinds.has(t)).map(partCapability)];
}

/** The hello's per-part states for this invoke ({@link TurnPartsDelivery.states}), or `undefined` without parts. */
export function invokePartStates(
  turn: Pick<Invoke, "parts" | "fs">,
  target: PartsTarget,
  fileTools: boolean,
): PartState[] | undefined {
  return (turn.parts ?? []).length === 0 ? undefined : turnPartsDelivery(turn, target, fileTools).states;
}

const isObject = (v: JsonValue | undefined): v is { [key: string]: JsonValue } =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isPartType = (t: JsonValue | undefined): t is InvokePartType =>
  typeof t === "string" && (INVOKE_PART_TYPES as readonly string[]).includes(t);

/**
 * The turn's parts as the wire carries them: all well formed, or none (the `attachments` rule; a Router sends only
 * parts it judged). Each part is `{type: audio|file|document, source: {type: "base64", mediaType, data}}` with
 * `filename?` (file) or `title?` (document); other fields are dropped. At most {@link TURN_PARTS_MAX} parts, each at
 * most {@link TURN_PART_MAX_BYTES} decoded.
 */
export function parseInvokeParts(v: JsonValue | undefined): InvokePart[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > TURN_PARTS_MAX) return undefined;
  const out: InvokePart[] = [];
  for (const entry of v) {
    if (!isObject(entry) || !isPartType(entry.type) || !isObject(entry.source)) return undefined;
    const { type: sourceType, mediaType, data } = entry.source;
    if (sourceType !== "base64" || typeof mediaType !== "string" || !isMediaType(mediaType)) return undefined;
    if (typeof data !== "string" || !isStandardBase64(data)) return undefined;
    if ((data.length / 4) * 3 > TURN_PART_MAX_BYTES + 2) return undefined;
    const source = { type: "base64" as const, mediaType, data };
    if (entry.type === "file") {
      out.push({ type: "file", source, ...(typeof entry.filename === "string" ? { filename: entry.filename } : {}) });
    } else if (entry.type === "document") {
      out.push({ type: "document", source, ...(typeof entry.title === "string" ? { title: entry.title } : {}) });
    } else {
      out.push({ type: "audio", source });
    }
  }
  return out;
}

/** What the person sees when a part cannot be stored, per {@link TurnImagesProblem}. */
export const TURN_PARTS_FACES: Readonly<Record<TurnImagesProblem, string>> = {
  too_many: "This message has more attachments than this agent accepts at once. Send fewer and try again.",
  too_large: "This attachment is larger than this agent accepts. Send a smaller one.",
  not_a_directory: "This attachment could not be stored for this conversation.",
  no_space: "There is no room left to store this attachment in this conversation.",
  write_failed: "This attachment could not be stored for this conversation.",
};

/**
 * Store, in the turn's session storage, every part `target` does not take natively, under the names
 * {@link turnPartsDelivery} gives them. Throws {@link TurnImagesError} on a refusal.
 */
export function saveTurnParts(turn: Pick<Invoke, "parts" | "fs">, target: PartsTarget): void {
  // Every non-native part is written, readable or not: one delivery path, erased with the thread's folder.
  const parts = (turn.parts ?? []).filter((part) => !isNativePart(part, target));
  if (parts.length > TURN_PARTS_MAX) {
    throw new TurnImagesError("too_many", `${String(parts.length)} parts, at most ${String(TURN_PARTS_MAX)}`);
  }
  const stored = parts.map(storedPartOf);
  for (const { bytes } of stored) {
    if (bytes.length > TURN_PART_MAX_BYTES) {
      throw new TurnImagesError("too_large", `${String(bytes.length)} bytes, at most ${String(TURN_PART_MAX_BYTES)}`);
    }
  }
  for (const { bytes, name } of stored) writeTurnFile(turn.fs.session, name, bytes);
}

/**
 * {@link saveTurnParts} for a turn runner: `undefined` when every non-native part is stored (or there is none), else
 * the face the person sees; the runner ends the turn with that face instead of running it.
 */
export function storeTurnParts(turn: Pick<Invoke, "parts" | "fs">, target: PartsTarget): string | undefined {
  try {
    saveTurnParts(turn, target);
    return undefined;
  } catch (err) {
    if (err instanceof TurnImagesError) {
      process.stderr.write(`[guuey] turn parts not stored: ${err.problem} (${err.message})\n`);
      return TURN_PARTS_FACES[err.problem];
    }
    throw err;
  }
}
