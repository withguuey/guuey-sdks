/**
 * guuey whoami — Show current authenticated user.
 */

import { loadAuth } from '../auth';
import * as out from '../output';

/**
 * Handle the `guuey whoami` command.
 * Displays the currently authenticated user's email, user ID, and token expiry.
 *
 * @param opts - Output options (set `json: true` for machine-readable output)
 */
export function whoami(opts: { json?: boolean }): void {
  const auth = loadAuth();

  if (!auth) {
    console.log('Not logged in. Run: guuey login');
    return;
  }

  const expired = new Date(auth.expiresAt) <= new Date();

  if (opts.json) {
    out.json({
      email: auth.email ?? null,
      userId: auth.userId ?? null,
      expiresAt: auth.expiresAt,
      expired,
    });
    return;
  }

  console.log(`Email:   ${auth.email ?? '(unknown)'}`);
  console.log(`User ID: ${auth.userId ?? '(unknown)'}`);
  console.log(`Expires: ${auth.expiresAt}${expired ? ' (EXPIRED — run: guuey login)' : ''}`);
}
