/**
 * Unit tests for `guuey widget keys …`.
 *
 * The pieces worth pinning are the ones a network round trip would hide:
 *
 *   - **Sequencing.** The app secret exists exactly once, in one response, and
 *     nothing that can fail may run before the user has seen it.
 *   - **The auto-configure decision.** Writing `userAuthConfig` is what makes
 *     the ceremony one command instead of two, and getting it wrong on an app
 *     that already trusts a different issuer would re-key its entire user base.
 *   - **The destructive gate on revoke**, which is terminal.
 *
 * The API is injected, so no test performs I/O.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  resolveWidgetConfigure,
  widgetKeysCreateCore,
  widgetKeysRevokeCore,
  widgetKeysRotateCore,
} from './widget';

const APP = '3f2b8c14-9d0e-4a71-b6c3-5e8f10a2d947';
const ISSUER = `https://apps.id.dev.sandbox.guuey.com/${APP}`;
const SECRET = 'guuey_widget_TESTSECRETTESTSECRETTESTSECRETTESTSECRET';

const auth = { pat: 'guuey_user_x' };
const config = { apiUrl: 'https://api.test' };

/**
 * The shape of the injected API call, spelled out in full so a `vi.fn` built
 * from it carries a five-element argument tuple — the assertions below read
 * the method / path / body positionally.
 */
type ApiFn = (
  pat: string,
  config: { apiUrl?: string },
  method: string,
  path: string,
  body?: unknown,
) => Promise<Response>;

/** `vi.fn` over {@link ApiFn} whose implementation ignores what it does not need. */
function fakeApi(impl: (method: string, path: string, body?: unknown) => Promise<Response>) {
  return vi.fn<ApiFn>((_pat, _config, method, path, body) => impl(method, path, body));
}

/**
 * Real `Response` objects rather than hand-shaped stand-ins, so `.ok` and
 * `.json()` behave exactly as they will in production (the house idiom — see
 * `mcp.test.ts`'s delete-status poll).
 */
function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}
function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { code: 'CONFLICT', message } }), {
    status,
  });
}

const CREATED = {
  appId: APP,
  kid: 'kid-1',
  issuerUrl: ISSUER,
  appSecret: SECRET,
  createdAt: '2026-07-28T12:00:00.000Z',
  currentAuth: { mode: null, issuerUrl: null, audience: null },
};

// ─────────────────────────────────────────────────────────────────────
// The configure decision
// ─────────────────────────────────────────────────────────────────────

describe('resolveWidgetConfigure', () => {
  it('configures an app with no issuer binding yet — the happy path', () => {
    expect(
      resolveWidgetConfigure({
        issuerUrl: ISSUER,
        audience: 'my-widget',
        currentAuth: { mode: null, issuerUrl: null, audience: null },
      }),
    ).toEqual({ action: 'configure', issuerUrl: ISSUER, audience: 'my-widget' });
  });

  it('re-configures idempotently when the app already points at this issuer', () => {
    expect(
      resolveWidgetConfigure({
        issuerUrl: ISSUER,
        audience: 'my-widget',
        currentAuth: { mode: 'byo', issuerUrl: ISSUER, audience: 'my-widget' },
      }),
    ).toMatchObject({ action: 'configure' });
  });

  // The catastrophe this whole slice is organised around: `deriveByoUserId`
  // hashes the issuer string, so repointing a configured app at a NEW issuer
  // gives every existing end-user a new id — orphaning their threads, memory
  // and durable home, with no migration. A convenience flag must never do that
  // silently, so the CLI refuses and makes the operator say it explicitly
  // through `guuey apps update`.
  it('REFUSES to repoint an app that already trusts a different issuer', () => {
    const decision = resolveWidgetConfigure({
      issuerUrl: ISSUER,
      audience: 'my-widget',
      currentAuth: {
        mode: 'byo',
        issuerUrl: 'https://auth.customer.example',
        audience: 'their-aud',
      },
    });

    expect(decision.action).toBe('conflict');
    expect(decision.action === 'conflict' && decision.message).toMatch(
      /auth\.customer\.example/,
    );
    expect(decision.action === 'conflict' && decision.message).toMatch(
      /guuey apps update/,
    );
  });

  // I3: a mode change is never a side effect. `native_pool` and `anonymous`
  // apps both have `issuerUrl: null`, so the conflict branch above does not see
  // them — yet flipping a live `native_pool` app to `byo` re-keys its ENTIRE
  // user base exactly as repointing an issuer would, just by a different route.
  it.each(['native_pool', 'anonymous'])(
    'REFUSES to flip a %s app to byo as a side effect of --audience',
    (mode) => {
      const decision = resolveWidgetConfigure({
        issuerUrl: ISSUER,
        audience: 'my-widget',
        currentAuth: { mode, issuerUrl: null, audience: null },
      });

      expect(decision.action).toBe('conflict');
      expect(decision.action === 'conflict' && decision.message).toContain(mode);
      // It must name the explicit path rather than just refusing.
      expect(decision.action === 'conflict' && decision.message).toMatch(
        /guuey apps update/,
      );
    },
  );

  it('configures an app that is ALREADY byo without complaint', () => {
    expect(
      resolveWidgetConfigure({
        issuerUrl: ISSUER,
        audience: 'my-widget',
        currentAuth: { mode: 'byo', issuerUrl: null, audience: null },
      }),
    ).toMatchObject({ action: 'configure' });
  });

  // A brand-new app has no mode at all — that is the happy path and must stay
  // one click, not a lecture.
  it('configures an app with no mode set at all', () => {
    expect(
      resolveWidgetConfigure({
        issuerUrl: ISSUER,
        audience: 'my-widget',
        currentAuth: { mode: null, issuerUrl: null, audience: null },
      }),
    ).toMatchObject({ action: 'configure' });
  });

  // No `--audience` is not an error: the key is minted and usable, the app just
  // is not wired up yet. Say exactly what to run.
  it('skips with the exact follow-up command when no audience was given', () => {
    const decision = resolveWidgetConfigure({
      issuerUrl: ISSUER,
      audience: undefined,
      currentAuth: { mode: null, issuerUrl: null, audience: null },
    });

    expect(decision.action).toBe('skip');
    expect(decision.action === 'skip' && decision.hint).toContain('guuey apps update');
    expect(decision.action === 'skip' && decision.hint).toContain(ISSUER);
  });
});

// ─────────────────────────────────────────────────────────────────────
// create
// ─────────────────────────────────────────────────────────────────────

describe('widgetKeysCreateCore', () => {
  it('mints, then configures the app in the same command', async () => {
    const api = fakeApi(async (method, path) => {
      if (method === 'POST' && path === `/apps/${APP}/widget-keys`) return ok(CREATED);
      if (method === 'PUT' && path === `/apps/${APP}`) return ok({ app: {} });
      throw new Error(`unexpected ${method} ${path}`);
    });

    const result = await widgetKeysCreateCore(
      { appId: APP, audience: 'my-widget', auth, config },
      { api },
    );

    expect(result.created.appSecret).toBe(SECRET);
    expect(result.configured).toBe(true);
    // `userAuthMode` moves WITH the binding: a key plus an issuer URL is not
    // enough — the verify path only runs for a `byo` app.
    expect(api.mock.calls[1]?.[4]).toEqual({
      userAuthMode: 'byo',
      userAuthConfig: { issuerUrl: ISSUER, audience: 'my-widget' },
    });
  });

  it('does not touch the app when no audience was given', async () => {
    const api = fakeApi(async () => ok(CREATED));
    const result = await widgetKeysCreateCore({ appId: APP, auth, config }, { api });

    expect(api).toHaveBeenCalledTimes(1);
    expect(result.configured).toBe(false);
    expect(result.hint).toContain('guuey apps update');
  });

  // The secret cannot be re-fetched, so a failure AFTER the mint must not cost
  // the caller the secret. The core returns it alongside the failure rather
  // than throwing, and the command prints the secret before it prints the
  // problem.
  it('still returns the secret when the follow-up configure fails', async () => {
    const api = fakeApi(async (method) =>
      method === 'POST' ? ok(CREATED) : fail(409, 'something went wrong'),
    );

    const result = await widgetKeysCreateCore(
      { appId: APP, audience: 'my-widget', auth, config },
      { api },
    );

    expect(result.created.appSecret).toBe(SECRET);
    expect(result.configured).toBe(false);
    expect(result.configureError).toMatch(/something went wrong/);
    // …and it says how to finish the job by hand.
    expect(result.hint).toContain('guuey apps update');
  });

  it('refuses to repoint a configured app, and says so without minting twice', async () => {
    const api = fakeApi(async (method) => {
      if (method === 'POST') {
        return ok({
          ...CREATED,
          currentAuth: {
            mode: 'byo',
            issuerUrl: 'https://auth.customer.example',
            audience: 'their-aud',
          },
        });
      }
      throw new Error('must not configure');
    });

    const result = await widgetKeysCreateCore(
      { appId: APP, audience: 'my-widget', auth, config },
      { api },
    );

    expect(api).toHaveBeenCalledTimes(1);
    expect(result.configured).toBe(false);
    expect(result.configureError).toMatch(/auth\.customer\.example/);
  });

  it('surfaces a mint failure as a thrown error', async () => {
    const api = fakeApi(async () => fail(409, 'App already has a widget signing key'));
    await expect(
      widgetKeysCreateCore({ appId: APP, auth, config }, { api }),
    ).rejects.toThrow(/already has a widget signing key/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// rotate
// ─────────────────────────────────────────────────────────────────────

describe('widgetKeysRotateCore', () => {
  const ROTATED = {
    appId: APP,
    kid: 'kid-2',
    previousKid: 'kid-1',
    issuerUrl: ISSUER,
    rotatedAt: '2026-07-28T12:00:00.000Z',
    overlapSeconds: 3900,
  };

  it('rotates the keypair only by default', async () => {
    const api = fakeApi(async () => ok(ROTATED));
    const result = await widgetKeysRotateCore({ appId: APP, auth, config }, { api });

    expect(api.mock.calls[0]?.[3]).toBe(`/apps/${APP}/widget-keys/rotate`);
    expect(api.mock.calls[0]?.[4]).toEqual({});
    expect(result.appSecret).toBeUndefined();
    expect(result.overlapSeconds).toBe(3900);
  });

  it('asks for a new secret only when told to', async () => {
    const api = fakeApi(async () => ok({ ...ROTATED, appSecret: SECRET }));
    const result = await widgetKeysRotateCore(
      { appId: APP, newSecret: true, auth, config },
      { api },
    );

    expect(api.mock.calls[0]?.[4]).toEqual({ newSecret: true });
    expect(result.appSecret).toBe(SECRET);
  });
});

// ─────────────────────────────────────────────────────────────────────
// revoke — destructive immediately; the retired key is terminal, the app's
// widget identity is not (T16: `create` re-enrols a revoked row deliberately)
// ─────────────────────────────────────────────────────────────────────

describe('widgetKeysRevokeCore', () => {
  // A FACTORY, not a shared constant: a real `Response` body can only be read
  // once, so a shared instance would couple these cases to each other.
  const revoked = (): Response =>
    ok({ appId: APP, revoked: true, revokedAt: '2026-07-28T12:00:00.000Z' });

  it('refuses outright in a non-interactive session without --yes', async () => {
    const api = fakeApi(async () => revoked());
    const result = await widgetKeysRevokeCore(
      { appId: APP, yes: false, stdinIsTTY: false, stdoutIsTTY: false, auth, config },
      { api },
    );

    expect(result.status).toBe('refused');
    expect(api).not.toHaveBeenCalled();
  });

  // Same regression the prompt test below guards against (T16 review I1):
  // this refusal message was the OTHER copy site that used to say
  // "Revocation is permanent" — untested before, which is why it drifted
  // false the moment `create` started re-enrolling revoked rows.
  it('the non-interactive refusal does not claim revocation is permanent', async () => {
    const api = fakeApi(async () => revoked());
    const result = await widgetKeysRevokeCore(
      { appId: APP, yes: false, stdinIsTTY: false, stdoutIsTTY: false, auth, config },
      { api },
    );

    expect(result.status).toBe('refused');
    const error = result.status === 'refused' ? result.error : '';
    expect(error).not.toMatch(/permanent|cannot be undone|cannot be restored|no un-revoke/i);
    expect(error).toMatch(/disables minting/i);
  });

  // Revoking stops every embedded widget authenticating end-users IMMEDIATELY
  // — the prompt has to say so rather than reading like a no-op. It must NOT
  // say "permanent"/"cannot be undone" any more: `widget keys create`
  // deliberately re-enrols a revoked row with a fresh key (T16), and telling
  // the builder the identity is gone forever would be false.
  it('warns of the immediate effect and names `widget keys create` as the way back', async () => {
    const api = fakeApi(async () => revoked());
    const confirm = vi.fn(async (_question: string) => 'y');

    await widgetKeysRevokeCore(
      { appId: APP, yes: false, stdinIsTTY: true, stdoutIsTTY: true, auth, config },
      { api, confirm },
    );

    const question = String(confirm.mock.calls[0]?.[0]);
    expect(question).toMatch(/stops authenticating end-users/i);
    expect(question).toMatch(/widget keys create/);
    expect(question).not.toMatch(/permanent|cannot be undone|cannot be restored/i);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('aborts without calling the API when the prompt is declined', async () => {
    const api = fakeApi(async () => revoked());
    const result = await widgetKeysRevokeCore(
      { appId: APP, yes: false, stdinIsTTY: true, stdoutIsTTY: true, auth, config },
      { api, confirm: async () => 'n' },
    );

    expect(result.status).toBe('aborted');
    expect(api).not.toHaveBeenCalled();
  });

  it('--yes skips the prompt entirely', async () => {
    const api = fakeApi(async () => revoked());
    const confirm = vi.fn(async (_question: string) => 'n');
    const result = await widgetKeysRevokeCore(
      { appId: APP, yes: true, stdinIsTTY: true, stdoutIsTTY: true, auth, config },
      { api, confirm },
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'revoked' });
    expect(api.mock.calls[0]?.[2]).toBe('DELETE');
  });
});
