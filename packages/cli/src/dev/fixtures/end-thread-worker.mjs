#!/usr/bin/env node
// Fixture worker that ends its conversation (guuey#2409): the real
// `serveNative` loop from @guuey/worker, so `emit.endThread` answers exactly
// what a builder's worker would see. It relays whether the invoke carried the
// close offer and what `endThread` answered, then returns its text.
import { serveNative } from "@guuey/worker";

await serveNative(
  (invoke, emit) => {
    const answer = emit.endThread({ code: "CHAT_FULL", message: "This chat is full. Start a new one to keep going." });
    emit.native({ offered: invoke.threadClose !== undefined, answer });
    return `closing:${invoke.input}`;
  },
  { framework: "fixture", sdkName: null, sdkVersion: null },
);
