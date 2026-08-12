import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeFetch, type FakeFetch } from './helpers/fake-fetch';
import { CursorExpiredError, ReauthRequiredError, type SyncCtx } from '../src/types';
import { refresh } from '../src/gmail/auth';
import { deltaSync, fullSync } from '../src/gmail/sync';
import { renew, subscribe } from '../src/gmail/webhook';

const ENV = {
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GOOGLE_PUBSUB_TOPIC: 'projects/ops-hub/topics/gmail-push',
  GOOGLE_PUBSUB_SERVICE_ACCOUNT: 'gmail-push@ops-hub.iam.gserviceaccount.com',
  APP_BASE_URL: 'https://hub.example.com',
  OWNER_EMAILS: 'jason@traxtone.com',
  HUB_ACCESS_TOKEN: 'hub-token',
};

let fake: FakeFetch | undefined;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function ctx(over: Partial<SyncCtx> = {}): SyncCtx {
  return {
    accountId: 'acct-gmail',
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

function gmailMessage(id: string) {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds: ['INBOX'],
    internalDate: '1786120931000',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'supplier@example-supplier.it' },
        { name: 'To', value: 'jason@traxtone.com' },
        { name: 'Subject', value: `2269.2 message ${id}` },
      ],
      body: { data: b64(`body of ${id}`) },
    },
  };
}

beforeEach(() => {
  Object.assign(process.env, ENV);
});

afterEach(() => {
  fake?.restore();
  fake = undefined;
});

describe('gmail deltaSync', () => {
  it('collects messagesAdded ids, fetches them, and advances the cursor', async () => {
    fake = installFakeFetch([
      {
        match: '/history?startHistoryId=1000',
        body: {
          history: [
            { id: '1001', messagesAdded: [{ message: { id: 'm1' } }] },
            { id: '1002', messagesAdded: [{ message: { id: 'm2' } }] },
          ],
          historyId: '1002',
        },
      },
      { match: '/messages/m1', body: gmailMessage('m1') },
      { match: '/messages/m2', body: gmailMessage('m2') },
    ]);

    const result = await deltaSync(ctx({ cursor: '1000' }));

    expect(result.events.map((e) => e.externalId)).toEqual(['m1', 'm2']);
    expect(result.nextCursor).toBe('1002');
    expect(result.hasMore).toBe(false);
  });

  it('deduplicates a message that appears in several history entries', async () => {
    fake = installFakeFetch([
      {
        match: '/history?',
        body: {
          history: [
            { id: '1001', messagesAdded: [{ message: { id: 'm1' } }] },
            { id: '1002', messagesAdded: [{ message: { id: 'm1' } }] },
          ],
          historyId: '1002',
        },
      },
      { match: '/messages/m1', body: gmailMessage('m1') },
    ]);

    const result = await deltaSync(ctx({ cursor: '1000' }));
    expect(result.events).toHaveLength(1);
    expect(fake.calls.filter((c) => c.url.includes('/messages/m1'))).toHaveLength(1);
  });

  // §2.3 + M3 acceptance: prove the cursor-expiry path by corrupting historyId.
  it('converts a 404 from history.list into CursorExpiredError', async () => {
    fake = installFakeFetch([
      {
        match: '/history?',
        status: 404,
        body: { error: { code: 404, message: 'Requested entity was not found.' } },
      },
    ]);

    await expect(deltaSync(ctx({ cursor: '999999999999' }))).rejects.toThrow(CursorExpiredError);
  });

  it('converts a 400 naming historyId into CursorExpiredError', async () => {
    fake = installFakeFetch([
      {
        match: '/history?',
        status: 400,
        body: { error: { message: 'Invalid startHistoryId', status: 'FAILED_PRECONDITION' } },
      },
    ]);

    await expect(deltaSync(ctx({ cursor: 'corrupted-cursor' }))).rejects.toThrow(
      CursorExpiredError,
    );
  });

  it('treats a missing cursor as expired', async () => {
    await expect(deltaSync(ctx({ cursor: null }))).rejects.toThrow(CursorExpiredError);
  });

  it('does not mistake an unrelated failure for cursor expiry', async () => {
    fake = installFakeFetch([
      { match: '/history?', status: 403, body: { error: { message: 'Insufficient permission' } } },
    ]);

    const err = await deltaSync(ctx({ cursor: '1000' })).catch((e) => e);
    expect(err).not.toBeInstanceOf(CursorExpiredError);
    expect(String(err)).toContain('403');
  });

  it('skips a message deleted between listing and fetching', async () => {
    fake = installFakeFetch([
      {
        match: '/history?',
        body: {
          history: [
            { id: '1001', messagesAdded: [{ message: { id: 'gone' } }] },
            { id: '1002', messagesAdded: [{ message: { id: 'm2' } }] },
          ],
          historyId: '1002',
        },
      },
      { match: '/messages/gone', status: 404, body: { error: { code: 404 } } },
      { match: '/messages/m2', body: gmailMessage('m2') },
    ]);

    const result = await deltaSync(ctx({ cursor: '1000' }));
    expect(result.events.map((e) => e.externalId)).toEqual(['m2']);
  });

  it('returns an empty result when nothing changed', async () => {
    fake = installFakeFetch([{ match: '/history?', body: { historyId: '1000' } }]);
    const result = await deltaSync(ctx({ cursor: '1000' }));
    expect(result.events).toEqual([]);
    expect(result.nextCursor).toBe('1000');
  });
});

describe('gmail fullSync', () => {
  it('seeds the cursor from the profile before listing', async () => {
    fake = installFakeFetch([
      { match: '/profile', body: { emailAddress: 'jason@traxtone.com', historyId: '55555' } },
      { match: '/messages?q=', body: { messages: [{ id: 'm1' }, { id: 'm2' }] } },
      { match: '/messages/m1', body: gmailMessage('m1') },
      { match: '/messages/m2', body: gmailMessage('m2') },
    ]);

    const result = await fullSync(ctx(), { since: new Date(Date.now() - 30 * 86_400_000) });

    expect(result.events.map((e) => e.externalId)).toEqual(['m1', 'm2']);
    expect(result.nextCursor).toBe('55555');

    const listCall = fake.calls.find((c) => c.url.includes('/messages?q='))!;
    expect(decodeURIComponent(listCall.url)).toContain('in:inbox newer_than:30d');
  });

  it('still backfills when the profile read fails', async () => {
    fake = installFakeFetch([
      { match: '/profile', status: 500, body: { error: { message: 'boom' } } },
      { match: '/messages?q=', body: { messages: [{ id: 'm1' }] } },
      { match: '/messages/m1', body: gmailMessage('m1') },
    ]);

    const result = await fullSync(ctx(), { since: new Date(Date.now() - 30 * 86_400_000) });
    expect(result.events).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it('is bounded and reports hasMore rather than paging forever', async () => {
    const page = {
      messages: Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` })),
      nextPageToken: 'MORE',
    };
    fake = installFakeFetch([
      { match: '/profile', body: { historyId: '1' } },
      { match: '/messages?q=', body: page },
      { match: /\/messages\/m\d+/, body: gmailMessage('mX') },
    ]);

    const result = await fullSync(ctx(), { since: new Date(Date.now() - 30 * 86_400_000) });
    expect(result.hasMore).toBe(true);
  });
});

describe('gmail token refresh', () => {
  it('names the §2.1 7-day trap when Google returns invalid_grant', async () => {
    fake = installFakeFetch([
      {
        match: 'oauth2.googleapis.com/token',
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      },
    ]);

    const err = await refresh({ accessToken: 'a', refreshToken: 'dead' }).catch((e) => e);
    expect(err).toBeInstanceOf(ReauthRequiredError);
    // The message has to point at the actual cause, or this failure looks
    // like a mystery every time it happens.
    expect(String(err)).toMatch(/Testing/);
    expect(String(err)).toMatch(/7 days/);
    // No retry storm.
    expect(fake.calls.filter((c) => c.url.includes('/token'))).toHaveLength(1);
  });

  it('raises ReauthRequiredError when no refresh token is stored', async () => {
    await expect(refresh({ accessToken: 'a' })).rejects.toThrow(ReauthRequiredError);
  });

  it('keeps the stored refresh token when Google omits it', async () => {
    fake = installFakeFetch([
      {
        match: 'oauth2.googleapis.com/token',
        body: { access_token: 'fresh', expires_in: 3599, token_type: 'Bearer' },
      },
    ]);

    const out = await refresh({ accessToken: 'old', refreshToken: 'keep-me' });
    expect(out.accessToken).toBe('fresh');
    expect(out.refreshToken).toBe('keep-me');
  });
});

describe('gmail watch', () => {
  it('watches the INBOX label on the configured topic', async () => {
    const expiration = String(Date.now() + 7 * 86_400_000);
    fake = installFakeFetch([
      { match: '/watch', method: 'POST', body: { historyId: '1234', expiration } },
    ]);

    const result = await subscribe(ctx());
    expect(result.id).toBe(ENV.GOOGLE_PUBSUB_TOPIC);
    expect(result.expiresAt.getTime()).toBe(Number(expiration));

    const sent = JSON.parse(fake.calls[0]!.body!) as {
      topicName: string;
      labelIds: string[];
      labelFilterBehavior: string;
    };
    expect(sent.topicName).toBe(ENV.GOOGLE_PUBSUB_TOPIC);
    expect(sent.labelIds).toEqual(['INBOX']);
    expect(sent.labelFilterBehavior).toBe('INCLUDE');
  });

  it('renews by calling watch again', async () => {
    const expiration = String(Date.now() + 7 * 86_400_000);
    fake = installFakeFetch([
      { match: '/watch', method: 'POST', body: { historyId: '1', expiration } },
    ]);

    const { expiresAt } = await renew(ctx({ subscriptionId: ENV.GOOGLE_PUBSUB_TOPIC }));
    expect(expiresAt.getTime()).toBe(Number(expiration));
  });

  it('falls back to a 7-day expiry when Google omits one', async () => {
    fake = installFakeFetch([{ match: '/watch', method: 'POST', body: { historyId: '1' } }]);
    const { expiresAt } = await subscribe(ctx());
    const days = (expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
  });
});
