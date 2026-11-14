/**
 * FROZEN test fixture: `parseLaunchEnvelope` exactly as `../launch-envelope.ts` stood at the @guuey/* 0.35.0 cut (main
 * 38d3a7e4ee35; the file is unchanged there since be246a99f9), before the parked Claude spare took the platform's
 * thread token (guuey#3456). It stands in for an OLDER host, which reads the envelope with this parser, so do not edit
 * it to follow `../launch-envelope.ts`; a later envelope change gets a new frozen copy beside this one. Only the
 * descriptor reader is left out: it is not the parser, and a fixture opens no descriptor.
 *
 * Also pinned here: an envelope line of that release's shape, a per-turn model token (the Router before guuey#3456).
 */

/** The envelope format the 0.35.0 release reads and writes. */
export const LAUNCH_ENVELOPE_VERSION = 1;

/** The model wires a scoped model capability can authenticate to. */
export type LaunchWire = "anthropic" | "openai" | "gemini";
const LAUNCH_WIRES: readonly LaunchWire[] = ["anthropic", "openai", "gemini"];

/** The scoped model capability for one execution. */
export interface LaunchModelCapability {
  wire: LaunchWire;
  token: string;
}

/** Version 1 of the private launch envelope. */
export interface LaunchEnvelope {
  v: typeof LAUNCH_ENVELOPE_VERSION;
  model?: LaunchModelCapability;
}

/** A refused or failed envelope read. Its message never contains payload bytes. */
export class LaunchEnvelopeError extends Error {
  constructor(reason: string) {
    super(`launch envelope refused: ${reason}`);
    this.name = "LaunchEnvelopeError";
  }
}

const TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLaunchWire(value: unknown): value is LaunchWire {
  return typeof value === "string" && LAUNCH_WIRES.some((wire) => wire === value);
}

/**
 * Parse one encoded envelope strictly: exactly one JSON object, an optional
 * single trailing newline, version 1, no unknown member at either level.
 */
export function parseLaunchEnvelope(text: string): LaunchEnvelope {
  if (text.length === 0) throw new LaunchEnvelopeError("empty payload");
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (body.length === 0 || body.includes("\n")) throw new LaunchEnvelopeError("payload is not exactly one line");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new LaunchEnvelopeError("payload is not complete JSON");
  }
  if (!isRecord(parsed)) throw new LaunchEnvelopeError("payload is not an object");
  for (const key of Object.keys(parsed)) {
    if (key !== "v" && key !== "model") throw new LaunchEnvelopeError("payload has an unknown member");
  }
  if (parsed.v !== LAUNCH_ENVELOPE_VERSION) throw new LaunchEnvelopeError("unsupported envelope version");
  if (parsed.model === undefined) return { v: LAUNCH_ENVELOPE_VERSION };
  const model = parsed.model;
  if (!isRecord(model)) throw new LaunchEnvelopeError("model is not an object");
  for (const key of Object.keys(model)) {
    if (key !== "wire" && key !== "token") throw new LaunchEnvelopeError("model has an unknown member");
  }
  if (!isLaunchWire(model.wire)) throw new LaunchEnvelopeError("model wire is not supported");
  if (typeof model.token !== "string" || !TOKEN_PATTERN.test(model.token)) {
    throw new LaunchEnvelopeError("model token is malformed");
  }
  return { v: LAUNCH_ENVELOPE_VERSION, model: { wire: model.wire, token: model.token } };
}

/** An envelope line of the 0.35.0 release's shape: the Router's per-turn model token (visibly fake). */
export const PREV_RELEASE_ENVELOPE_LINE = `${JSON.stringify({ v: 1, model: { wire: "anthropic", token: "turn-scoped-test" } })}\n`;
