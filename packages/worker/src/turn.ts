/**
 * The `Turn` handed to a worker handler — the entire surface a builder touches:
 * the pushed context (`input`/`identity`/`fs`/`history`) plus `text()` to stream.
 * Nothing Guuey-specific beyond this.
 */
import type { Fs, HistoryMessage, Identity } from "./protocol.js";
import type { Emitter } from "./emit.js";

export class Turn {
  constructor(
    readonly input: string,
    readonly identity: Identity,
    readonly fs: Fs,
    readonly history: HistoryMessage[],
    private readonly emit: Emitter,
    private readonly onText: (chunk: string) => void
  ) {}

  /** Stream a chunk of assistant output (also accumulated into `done.result`). */
  text(chunk: string): void {
    this.onText(chunk);
    this.emit.text(chunk);
  }
}

/** A worker handler: do the work, return the final result string (or rely on the
 *  accumulated `turn.text(...)`). */
export type WorkerHandler = (turn: Turn) => Promise<string | void> | string | void;
