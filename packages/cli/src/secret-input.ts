/**
 * Read one secret from stdin, never from argv (guuey#2412): the only way
 * `guuey byok set` takes a provider key, so the key never lands in shell
 * history or a process listing.
 *
 * - **A pipe** (`guuey byok set … < key.txt`) is read to EOF. Exactly one
 *   trailing `\n` or `\r\n` is stripped (the newline a file or `echo` adds);
 *   empty input and input spanning more than one line are refused, so a file
 *   holding two keys is never sent as one.
 * - **A TTY** gets one muted prompt on stderr, the pattern `guuey login`'s
 *   paste uses (`commands/login.ts` `waitForPastedToken`): readline runs in
 *   terminal mode (raw mode, so the TTY driver does not echo) with an output
 *   stream that discards everything, so the key is never written back to the
 *   terminal. Ctrl-C re-raises SIGINT, as login does.
 *
 * Pure of the network and of `process.exit`: the caller turns a refusal into
 * its own message.
 */
import * as readline from 'node:readline';
import { Writable } from 'node:stream';

/** Why stdin gave no usable secret. */
export type SecretInputRefusal = 'empty' | 'multi-line';

/** The secret read, or why there is none. */
export type SecretInputResult = { ok: true; secret: string } | { ok: false; reason: SecretInputRefusal };

/** A readable stdin; `isTTY` is set on a terminal (`process.stdin` is a `tty.ReadStream` there). */
export type SecretInputStream = NodeJS.ReadableStream & { isTTY?: boolean };

/** Read the secret from `input` (a pipe to EOF, or one muted line on a TTY, after `prompt`). */
export function readSecretFromStdin(input: SecretInputStream, prompt: string): Promise<SecretInputResult> {
  return input.isTTY === true ? readMutedLine(input, prompt) : readPipe(input);
}

async function readPipe(input: NodeJS.ReadableStream): Promise<SecretInputResult> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const secret = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text;
  if (secret.length === 0) return { ok: false, reason: 'empty' };
  if (/[\r\n]/.test(secret)) return { ok: false, reason: 'multi-line' };
  return { ok: true, secret };
}

function readMutedLine(input: NodeJS.ReadableStream, prompt: string): Promise<SecretInputResult> {
  return new Promise((resolve) => {
    // The echo target that discards everything: the mute half (see the header).
    const muted = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const rl = readline.createInterface({ input, output: muted, terminal: true });
    // Set before a deliberate close, so the trailing 'close' event can tell it from EOF (Ctrl-D).
    let done = false;
    const release = (): void => {
      rl.close();
      // readline leaves a resumed stream flowing, which keeps the event loop alive: release it.
      input.pause();
    };
    process.stderr.write(prompt);
    rl.on('line', (line) => {
      done = true;
      release();
      // The muted output swallowed the Enter keypress too: end the prompt line ourselves.
      process.stderr.write('\n');
      resolve(line.length === 0 ? { ok: false, reason: 'empty' } : { ok: true, secret: line });
    });
    rl.on('close', () => {
      if (done) return;
      done = true;
      input.pause();
      process.stderr.write('\n');
      resolve({ ok: false, reason: 'empty' });
    });
    // Raw mode turns Ctrl-C into a readline event: restore the terminal, then die BY SIGINT, so a
    // wrapping shell's abort-on-child-SIGINT convention still holds (login.ts says why).
    rl.on('SIGINT', () => {
      done = true;
      release();
      process.stderr.write('\n');
      process.kill(process.pid, 'SIGINT');
    });
  });
}
