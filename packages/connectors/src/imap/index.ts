import { env } from '@hub/config';
import type { Connector, Credentials, NormalizedEvent, SyncCtx } from '../types';
import {
  IMAP_PROVIDER,
  IMAP_SCOPES,
  refresh,
  resolveCredentials,
  toTokens,
} from './auth';
import { normalizeImap } from './normalize';
import { deltaSync, fullSync, verifyConnection } from './sync';

export const imapConnector: Connector = {
  provider: IMAP_PROVIDER,
  scopes: IMAP_SCOPES,
  authKind: 'credentials',
  // IMAP IDLE needs a socket held open indefinitely, which does not fit a
  // job-queue architecture. Polling every 30 min is the §2.2 mandated fallback
  // and is the whole story here — declared honestly rather than faked with a
  // synthetic subscription that /ops would render as healthy.
  supportsWebhooks: false,

  async connect(credentials: Credentials) {
    const creds = resolveCredentials(credentials);
    // Verify before storing — otherwise a typo produces an account that fails
    // silently on its first scheduled sync instead of at the moment of entry.
    await verifyConnection(creds);
    return {
      tokens: toTokens(creds),
      externalId: `${creds.host}:${creds.username}`,
      email: creds.username,
      displayName: creds.username,
    };
  },

  refresh,
  fullSync,
  deltaSync,

  async subscribe(_ctx: SyncCtx) {
    throw new Error('IMAP has no push mechanism; this connector is poll-only');
  },
  async renew(_ctx: SyncCtx) {
    throw new Error('IMAP has no push mechanism; this connector is poll-only');
  },
  async unsubscribe(_ctx: SyncCtx) {
    // Nothing to tear down.
  },

  normalize: (raw: unknown): NormalizedEvent[] => normalizeImap(raw, env.ownerEmails),
};

export * from './auth';
export * from './normalize';
export * from './sync';
