import { describe, expect, it, vi } from 'vitest';
import type { GuueyAppAccess } from '@guuey/config';
import { ACCESS_DOOR_LINE, accessFieldsToSend, accessSummary, convergeAccessFromConfig } from './deploy-access';

const CONFIG = { apiUrl: 'https://api.guuey.test/v1' };
const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Pool';
const ACCESS: GuueyAppAccess = {
  userAuthMode: 'byo',
  userAuthConfig: { issuerUrl: ISSUER, audience: 'client-123' },
  allowedDomains: ['https://app.example.com'],
  guestAccess: false,
};
const STORED_MATCH = {
  userAuthMode: 'byo',
  userAuthConfig: { issuerUrl: ISSUER, audience: 'client-123', oidcClientId: 'page-client', hasOidcClientSecret: true },
  allowedDomains: ['https://app.example.com'],
  guestAccess: false,
};

/** An api whose GET answers `getStatus` with `{ app: stored }` and whose PUT answers `putStatus` / `putBody`. */
function apiWith(opts: { stored?: unknown; getStatus?: number; putStatus?: number; putBody?: unknown; getThrows?: boolean }) {
  return vi.fn(async (_pat: string, _cfg: { apiUrl?: string }, method: string) => {
    if (method === 'GET') {
      if (opts.getThrows === true) throw new Error('network down');
      return new Response(JSON.stringify({ app: { id: 'app-1', ...(opts.stored as object) } }), { status: opts.getStatus ?? 200 });
    }
    return new Response(JSON.stringify(opts.putBody ?? { app: { id: 'app-1' } }), { status: opts.putStatus ?? 200 });
  });
}

function io() {
  const logs: string[] = [];
  const warns: string[] = [];
  return { logs, warns, deps: { log: (l: string) => logs.push(l), warn: (l: string) => warns.push(l) } };
}

describe('accessFieldsToSend (guuey#2358)', () => {
  it('sends every declared field the stored app does not hold, in the file\'s own vocabulary', () => {
    expect(accessFieldsToSend(ACCESS, { userAuthMode: null, userAuthConfig: null, allowedDomains: [], guestAccess: null })).toEqual(ACCESS);
  });

  it('sends nothing when every declared field already holds (the page client on the stored binding is not a difference)', () => {
    expect(accessFieldsToSend(ACCESS, STORED_MATCH)).toEqual({});
  });

  it('an unreadable app (stored undefined) is never "holds": every declared field is sent', () => {
    expect(accessFieldsToSend(ACCESS, undefined)).toEqual(ACCESS);
  });

  it('a projection that lacks a member (an older server) sends that member', () => {
    const { guestAccess: _omitted, ...withoutGuest } = STORED_MATCH;
    expect(accessFieldsToSend(ACCESS, withoutGuest)).toEqual({ guestAccess: false });
  });

  it('a different issuer or audience re-sends the binding', () => {
    expect(accessFieldsToSend(ACCESS, { ...STORED_MATCH, userAuthConfig: { issuerUrl: 'https://other.example.com', audience: 'client-123' } })).toEqual({
      userAuthConfig: ACCESS.userAuthConfig,
    });
    expect(accessFieldsToSend(ACCESS, { ...STORED_MATCH, userAuthConfig: { issuerUrl: ISSUER, audience: 'other' } })).toEqual({
      userAuthConfig: ACCESS.userAuthConfig,
    });
  });

  it('userAuthConfig: null holds only when nothing is bound', () => {
    expect(accessFieldsToSend({ userAuthConfig: null }, { ...STORED_MATCH, userAuthConfig: null })).toEqual({});
    expect(accessFieldsToSend({ userAuthConfig: null }, { ...STORED_MATCH, userAuthConfig: { issuerUrl: null, audience: null } })).toEqual({});
    expect(accessFieldsToSend({ userAuthConfig: null }, STORED_MATCH)).toEqual({ userAuthConfig: null });
  });

  it('allowedDomains compare after the server\'s trim + lowercase, so a cased declaration of the stored list holds', () => {
    expect(accessFieldsToSend({ allowedDomains: [' HTTPS://App.Example.com '] }, STORED_MATCH)).toEqual({});
    expect(accessFieldsToSend({ allowedDomains: ['https://new.example.com'] }, STORED_MATCH)).toEqual({ allowedDomains: ['https://new.example.com'] });
  });

  it('an undeclared member is never sent', () => {
    expect(accessFieldsToSend({ guestAccess: true }, { userAuthMode: null, userAuthConfig: null, allowedDomains: [], guestAccess: null })).toEqual({ guestAccess: true });
  });
});

describe('guestDailyMessageLimit — the per-guest daily cap (guuey#2358)', () => {
  const STORED_NONE = { userAuthMode: null, userAuthConfig: null, allowedDomains: [], guestAccess: null, guestDailyMessageLimit: null };

  it('sends a declared cap the app does not hold, and a declared null that clears a stored cap', () => {
    expect(accessFieldsToSend({ guestDailyMessageLimit: 20 }, STORED_NONE)).toEqual({ guestDailyMessageLimit: 20 });
    expect(accessFieldsToSend({ guestDailyMessageLimit: 20 }, undefined)).toEqual({ guestDailyMessageLimit: 20 });
    expect(accessFieldsToSend({ guestDailyMessageLimit: null }, { ...STORED_NONE, guestDailyMessageLimit: 7 })).toEqual({
      guestDailyMessageLimit: null,
    });
  });

  it('holds when the stored cap matches', () => {
    expect(accessFieldsToSend({ guestDailyMessageLimit: 7 }, { ...STORED_NONE, guestDailyMessageLimit: 7 })).toEqual({});
  });

  it('a declared null is sent even when the read answers null: the read cannot tell a stored "no cap" from a limit never set, and only the stored null stops the publish-time default', () => {
    expect(accessFieldsToSend({ guestDailyMessageLimit: null }, STORED_NONE)).toEqual({ guestDailyMessageLimit: null });
    expect(accessFieldsToSend({ guestDailyMessageLimit: null }, undefined)).toEqual({ guestDailyMessageLimit: null });
  });

  it('a projection that lacks the member (an older server) sends the declared cap or null', () => {
    const { guestDailyMessageLimit: _omitted, ...withoutLimit } = STORED_NONE;
    expect(accessFieldsToSend({ guestDailyMessageLimit: 20 }, withoutLimit)).toEqual({ guestDailyMessageLimit: 20 });
    expect(accessFieldsToSend({ guestDailyMessageLimit: null }, withoutLimit)).toEqual({ guestDailyMessageLimit: null });
  });

  it('a declared null on an app the read shows without a cap is still PUT, and the applied line names it', async () => {
    const api = apiWith({ stored: { ...STORED_MATCH, guestDailyMessageLimit: null } });
    const { logs, deps } = io();
    const outcome = await convergeAccessFromConfig(
      'pat',
      CONFIG,
      'app-1',
      { app: { access: { ...ACCESS, guestDailyMessageLimit: null } } },
      { api, ...deps },
    );
    expect(outcome).toEqual({ kind: 'applied', fields: ['guestDailyMessageLimit'] });
    expect(api).toHaveBeenNthCalledWith(2, 'pat', CONFIG, 'PUT', '/apps/app-1', { guestDailyMessageLimit: null });
    expect(logs).toEqual([
      '  Access: app.access applied (guestDailyMessageLimit) — mode byo · issuer cognito-idp.us-east-1.amazonaws.com · guest access off · no guest limit.',
    ]);
  });

  it('a file that does not declare it never sends it — no default is injected, a stored cap stays', () => {
    expect(accessFieldsToSend(ACCESS, { ...STORED_MATCH, guestDailyMessageLimit: 7 })).toEqual({});
    expect(accessFieldsToSend(ACCESS, undefined)).not.toHaveProperty('guestDailyMessageLimit');
  });

  it('the Access line names the cap — declared, else as stored', () => {
    expect(accessSummary({ guestAccess: true, guestDailyMessageLimit: 20 }, undefined)).toBe('guest access on · guest limit 20/day');
    expect(accessSummary({ guestAccess: true }, STORED_NONE)).toBe('issuer none · guest access on · no guest limit');
    expect(accessSummary({ guestAccess: true }, { ...STORED_NONE, guestDailyMessageLimit: 7 })).toBe(
      'issuer none · guest access on · guest limit 7/day',
    );
  });

  it('converges through PUT /apps/:id and names the field in the applied line', async () => {
    const api = apiWith({ stored: { ...STORED_MATCH, guestDailyMessageLimit: null } });
    const { logs, deps } = io();
    const outcome = await convergeAccessFromConfig(
      'pat',
      CONFIG,
      'app-1',
      { app: { access: { ...ACCESS, guestDailyMessageLimit: 20 } } },
      { api, ...deps },
    );
    expect(outcome).toEqual({ kind: 'applied', fields: ['guestDailyMessageLimit'] });
    expect(api).toHaveBeenNthCalledWith(2, 'pat', CONFIG, 'PUT', '/apps/app-1', { guestDailyMessageLimit: 20 });
    expect(logs).toEqual([
      '  Access: app.access applied (guestDailyMessageLimit) — mode byo · issuer cognito-idp.us-east-1.amazonaws.com · guest access off · guest limit 20/day.',
    ]);
  });
});

describe('accessSummary (guuey#2358)', () => {
  it('names the mode, the issuer HOST and guest access', () => {
    expect(accessSummary(ACCESS, undefined)).toBe('mode byo · issuer cognito-idp.us-east-1.amazonaws.com · guest access off');
  });

  it('falls back to the stored value for an undeclared member and leaves out what neither side knows', () => {
    expect(accessSummary({ guestAccess: true }, { userAuthMode: 'native_pool', userAuthConfig: null, allowedDomains: [], guestAccess: null })).toBe(
      'mode native_pool · issuer none · guest access on',
    );
    expect(accessSummary({ guestAccess: null }, undefined)).toBe('guest access default');
  });
});

describe('convergeAccessFromConfig (guuey#2358)', () => {
  it('no app.access → nothing read, nothing sent, nothing printed', async () => {
    const api = apiWith({});
    const { logs, warns, deps } = io();
    expect(await convergeAccessFromConfig('pat', CONFIG, 'app-1', { app: { name: 'x' } }, { api, ...deps })).toEqual({ kind: 'none' });
    expect(await convergeAccessFromConfig('pat', CONFIG, 'app-1', {}, { api, ...deps })).toEqual({ kind: 'none' });
    expect(api).not.toHaveBeenCalled();
    expect([...logs, ...warns]).toEqual([]);
  });

  it('reads the app, PUTs only what differs through PUT /apps/:id, and prints the applied line', async () => {
    const api = apiWith({ stored: { ...STORED_MATCH, userAuthMode: 'native_pool' } });
    const { logs, warns, deps } = io();
    const outcome = await convergeAccessFromConfig('pat', CONFIG, 'app-1', { app: { access: ACCESS } }, { api, ...deps });
    expect(outcome).toEqual({ kind: 'applied', fields: ['userAuthMode'] });
    expect(api).toHaveBeenNthCalledWith(1, 'pat', CONFIG, 'GET', '/apps/app-1');
    expect(api).toHaveBeenNthCalledWith(2, 'pat', CONFIG, 'PUT', '/apps/app-1', { userAuthMode: 'byo' });
    expect(logs).toEqual(['  Access: app.access applied (userAuthMode) — mode byo · issuer cognito-idp.us-east-1.amazonaws.com · guest access off.']);
    expect(warns).toEqual([]);
  });

  it('access already in place → no PUT, the held line', async () => {
    const api = apiWith({ stored: STORED_MATCH });
    const { logs, deps } = io();
    expect(await convergeAccessFromConfig('pat', CONFIG, 'app-1', { app: { access: ACCESS } }, { api, ...deps })).toEqual({ kind: 'held' });
    expect(api).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(['  Access: app.access already in place — mode byo · issuer cognito-idp.us-east-1.amazonaws.com · guest access off.']);
  });

  it('a failed read is not fatal: every declared field is sent and the server decides', async () => {
    for (const api of [apiWith({ getStatus: 500 }), apiWith({ getThrows: true })]) {
      const { deps } = io();
      const outcome = await convergeAccessFromConfig('pat', CONFIG, 'app-1', { app: { access: ACCESS } }, { api, ...deps });
      expect(outcome.kind).toBe('applied');
      expect(api).toHaveBeenLastCalledWith('pat', CONFIG, 'PUT', '/apps/app-1', ACCESS);
    }
  });

  it('a credential that cannot edit the app record (403) is REFUSED with the server message and the doors — never a silent skip', async () => {
    const api = apiWith({
      stored: { ...STORED_MATCH, userAuthMode: null },
      putStatus: 403,
      putBody: { error: { code: 'FORBIDDEN', message: 'This route is user-scoped and cannot be called with a workspace API key' } },
    });
    const { logs, warns, deps } = io();
    const outcome = await convergeAccessFromConfig('pat', CONFIG, 'app-1', { app: { access: ACCESS } }, { api, ...deps });
    expect(outcome.kind).toBe('refused');
    expect(logs).toEqual([]);
    expect(warns[0]).toContain('Access: app.access was NOT applied — [FORBIDDEN] This route is user-scoped');
    expect(warns[0]).toContain('The deploy stopped before going live');
    expect(warns[1]).toBe(ACCESS_DOOR_LINE);
  });

  it('a transport failure on the write is refused too (the caller stops the deploy)', async () => {
    const api = vi.fn(async (_pat: string, _cfg: { apiUrl?: string }, method: string) => {
      if (method === 'GET') return new Response(JSON.stringify({ app: { id: 'app-1' } }), { status: 200 });
      throw new Error('socket hang up');
    });
    const { warns, deps } = io();
    expect(await convergeAccessFromConfig('pat', CONFIG, 'app-1', { app: { access: ACCESS } }, { api, ...deps })).toEqual({
      kind: 'refused',
      message: 'socket hang up',
    });
    expect(warns[0]).toContain('app.access was NOT applied — socket hang up');
  });
});
