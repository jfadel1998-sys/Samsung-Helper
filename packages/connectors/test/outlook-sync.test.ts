import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeFetch, type FakeFetch } from './helpers/fake-fetch';
import { CursorExpiredError, RateLimitError, ReauthRequiredError, type SyncCtx } from '../src/types';
import { refresh } from '../src/outlook/auth';
import { deltaSync, fullSync } from '../src/outlook/sync';
import { GRAPH_MAX_MINUTES, renew, subscribe, unsubscribe, validateNotifications } from '../src/outlook/webhook';

const ENV = {
  MS_CLIENT_ID: 'client-id',
  MS_CLIENT_SECRET: 'client-secret',
  MS_TENANT_ID: 'tenant-id',
  GRAPH_WEBHOOK_CLIENT_STATE: 'client-state-secret',
  APP_BASE_URL: 'https://hub.example.com',
  OWNER_EMAILS: 'jason@traxtone.com',
  HUB_ACCESS_TOKEN: 'hub-token',
};

let fake: FakeFetch | undefined;

function ctx(over: Partial<SyncCtx> = {}): SyncCtx {
  return {
    accountId: 'acct-1',
    tokens: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
    },
    cursor: null,
    subscriptionId: null,
    baseUrl: ENV.APP_BASE_URL,
    saveTokens: vi.fn(async () => {}),
    log: () => {},
    ...over,
  };
}

const MESSAGE = {
  id: 'msg-1',
  conversationId: 'conv-1',
  subject: '2269.2 pricing',
  body: { contentType: 'text', content: 'Revised pricing attached.' },
  from: { emailAddress: { name: 'T. Nickolas', address: 't.nickolas@example-supplier.com' } },
  toRecipients: [{ emailAddress: { address: 'jason@traxtone.com' } }],
  receivedDateTime: '2026-08-10T16:42:11Z',
  isDraft: false,
};

beforeEach(() => {
  Object.assign(process.env, ENV);
});

afterEach(() => {
  fake?.restore();
  fake = undefined;
});

describe('outlook deltaSync', () => {
  it('pages through nextLink and returns the deltaLink as the cursor', async () => {

    fake = installFakeFetch([
      {
        match: '$deltatoken=PAGE1',
        body: {
          value: [MESSAGE],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/…/delta?$skiptoken=PAGE2',
        },
      },
      {
        match: '$skiptoken=PAGE2',
        body: {
          value: [{ ...MESSAGE, id: 'msg-2' }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/…/delta?$deltatoken=FINAL',
        },
      },
    ]);

    const result = await deltaSync(
      ctx({ cursor: 'https://graph.microsoft.com/v1.0/me/…/delta?$deltatoken=PAGE1' }),
    );

    expect(result.events.map((e) => e.externalId)).toEqual(['msg-1', 'msg-2']);
    expect(result.nextCursor).toContain('$deltatoken=FINAL');
    expect(result.hasMore).toBe(false);
  });

  it('treats a missing cursor as expired so the caller backfills', async () => {
    await expect(deltaSync(ctx({ cursor: null }))).rejects.toThrow(CursorExpiredError);
  });

  // §11: simulate Graph 410 Gone, assert clean fallback to full sync.
  it('converts 410 Gone into CursorExpiredError', async () => {
    fake = installFakeFetch([
      {
        match: 'delta',
        status: 410,
        body: { error: { code: 'resyncRequired', message: 'delta token expired' } },
      },
    ]);

    await expect(deltaSync(ctx({ cursor: `https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta?$deltatoken=STALE` }))).rejects.toThrow(
      CursorExpiredError,
    );
  });

  it('converts a 400 syncStateNotFound into CursorExpiredError', async () => {
    fake = installFakeFetch([
      {
        match: 'delta',
        status: 400,
        body: { error: { code: 'SyncStateNotFound', message: 'bad token' } },
      },
    ]);

    await expect(deltaSync(ctx({ cursor: `https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta?$deltatoken=CORRUPT` }))).rejects.toThrow(CursorExpiredError);
  });

  it('does not swallow an unrelated error as a cursor problem', async () => {
    fake = installFakeFetch([
      { match: 'delta', status: 403, body: { error: { code: 'ErrorAccessDenied' } } },
    ]);

    const err = await deltaSync(ctx({ cursor: `https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta?$deltatoken=X` })).catch((e) => e);
    expect(err).not.toBeInstanceOf(CursorExpiredError);
    expect(String(err)).toContain('403');
  });

  it('surfaces 429 with Retry-After instead of retrying inline', async () => {

    fake = installFakeFetch([
      { match: 'delta', status: 429, headers: { 'retry-after': '90' }, body: {} },
    ]);

    const err = await deltaSync(ctx({ cursor: `https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta?$deltatoken=X` })).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as InstanceType<typeof RateLimitError>).retryAfterSeconds).toBe(90);
    // One attempt only — a held-open retry loop is not how we wait out a limit.
    expect(fake.calls.filter((c) => c.url.includes('delta'))).toHaveLength(1);
  });

  it('stops paging at the bound and reports hasMore', async () => {
    // Every page returns another nextLink; the run must terminate anyway.
    fake = installFakeFetch([
      {
        match: 'delta',
        body: {
          value: [MESSAGE],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/…/delta?$skiptoken=NEXT',
        },
      },
    ]);

    const result = await deltaSync(ctx({ cursor: 'https://graph.microsoft.com/…/delta?x=1' }));
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toContain('$skiptoken=NEXT');
  });
});

describe('outlook fullSync', () => {
  it('seeds the cursor from $deltatoken=latest before backfilling', async () => {

    fake = installFakeFetch([
      {
        match: '$deltatoken=latest',
        body: {
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/…/delta?$deltatoken=SEEDED',
        },
      },
      { match: '$filter=', body: { value: [MESSAGE, { ...MESSAGE, id: 'msg-2' }] } },
    ]);

    const result = await fullSync(ctx(), { since: new Date('2026-07-11T00:00:00Z') });

    expect(result.events.map((e) => e.externalId)).toEqual(['msg-1', 'msg-2']);
    expect(result.nextCursor).toContain('$deltatoken=SEEDED');
    expect(result.hasMore).toBe(false);

    const backfill = fake.calls.find((c) => c.url.includes('$filter='))!;
    expect(decodeURIComponent(backfill.url)).toContain('receivedDateTime ge 2026-07-11T00:00:00');
  });

  it('still backfills when the delta seed fails', async () => {

    fake = installFakeFetch([
      { match: '$deltatoken=latest', status: 500, body: { error: { code: 'boom' } } },
      { match: '$filter=', body: { value: [MESSAGE] } },
    ]);

    const result = await fullSync(ctx(), { since: new Date('2026-07-11T00:00:00Z') });
    expect(result.events).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });
});

describe('outlook token refresh', () => {
  // §11: simulate invalid_grant, assert reauth is signalled and we stop.
  it('raises ReauthRequiredError on invalid_grant', async () => {

    fake = installFakeFetch([
      {
        match: '/oauth2/v2.0/token',
        status: 400,
        body: { error: 'invalid_grant', error_description: 'AADSTS70008: expired' },
      },
    ]);

    await expect(
      refresh({ accessToken: 'a', refreshToken: 'dead' }),
    ).rejects.toThrow(ReauthRequiredError);

    // No retry storm: a revoked grant is retried exactly zero extra times.
    expect(fake.calls.filter((c) => c.url.includes('/token'))).toHaveLength(1);
  });

  it('raises ReauthRequiredError when no refresh token is stored', async () => {
    await expect(refresh({ accessToken: 'a' })).rejects.toThrow(ReauthRequiredError);
  });

  it('keeps the existing refresh token when Azure does not reissue one', async () => {

    fake = installFakeFetch([
      {
        match: '/oauth2/v2.0/token',
        body: { access_token: 'new-access', expires_in: 3600, token_type: 'Bearer' },
      },
    ]);

    const out = await refresh({ accessToken: 'old', refreshToken: 'keep-me', scope: 'Mail.Read' });
    expect(out.accessToken).toBe('new-access');
    expect(out.refreshToken).toBe('keep-me');
    expect(out.expiresAt).toBeGreaterThan(Date.now());
  });

  it('refreshes an expiring token mid-sync and persists it', async () => {

    fake = installFakeFetch([
      {
        match: '/oauth2/v2.0/token',
        body: { access_token: 'refreshed-token', refresh_token: 'r2', expires_in: 3600 },
      },
      {
        match: 'delta',
        body: { value: [MESSAGE], '@odata.deltaLink': 'https://graph…/delta?$deltatoken=F' },
      },
    ]);

    const saveTokens = vi.fn(async () => {});
    await deltaSync(
      ctx({
        cursor: 'https://graph.microsoft.com/v1.0/me/…/delta?$deltatoken=OLD',
        // Already expired -> must refresh before calling Graph.
        tokens: { accessToken: 'stale', refreshToken: 'r1', expiresAt: Date.now() - 1000 },
        saveTokens,
      }),
    );

    expect(saveTokens).toHaveBeenCalledOnce();
    const graphCall = fake.calls.find((c) => c.url.includes('delta'))!;
    expect(graphCall).toBeDefined();
  });
});

describe('graph webhook subscription', () => {
  it('requests an expiry inside the documented maximum', async () => {

    fake = installFakeFetch([
      {
        match: '/subscriptions',
        method: 'POST',
        body: { id: 'sub-1', expirationDateTime: '2026-08-13T12:00:00Z' },
      },
    ]);

    const result = await subscribe(ctx());
    expect(result.id).toBe('sub-1');

    const sent = JSON.parse(fake.calls[0]!.body!) as {
      expirationDateTime: string;
      clientState: string;
      notificationUrl: string;
      resource: string;
    };
    const minutes = (Date.parse(sent.expirationDateTime) - Date.now()) / 60_000;
    expect(minutes).toBeLessThan(GRAPH_MAX_MINUTES);
    expect(minutes).toBeGreaterThan(GRAPH_MAX_MINUTES - 60);
    expect(sent.clientState).toBe(ENV.GRAPH_WEBHOOK_CLIENT_STATE);
    expect(sent.notificationUrl).toBe('https://hub.example.com/api/webhooks/graph');
    expect(sent.resource).toContain('inbox');
  });

  it('renews by PATCHing a new expiry', async () => {

    fake = installFakeFetch([
      {
        match: '/subscriptions/sub-1',
        method: 'PATCH',
        body: { id: 'sub-1', expirationDateTime: '2026-08-14T12:00:00Z' },
      },
    ]);

    const { expiresAt } = await renew(ctx({ subscriptionId: 'sub-1' }));
    expect(expiresAt.toISOString()).toBe('2026-08-14T12:00:00.000Z');
    expect(fake.calls[0]!.method).toBe('PATCH');
  });

  it('treats a failed unsubscribe as already gone', async () => {
    fake = installFakeFetch([
      { match: '/subscriptions/sub-1', method: 'DELETE', status: 404, body: {} },
    ]);
    await expect(unsubscribe(ctx({ subscriptionId: 'sub-1' }))).resolves.toBeUndefined();
  });
});

describe('graph notification validation (§9)', () => {
  it('accepts notifications carrying the expected clientState', async () => {
    const { valid, rejected } = validateNotifications(
      {
        value: [
          { subscriptionId: 'sub-1', clientState: 'secret', resourceData: { id: 'm1' } },
          { subscriptionId: 'sub-1', clientState: 'secret', resourceData: { id: 'm2' } },
        ],
      },
      'secret',
    );
    expect(valid).toHaveLength(2);
    expect(rejected).toBe(0);
  });

  it('rejects a forged or missing clientState', async () => {
    const { valid, rejected } = validateNotifications(
      {
        value: [
          { subscriptionId: 'sub-1', clientState: 'wrong' },
          { subscriptionId: 'sub-1' },
          { subscriptionId: 'sub-1', clientState: 'secret' },
        ],
      },
      'secret',
    );
    expect(valid).toHaveLength(1);
    expect(rejected).toBe(2);
  });

  it('returns nothing for junk payloads rather than throwing', async () => {
    for (const junk of [null, undefined, {}, { value: 'nope' }, 42]) {
      expect(validateNotifications(junk, 'secret')).toEqual({ valid: [], rejected: 0 });
    }
  });
});
