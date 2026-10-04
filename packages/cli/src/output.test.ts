/**
 * The CLI's rendering of a failed app-scoped call. cliApi answers "no such
 * app" and "this account may not do that to it" with the SAME 404
 * `{ error: { code: 'NOT_FOUND' } }` on purpose (guuey#1997), so the CLI must
 * name both, and must never print a flat "not found" or guess at a missing
 * route. Every other failure keeps the API's own message.
 */
import { describe, expect, it } from 'vitest';
import { apiErrorCode, appApiErrorMessage, appNotFoundOrNotAllowed } from './output';

const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'App a1 not found' } };

describe('apiErrorCode', () => {
  it('reads the code from the envelope', () => {
    expect(apiErrorCode(NOT_FOUND)).toBe('NOT_FOUND');
  });
  it('is undefined for a body with no envelope code (a gateway default, a string error, no body)', () => {
    expect(apiErrorCode({ message: 'Not Found' })).toBeUndefined();
    expect(apiErrorCode({ error: 'boom' })).toBeUndefined();
    expect(apiErrorCode(undefined)).toBeUndefined();
    expect(apiErrorCode(null)).toBeUndefined();
  });
});

describe('appApiErrorMessage', () => {
  it('the uniform 404 names both possibilities and what to check', () => {
    const msg = appApiErrorMessage(404, NOT_FOUND, 'a1', 'undeploy', 'fallback');
    expect(msg).toBe(appNotFoundOrNotAllowed('a1', 'undeploy'));
    expect(msg).toContain('App a1 was not found, or this account is not allowed to undeploy it.');
    expect(msg).toContain('guuey apps list');
    expect(msg).toContain('guuey whoami');
  });

  it('a 404 that is not the cliApi envelope keeps the generic rendering', () => {
    expect(appApiErrorMessage(404, { message: 'Not Found' }, 'a1', 'undeploy', 'HTTP 404')).toBe('HTTP 404');
  });

  it('a NOT_FOUND code on another status is not the uniform 404', () => {
    expect(appApiErrorMessage(400, NOT_FOUND, 'a1', 'undeploy', 'HTTP 400')).toBe('NOT_FOUND: App a1 not found');
  });

  it('every other failure keeps the API message', () => {
    const body = { error: { code: 'CONFLICT', message: 'App a1 is suspended' } };
    expect(appApiErrorMessage(409, body, 'a1', 'recover', 'HTTP 409')).toBe('CONFLICT: App a1 is suspended');
  });
});
