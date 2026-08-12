import { env } from '@hub/config';
import type { Connector, NormalizedEvent } from '../types';
import { exchangeCode, getAuthUrl, GMAIL_PROVIDER, GMAIL_SCOPES, refresh } from './auth';
import { normalizeGmail } from './normalize';
import { deltaSync, fullSync } from './sync';
import { renew, subscribe, unsubscribe } from './webhook';

export const gmailConnector: Connector = {
  provider: GMAIL_PROVIDER,
  scopes: GMAIL_SCOPES,
  getAuthUrl,
  exchangeCode,
  refresh,
  fullSync,
  deltaSync,
  subscribe,
  renew,
  unsubscribe,
  normalize: (raw: unknown): NormalizedEvent[] => normalizeGmail(raw, env.ownerEmails),
};

export * from './auth';
export * from './normalize';
export * from './sync';
export * from './webhook';
