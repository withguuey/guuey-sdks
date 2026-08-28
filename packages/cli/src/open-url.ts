/**
 * Open a URL in the default browser — WITHOUT ever routing the value through
 * a shell. Two guards close guuey#500 (CodeQL `js/command-line-injection`):
 *
 *  1. **Protocol allowlist.** The URL is parsed and REFUSED (throws) unless
 *     its protocol is `http:`/`https:`. A server-supplied value — the OAuth
 *     broker's `authorizeUrl` reaches this from a remote HTTP response — that
 *     is not a real web URL never reaches any opener; the calling command
 *     surfaces the thrown error instead of opening anything.
 *  2. **Non-shell win32 opener.** Windows uses
 *     `rundll32 url.dll,FileProtocolHandler <url>` with the URL in a bound
 *     argv slot, NOT `cmd /c start "" <url>`. `cmd`'s parser severs the value
 *     at the first `&` (breaking every real OAuth authorize URL, which carries
 *     `&` between query params) and executes injected metacharacters;
 *     `rundll32` is not a command interpreter, so the value is inert data.
 *     This one change fixes BOTH the correctness bug and the injection.
 *
 * mac (`open`) and linux (`xdg-open`) already pass the URL as a bound
 * `execFile` argument — no shell, no interpolation — so they keep their
 * openers; the protocol guard is enforced for every platform regardless.
 */
import { execFile, execFileSync } from 'node:child_process';

/**
 * Open `url` in the default browser (best-effort).
 *
 * @returns `true` when an opener was spawned, `false` when the platform has
 *   no available opener (linux without `xdg-open`).
 * @throws {Error} when `url` is not a valid `http:`/`https:` URL — the guard
 *   that keeps a server-supplied value out of any opener.
 */
export function openUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing to open a malformed URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to open a non-http(s) URL (${parsed.protocol}): ${url}`);
  }

  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      execFile('open', [url], () => {});
      return true;
    }
    if (platform === 'win32') {
      // rundll32 is not a shell: `url` is a bound argv slot, so `&` and every
      // other cmd metacharacter in the value are passed through as literal
      // data rather than parsed as a command line.
      execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], () => {});
      return true;
    }
    // Linux: only spawn xdg-open when it actually exists — otherwise report
    // "nothing opened" cleanly instead of emitting an uncaught 'error' event.
    try {
      execFileSync('which', ['xdg-open'], { stdio: 'ignore' });
    } catch {
      return false;
    }
    execFile('xdg-open', [url], () => {});
    return true;
  } catch {
    return false;
  }
}
