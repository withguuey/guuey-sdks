/**
 * The private launch envelope (guuey#2139): the one channel a platform-launched
 * worker receives its scoped capabilities on. A secret is never in a process's
 * argv or initial environment: the launcher writes ONE JSON line to a
 * descriptor (fd {@link LAUNCH_ENVELOPE_FD}) and ends it, and the worker reads it
 * once at boot, closes the descriptor and keeps the payload in memory only.
 *
 * Only the descriptor NUMBER rides the environment, as
 * {@link LAUNCH_ENVELOPE_FD_ENV}; it is not a secret.
 *
 * Fail closed: a marker naming another descriptor, a descriptor that is not a
 * socket or FIFO, a payload that is empty, oversized, truncated or not exactly
 * the versioned shape, or no EOF within the deadline is an error, and the error
 * text never carries payload bytes. With the marker absent the worker runs
 * without an envelope.
 *
 * Not checked, and replaced by nothing: what sits at the envelope's number
 * when the marker is absent. A plain "fd 5 is not open" check does not work,
 * because a Node process opens its own internal descriptors at the low
 * numbers (fds 3 to 10 on a bare `node` start; on macOS, Node 25.6.1, they
 * measured as FIFOs and kqueue descriptors, none a socket), and Node exposes
 * no close-on-exec flag. A narrower variant is feasible and NOT adopted here:
 * refuse when the marker is absent and fd 5 is a SOCKET, since an inherited
 * envelope is a socketpair end and Node's own startup descriptors are not
 * sockets. It needs a Linux test first (Linux kinds are unmeasured)
 * (guuey#2139).
 */
import { closeSync, fstatSync } from "node:fs";
import { Socket } from "node:net";

/** Environment name carrying the envelope's descriptor number. Not a secret. */
export const LAUNCH_ENVELOPE_FD_ENV = "GUUEY_LAUNCH_ENVELOPE_FD";
/** The descriptor the envelope rides: 0-2 stdio, 3 events, 4 bwrap options. */
export const LAUNCH_ENVELOPE_FD = 5;
/** The envelope format this package reads and writes. */
export const LAUNCH_ENVELOPE_VERSION = 1;
/** Upper bound on the encoded envelope, newline included. */
export const LAUNCH_ENVELOPE_MAX_BYTES = 16 * 1024;
/** How long a worker waits for the launcher to finish writing. */
export const LAUNCH_ENVELOPE_DEADLINE_MS = 10_000;

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

/** Encode an envelope as the one line a launcher writes, after validating it. */
export function encodeLaunchEnvelope(envelope: LaunchEnvelope): Buffer {
  const line = `${JSON.stringify(envelope)}\n`;
  // Round-trip through the strict parser so a launcher can never emit a shape
  // its reader refuses.
  parseLaunchEnvelope(line);
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length > LAUNCH_ENVELOPE_MAX_BYTES) throw new LaunchEnvelopeError("payload exceeds the size limit");
  return bytes;
}

/** Whether `fd` is open in this process (fstat succeeds). Errors other than EBADF throw. */
function isOpen(fd: number): boolean {
  try {
    fstatSync(fd);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EBADF") return false;
    throw error;
  }
}

export interface ReadLaunchEnvelopeOptions {
  /** Environment holding the marker. The marker is deleted from it after a read. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
  deadlineMs?: number;
}

/**
 * Read the launch envelope once, then close its descriptor.
 *
 * Returns `undefined` only when the marker is absent. Otherwise resolves only
 * after the descriptor is closed and `fstat` on it reports EBADF, so nothing
 * spawned afterwards can inherit it. Never logs or returns payload bytes in an
 * error.
 */
export async function readLaunchEnvelope(options: ReadLaunchEnvelopeOptions = {}): Promise<LaunchEnvelope | undefined> {
  const env = options.env ?? process.env;
  const maxBytes = options.maxBytes ?? LAUNCH_ENVELOPE_MAX_BYTES;
  const deadlineMs = options.deadlineMs ?? LAUNCH_ENVELOPE_DEADLINE_MS;
  const marker = env[LAUNCH_ENVELOPE_FD_ENV];
  if (marker === undefined) return undefined;
  if (marker !== String(LAUNCH_ENVELOPE_FD)) {
    throw new LaunchEnvelopeError(`${LAUNCH_ENVELOPE_FD_ENV} must name fd ${String(LAUNCH_ENVELOPE_FD)}`);
  }
  let kind: "socket" | "fifo" | "other";
  try {
    const stat = fstatSync(LAUNCH_ENVELOPE_FD);
    kind = stat.isSocket() ? "socket" : stat.isFIFO() ? "fifo" : "other";
  } catch {
    throw new LaunchEnvelopeError(`fd ${String(LAUNCH_ENVELOPE_FD)} is not open`);
  }
  if (kind === "other") {
    closeSync(LAUNCH_ENVELOPE_FD);
    throw new LaunchEnvelopeError(`fd ${String(LAUNCH_ENVELOPE_FD)} is not a socket or FIFO`);
  }
  const text = await readToEnd(maxBytes, deadlineMs);
  delete env[LAUNCH_ENVELOPE_FD_ENV];
  if (isOpen(LAUNCH_ENVELOPE_FD)) {
    throw new LaunchEnvelopeError(`fd ${String(LAUNCH_ENVELOPE_FD)} is still open after the read`);
  }
  return parseLaunchEnvelope(text);
}

/**
 * Read the envelope descriptor to EOF within the byte cap and deadline, and
 * resolve only once the descriptor is closed (the socket's `close` event: libuv
 * has closed the fd by then). Every failure path closes it as well.
 */
function readToEnd(maxBytes: number, deadlineMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = new Socket({ fd: LAUNCH_ENVELOPE_FD, readable: true, writable: false, allowHalfOpen: true });
    const chunks: Buffer[] = [];
    let total = 0;
    let failure: LaunchEnvelopeError | undefined;
    let ended = false;
    const fail = (reason: string): void => {
      if (failure !== undefined || ended) return;
      failure = new LaunchEnvelopeError(reason);
      socket.destroy();
    };
    const deadline = setTimeout(() => fail(`no EOF within ${String(deadlineMs)} ms`), deadlineMs);
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        fail("payload exceeds the size limit");
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      if (failure !== undefined) return;
      ended = true;
      socket.destroy();
    });
    socket.on("error", () => fail("descriptor read failed"));
    socket.once("close", () => {
      clearTimeout(deadline);
      if (failure !== undefined) reject(failure);
      else if (!ended) reject(new LaunchEnvelopeError("descriptor closed before EOF"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
