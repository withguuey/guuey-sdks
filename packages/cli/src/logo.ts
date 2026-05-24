/* eslint-disable no-console */

/**
 * Print the welcome screen (getting started steps).
 * Called on first install/login.
 */
export function printWelcome(version: string): void {
  console.log(`\n  \x1b[1m\x1b[38;5;75mggui\x1b[0m v${version}`);
  console.log('  The universal interface layer for AI agents.\n');
  printSteps();
}

/**
 * Print the compact guide (no logo).
 * Shown when user runs `ggui` with no arguments after first run.
 */
export function printQuickGuide(version: string): void {
  console.log(`\n  \x1b[1m\x1b[38;5;75mggui\x1b[0m v${version} — AI agents meet humans.\n`);
  printSteps();
}

function printSteps(): void {
  console.log('  Get started:\n');
  console.log('    Step 1.  \x1b[1mguuey login\x1b[0m');
  console.log('    Step 2.  \x1b[1mguuey create my-agent --framework claude-agent-sdk\x1b[0m');
  console.log('    Step 3.  \x1b[1mcd my-agent && guuey dev\x1b[0m');
  console.log('');
  console.log('  Other frameworks:');
  console.log('    \x1b[2mguuey create my-agent --framework openai-agents-sdk\x1b[0m');
  console.log('    \x1b[2mguuey create my-agent --framework google-adk\x1b[0m');
  console.log('    \x1b[2mguuey create my-agent --framework vanilla\x1b[0m');
  console.log('\n  For all commands, run: \x1b[2mguuey --help\x1b[0m\n');
}
