/**
 * The one way a worker sends a {@link SuspendEvent} on fd 3. It is separate
 * from the public {@link Emitter} on purpose: a `suspend` on an invoke that did
 * not offer one fails the turn on an older Router, so the writer exists only
 * for an invoke that carried {@link Invoke.suspend}, and enforces the offer's
 * size cap on every write.
 */
import type { WriteSink } from "./emit.js";
import { SUSPEND_ENVELOPE_MAX_BYTES, type Invoke, type SuspendEvent } from "./protocol.js";

/** `written`: the event is on the sink. `over_cap`: the envelope is too large, and nothing was written. */
export type SuspendWriteResult = "written" | "over_cap";

export interface SuspendWriter {
  /** The effective cap: the smaller of the offer's `maxEnvelopeBytes` and {@link SUSPEND_ENVELOPE_MAX_BYTES}. */
  readonly maxEnvelopeBytes: number;
  /**
   * Write one `suspend` event, unless the envelope's JSON-string form
   * (`JSON.stringify(envelope)`, in UTF-8 bytes) is larger than
   * {@link maxEnvelopeBytes}. Call it after the invoke's natives and before
   * its terminal event.
   */
  suspend(envelope: string, askIds: readonly string[]): SuspendWriteResult;
}

/**
 * A {@link SuspendWriter} for this invoke, or `undefined` when the invoke
 * carried no `suspend` offer. That `undefined` is the whole gate toward an
 * older Router: without an offer, nothing can reach the sink.
 */
export function createSuspendWriter(out: WriteSink, invoke: Invoke): SuspendWriter | undefined {
  const offer = invoke.suspend;
  if (offer === undefined) return undefined;
  const maxEnvelopeBytes = Math.min(offer.maxEnvelopeBytes, SUSPEND_ENVELOPE_MAX_BYTES);
  return {
    maxEnvelopeBytes,
    suspend: (envelope, askIds) => {
      if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > maxEnvelopeBytes) return "over_cap";
      const event: SuspendEvent = { type: "suspend", envelope, askIds: [...askIds] };
      out.write(JSON.stringify(event) + "\n");
      return "written";
    },
  };
}
