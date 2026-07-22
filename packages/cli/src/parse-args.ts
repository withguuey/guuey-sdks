/**
 * Minimal CLI argument parser — extracted from `cli.ts` (walls2 T6) so it
 * can be unit-tested directly. `cli.ts` is the executable entrypoint (it
 * kicks off a background update check and other side effects at import
 * time), so importing IT just to exercise this pure function would run
 * those side effects inside every test; this module has none.
 */

/**
 * Parse CLI arguments into positional commands and named flags.
 *
 * A `--flag` followed by a non-flag value is `key=value`; otherwise it is
 * `key=true`. A single-dash short flag (`-o <file>`, e.g. `guuey mcp state
 * export ... -o out.json`) follows the identical rule under its
 * single-character key — needed for `-o`, the only short flag this CLI
 * has today.
 *
 * @param argv - Raw argument list (typically `process.argv.slice(2)`)
 * @returns Parsed `command` positional args and `flags` key-value map
 */
export function parseArgs(argv: string[]): {
  command: string[];
  flags: Record<string, string | true>;
} {
  const command: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      command.push(arg);
    }
  }

  return { command, flags };
}
