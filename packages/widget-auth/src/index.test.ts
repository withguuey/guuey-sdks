import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  signUserToken,
  WidgetAuthAppNotConfiguredError,
  WidgetAuthConfigError,
  WidgetAuthCredentialError,
  WidgetAuthError,
  WidgetAuthNetworkError,
  WidgetAuthRequestError,
  WidgetAuthServiceError,
  type FetchLike,
} from './index.js';

/**
 * A secret with a distinctive tail, so the "never leaks" assertions cannot pass
 * by accident on a substring that happens to appear elsewhere.
 */
const SECRET = 'guuey_widget_kQ7ZvN3xLeakCanaryTailAbc123';
const APP_ID = 'app_01HQZX9K2M4N6P8R0S2T4V6W8Y';
const BASE = 'https://api.example.test';

const OK_BODY = {
  token: 'header.payload.signature',
  expiresAtEpoch: 1786000900,
  issuer: `https://apps.id.guuey.com/${APP_ID}`,
  kid: 'kid-abc',
};

interface Call {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  };
}

/** A `FetchLike` that records calls and replays a scripted response. */
function stubFetch(response: {
  status: number;
  json?: () => Promise<unknown>;
}): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn: FetchLike & { calls: Call[] } = Object.assign(
    async (url: string, init: Call['init']) => {
      calls.push({ url, init });
      return {
        status: response.status,
        json: response.json ?? (async () => OK_BODY),
      };
    },
    { calls },
  );
  return fn;
}

/** A `FetchLike` that must never be reached. */
function forbiddenFetch(): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn: FetchLike & { calls: Call[] } = Object.assign(
    async (url: string, init: Call['init']) => {
      calls.push({ url, init });
      throw new Error('fetch must not be called');
    },
    { calls },
  );
  return fn;
}

const config = (over: Partial<Parameters<typeof signUserToken>[1]> = {}) => ({
  appId: APP_ID,
  appSecret: SECRET,
  apiBaseUrl: BASE,
  ...over,
});

describe('signUserToken — request shape', () => {
  it('POSTs the mint route with the app secret as a bearer', async () => {
    const fetchImpl = stubFetch({ status: 200 });
    await signUserToken({ userId: 'user-42' }, config({ fetch: fetchImpl }));

    expect(fetchImpl.calls).toHaveLength(1);
    const call = fetchImpl.calls[0]!;
    expect(call.url).toBe(`${BASE}/v1/widget/token`);
    expect(call.init.method).toBe('POST');
    expect(call.init.headers['authorization']).toBe(`Bearer ${SECRET}`);
    expect(call.init.headers['content-type']).toBe('application/json');
  });

  it('normalizes a trailing slash on the base URL', async () => {
    const fetchImpl = stubFetch({ status: 200 });
    await signUserToken(
      { userId: 'u' },
      config({ apiBaseUrl: `${BASE}///`, fetch: fetchImpl }),
    );
    expect(fetchImpl.calls[0]!.url).toBe(`${BASE}/v1/widget/token`);
  });

  it('sends appId and userId, omitting unset optional fields', async () => {
    const fetchImpl = stubFetch({ status: 200 });
    await signUserToken({ userId: 'user-42' }, config({ fetch: fetchImpl }));

    const body: unknown = JSON.parse(fetchImpl.calls[0]!.init.body);
    expect(body).toEqual({ appId: APP_ID, userId: 'user-42' });
  });

  it('forwards name, email and ttlSeconds when supplied', async () => {
    const fetchImpl = stubFetch({ status: 200 });
    await signUserToken(
      { userId: 'user-42', name: 'Ada', email: 'ada@example.com' },
      config({ ttlSeconds: 300, fetch: fetchImpl }),
    );

    const body: unknown = JSON.parse(fetchImpl.calls[0]!.init.body);
    expect(body).toEqual({
      appId: APP_ID,
      userId: 'user-42',
      name: 'Ada',
      email: 'ada@example.com',
      ttlSeconds: 300,
    });
  });

  /**
   * The load-bearing one (R2). `iat`/`nbf` are backdated 60s and `exp` is
   * derived from the TTL SERVER-side, in `assembleAppUserClaims`. If this
   * package ever started sending any of them, `appSigner`'s strict parser would
   * 400 the unknown key and every mint would fail — so the failure mode this
   * pins is a hard outage, not a subtle one.
   *
   * Note what a re-implemented backdate would NOT do: shorten the token. `exp`
   * anchors to the real now, so it does not move. It would widen the acceptance
   * window (`nbf` another 60s earlier, so the skew margin stops meaning 60s) and
   * make `iat` misstate the token's age.
   */
  it('sends no time or identity claims — assembly is server-side', async () => {
    const fetchImpl = stubFetch({ status: 200 });
    await signUserToken(
      { userId: 'user-42', name: 'Ada', email: 'ada@example.com' },
      config({ ttlSeconds: 900, fetch: fetchImpl }),
    );

    const keys = Object.keys(JSON.parse(fetchImpl.calls[0]!.init.body) as object);
    for (const forbidden of ['iat', 'nbf', 'exp', 'iss', 'aud', 'sub', 'claims']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('returns the minted token verbatim', async () => {
    const fetchImpl = stubFetch({ status: 200 });
    const result = await signUserToken(
      { userId: 'user-42' },
      config({ fetch: fetchImpl }),
    );
    expect(result).toEqual(OK_BODY);
  });

  it('passes an AbortSignal through to fetch', async () => {
    const fetchImpl = stubFetch({ status: 200 });
    const controller = new AbortController();
    await signUserToken(
      { userId: 'u' },
      config({ signal: controller.signal, fetch: fetchImpl }),
    );
    expect(fetchImpl.calls[0]!.init.signal).toBe(controller.signal);
  });
});

describe('signUserToken — apiBaseUrl resolution', () => {
  const original = process.env['GUUEY_API_URL'];
  beforeEach(() => {
    delete process.env['GUUEY_API_URL'];
  });
  afterEach(() => {
    if (original === undefined) delete process.env['GUUEY_API_URL'];
    else process.env['GUUEY_API_URL'] = original;
  });

  it('falls back to GUUEY_API_URL', async () => {
    process.env['GUUEY_API_URL'] = 'https://env.example.test';
    const fetchImpl = stubFetch({ status: 200 });
    await signUserToken(
      { userId: 'u' },
      { appId: APP_ID, appSecret: SECRET, fetch: fetchImpl },
    );
    expect(fetchImpl.calls[0]!.url).toBe('https://env.example.test/v1/widget/token');
  });

  it('prefers an explicit apiBaseUrl over the environment', async () => {
    process.env['GUUEY_API_URL'] = 'https://env.example.test';
    const fetchImpl = stubFetch({ status: 200 });
    await signUserToken({ userId: 'u' }, config({ fetch: fetchImpl }));
    expect(fetchImpl.calls[0]!.url).toBe(`${BASE}/v1/widget/token`);
  });

  it('is a config error when neither is set', async () => {
    const fetchImpl = forbiddenFetch();
    await expect(
      signUserToken(
        { userId: 'u' },
        { appId: APP_ID, appSecret: SECRET, fetch: fetchImpl },
      ),
    ).rejects.toBeInstanceOf(WidgetAuthConfigError);
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

/**
 * The guard for the package's central threat model.
 *
 * A `window`-and-`document` pair is what distinguishes a page from a server-side
 * JS runtime, so these tests stub that pair rather than switching the suite to
 * jsdom: the condition under test IS `typeof window`/`typeof document`, stubbing
 * reproduces it exactly, and it keeps a deliberately zero-dependency published
 * package from acquiring jsdom (and a second round of two-workspace lockfile
 * churn) to assert two `typeof` checks. Same idiom as the missing-global-fetch
 * test above.
 */
describe('signUserToken — refuses to run in a browser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws before anything else when window and document are both present', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    const fetchImpl = forbiddenFetch();

    const err = await signUserToken(
      { userId: 'u' },
      config({ fetch: fetchImpl }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WidgetAuthConfigError);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('says why, and names the rotation the situation calls for', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});

    const err = await signUserToken({ userId: 'u' }, config()).catch(
      (e: unknown) => e,
    );

    const message = (err as Error).message;
    expect(message).toContain('browser');
    // The secret is already exposed at this point; saying so is the whole value.
    expect(message).toContain('every visitor can read it');
    expect(message).toContain('guuey widget keys rotate');
  });

  /**
   * The conjunction is load-bearing, not defensive noise. Edge runtimes are a
   * legitimate place to mint from and some define a `window`-ish global with no
   * `document` — testing `window` alone would refuse a correct deployment.
   */
  it('allows an edge runtime that has a window-ish global but no document', async () => {
    vi.stubGlobal('window', {});
    const fetchImpl = stubFetch({ status: 200 });

    const result = await signUserToken({ userId: 'u' }, config({ fetch: fetchImpl }));

    expect(result).toEqual(OK_BODY);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('allows a document-ish global with no window', async () => {
    vi.stubGlobal('document', {});
    const fetchImpl = stubFetch({ status: 200 });

    await signUserToken({ userId: 'u' }, config({ fetch: fetchImpl }));

    expect(fetchImpl.calls).toHaveLength(1);
  });

  /**
   * The guard runs BEFORE validation: someone whose secret is in a shipped
   * bundle must be told that, not that their `appId` is empty.
   */
  it('reports the browser before any field-level complaint', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});

    const err = await signUserToken(
      { userId: '' },
      config({ appId: '', ttlSeconds: 99999 }),
    ).catch((e: unknown) => e);

    expect((err as Error).message).toContain('browser');
    expect((err as Error).message).not.toContain('appId is required');
  });
});

describe('signUserToken — config validation happens before any network call', () => {
  const cases: Array<{
    name: string;
    user: Parameters<typeof signUserToken>[0];
    over: Partial<Parameters<typeof signUserToken>[1]>;
  }> = [
    { name: 'missing appId', user: { userId: 'u' }, over: { appId: '' } },
    { name: 'missing appSecret', user: { userId: 'u' }, over: { appSecret: '' } },
    {
      name: 'a secret from the wrong credential family',
      user: { userId: 'u' },
      over: { appSecret: 'guuey_user_abc123' },
    },
    { name: 'an empty userId', user: { userId: '' }, over: {} },
    { name: 'an over-long userId', user: { userId: 'x'.repeat(257) }, over: {} },
    {
      name: 'an over-long name',
      user: { userId: 'u', name: 'x'.repeat(257) },
      over: {},
    },
    {
      name: 'an over-long email',
      user: { userId: 'u', email: 'x'.repeat(321) },
      over: {},
    },
    { name: 'a fractional ttlSeconds', user: { userId: 'u' }, over: { ttlSeconds: 1.5 } },
    { name: 'a zero ttlSeconds', user: { userId: 'u' }, over: { ttlSeconds: 0 } },
    {
      name: 'a ttlSeconds over the one-hour cap',
      user: { userId: 'u' },
      over: { ttlSeconds: 3601 },
    },
  ];

  for (const { name, user, over } of cases) {
    it(`rejects ${name} without calling fetch`, async () => {
      const fetchImpl = forbiddenFetch();
      await expect(
        signUserToken(user, config({ ...over, fetch: fetchImpl })),
      ).rejects.toBeInstanceOf(WidgetAuthConfigError);
      expect(fetchImpl.calls).toHaveLength(0);
    });
  }

  it('accepts the boundary values the server accepts', async () => {
    const fetchImpl = stubFetch({ status: 200 });
    await signUserToken(
      { userId: 'x'.repeat(256), name: 'y'.repeat(256), email: 'z'.repeat(320) },
      config({ ttlSeconds: 3600, fetch: fetchImpl }),
    );
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('reports a config error before the request is even built', async () => {
    const fetchImpl = forbiddenFetch();
    const err = await signUserToken(
      { userId: '' },
      config({ fetch: fetchImpl }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WidgetAuthConfigError);
    expect((err as WidgetAuthConfigError).retryable).toBe(false);
    expect((err as WidgetAuthConfigError).status).toBeUndefined();
  });
});

describe('signUserToken — status mapping', () => {
  const jsonOf = (body: unknown) => async () => body;

  it('maps 401 to a credential error that must not be retried', async () => {
    const fetchImpl = stubFetch({
      status: 401,
      json: jsonOf({
        error: { code: 'UNAUTHORIZED', message: 'Invalid or revoked widget app secret.' },
      }),
    });
    const err = await signUserToken({ userId: 'u' }, config({ fetch: fetchImpl })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WidgetAuthCredentialError);
    expect((err as WidgetAuthCredentialError).status).toBe(401);
    expect((err as WidgetAuthCredentialError).retryable).toBe(false);
  });

  it('maps 409 to an app-configuration error and keeps the fixing instruction', async () => {
    const fetchImpl = stubFetch({
      status: 409,
      json: jsonOf({
        error: {
          code: 'APP_NOT_CONFIGURED',
          message: 'This app’s end-user auth mode is not `byo`. Run `guuey widget keys create`.',
        },
      }),
    });
    const err = await signUserToken({ userId: 'u' }, config({ fetch: fetchImpl })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WidgetAuthAppNotConfiguredError);
    expect((err as WidgetAuthAppNotConfiguredError).retryable).toBe(false);
    expect((err as WidgetAuthAppNotConfiguredError).message).toContain(
      'guuey widget keys create',
    );
  });

  it('maps 400 to a request error naming the package as the suspect', async () => {
    const fetchImpl = stubFetch({
      status: 400,
      json: jsonOf({ error: { code: 'VALIDATION', message: 'appId is required.' } }),
    });
    const err = await signUserToken({ userId: 'u' }, config({ fetch: fetchImpl })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WidgetAuthRequestError);
    expect((err as WidgetAuthRequestError).retryable).toBe(false);
  });

  it.each([500, 502, 503, 504])('maps %i to a retryable service error', async (status) => {
    const fetchImpl = stubFetch({
      status,
      json: jsonOf({ error: { code: 'UPSTREAM', message: 'Token service could not mint.' } }),
    });
    const err = await signUserToken({ userId: 'u' }, config({ fetch: fetchImpl })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WidgetAuthServiceError);
    expect((err as WidgetAuthServiceError).status).toBe(status);
    expect((err as WidgetAuthServiceError).retryable).toBe(true);
  });

  it.each([403, 404, 418, 301])(
    'maps the unexpected status %i to a non-retryable service error',
    async (status) => {
      const fetchImpl = stubFetch({ status, json: jsonOf({}) });
      const err = await signUserToken({ userId: 'u' }, config({ fetch: fetchImpl })).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(WidgetAuthServiceError);
      expect((err as WidgetAuthServiceError).retryable).toBe(false);
    },
  );

  it('survives a non-JSON error body rather than throwing a parse error', async () => {
    const fetchImpl = stubFetch({
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });
    const err = await signUserToken({ userId: 'u' }, config({ fetch: fetchImpl })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WidgetAuthServiceError);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect((err as WidgetAuthServiceError).status).toBe(502);
  });

  it('maps a transport failure to a retryable network error', async () => {
    const cause = new Error('ECONNREFUSED');
    const fetchImpl: FetchLike = async () => {
      throw cause;
    };
    const err = await signUserToken({ userId: 'u' }, config({ fetch: fetchImpl })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WidgetAuthNetworkError);
    expect((err as WidgetAuthNetworkError).retryable).toBe(true);
    expect((err as WidgetAuthNetworkError).cause).toBe(cause);
  });

  it('reports a runtime with no global fetch as a config error naming Node 18', async () => {
    // Node 18 is the floor precisely because `fetch` became global there; on an
    // older runtime the failure would otherwise be a bare ReferenceError from
    // inside the package, which tells the customer nothing about the fix.
    vi.stubGlobal('fetch', undefined);
    try {
      await expect(
        signUserToken({ userId: 'u' }, { appId: APP_ID, appSecret: SECRET, apiBaseUrl: BASE }),
      ).rejects.toThrow(/Node 18/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * The T7 lesson, as a property: a customer's endpoint returning 500 — or HTML,
 * or a truncated body, or a 200 with nothing in it — must surface as an ERROR.
 * Never a token-shaped value the caller would hand to a browser.
 */
describe('signUserToken — never yields a garbage token', () => {
  const badResponses: Array<{ name: string; status: number; json: () => Promise<unknown> }> = [
    { name: 'a 500 with an HTML body', status: 500, json: async () => { throw new SyntaxError('bad json'); } },
    { name: 'a 502 that still carries a token field', status: 502, json: async () => ({ token: 'attacker-supplied' }) },
    { name: 'a 200 with an empty body', status: 200, json: async () => ({}) },
    { name: 'a 200 with a null body', status: 200, json: async () => null },
    { name: 'a 200 with a non-string token', status: 200, json: async () => ({ ...OK_BODY, token: 12345 }) },
    { name: 'a 200 missing expiresAtEpoch', status: 200, json: async () => ({ token: 'a.b.c', issuer: 'i', kid: 'k' }) },
    { name: 'a 200 with a string expiresAtEpoch', status: 200, json: async () => ({ ...OK_BODY, expiresAtEpoch: '1786000900' }) },
    { name: 'a 200 with an empty token string', status: 200, json: async () => ({ ...OK_BODY, token: '' }) },
    { name: 'a 200 whose body is an array', status: 200, json: async () => [OK_BODY] },
  ];

  for (const { name, status, json } of badResponses) {
    it(`rejects ${name}`, async () => {
      const fetchImpl = stubFetch({ status, json });
      const err = await signUserToken({ userId: 'u' }, config({ fetch: fetchImpl })).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(WidgetAuthError);
      // Whatever the failure, nothing token-shaped escapes to the caller.
      expect(err).not.toHaveProperty('token');
    });
  }

  it('never resolves when the response is unusable', async () => {
    const fetchImpl = stubFetch({ status: 200, json: async () => ({}) });
    const resolved = await signUserToken({ userId: 'u' }, config({ fetch: fetchImpl })).then(
      () => 'RESOLVED',
      () => 'REJECTED',
    );
    expect(resolved).toBe('REJECTED');
  });
});

/**
 * The app secret is a server-side credential whose whole value is that it is not
 * copied anywhere. An exception is the most likely place for it to escape —
 * straight into a log aggregator — so every error path is checked, including the
 * stack and a structured-logger-style serialization.
 */
describe('signUserToken — the app secret never reaches an error', () => {
  const paths: Array<{ name: string; run: () => Promise<unknown> }> = [
    {
      name: 'a config error',
      run: () => signUserToken({ userId: '' }, config({ fetch: forbiddenFetch() })),
    },
    {
      name: 'a wrong-family secret',
      run: () =>
        signUserToken(
          { userId: 'u' },
          config({ appSecret: `guuey_user_${SECRET}`, fetch: forbiddenFetch() }),
        ),
    },
    {
      name: 'a 401',
      run: () =>
        signUserToken(
          { userId: 'u' },
          config({ fetch: stubFetch({ status: 401, json: async () => ({}) }) }),
        ),
    },
    {
      name: 'a 502',
      run: () =>
        signUserToken(
          { userId: 'u' },
          config({ fetch: stubFetch({ status: 502, json: async () => ({}) }) }),
        ),
    },
    {
      name: 'a malformed 200',
      run: () =>
        signUserToken(
          { userId: 'u' },
          config({ fetch: stubFetch({ status: 200, json: async () => ({}) }) }),
        ),
    },
    {
      name: 'a transport failure',
      run: () =>
        signUserToken(
          { userId: 'u' },
          config({
            fetch: async () => {
              // A real transport error often quotes the request, headers and all.
              throw new Error(`connect failed: POST ${BASE} auth=Bearer ${SECRET}`);
            },
          }),
        ),
    },
  ];

  for (const { name, run } of paths) {
    it(`keeps the secret out of ${name}`, async () => {
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WidgetAuthError);

      const wire = [
        (err as Error).message,
        String(err),
        (err as Error).stack ?? '',
        JSON.stringify(err),
        JSON.stringify({ ...(err as object) }),
      ].join('\n');
      expect(wire).not.toContain(SECRET);
      // Not even the random tail on its own.
      expect(wire).not.toContain('LeakCanaryTail');
    });
  }

  /**
   * The browser refusal is the one error raised in a context where the secret is
   * already exposed. Its message is static today, so this cannot fail — which is
   * the point of pinning it: the next person to make that message more helpful
   * by interpolating the config gets caught here.
   */
  it('keeps the secret out of the browser refusal', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    try {
      const err = await signUserToken({ userId: 'u' }, config()).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(WidgetAuthConfigError);
      const wire = [
        (err as Error).message,
        String(err),
        (err as Error).stack ?? '',
        JSON.stringify(err),
      ].join('\n');
      expect(wire).not.toContain(SECRET);
      expect(wire).not.toContain('LeakCanaryTail');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not retain the secret on the error object', async () => {
    const err = await signUserToken(
      { userId: 'u' },
      config({ fetch: stubFetch({ status: 401, json: async () => ({}) }) }),
    ).catch((e: unknown) => e);

    for (const [, value] of Object.entries(err as object)) {
      expect(String(value)).not.toContain(SECRET);
    }
  });
});

describe('WidgetAuthError', () => {
  it('gives every error a stable name and a shared base for one catch clause', () => {
    const errors = [
      new WidgetAuthConfigError('x'),
      new WidgetAuthCredentialError('x', 401),
      new WidgetAuthAppNotConfiguredError('x', 409),
      new WidgetAuthRequestError('x', 400),
      new WidgetAuthServiceError('x', 502, true),
      new WidgetAuthNetworkError('x'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(WidgetAuthError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(err.constructor.name);
      expect(typeof err.retryable).toBe('boolean');
    }
  });

  it('survives instanceof across an async boundary', async () => {
    const caught = await Promise.reject(new WidgetAuthCredentialError('x', 401)).catch(
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(WidgetAuthCredentialError);
    expect(caught).toBeInstanceOf(WidgetAuthError);
  });
});
