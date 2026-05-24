/**
 * guuey logout — Clear stored authentication.
 */

import { clearAuth, isLoggedIn } from '../auth';
import * as out from '../output';

/**
 * Handle the `guuey logout` command.
 * Clears stored authentication tokens from `~/.guuey/auth.json`.
 */
export function logout(): void {
  if (!isLoggedIn()) {
    console.log('Not currently logged in.');
    return;
  }
  clearAuth();
  out.success('Logged out.');
}
