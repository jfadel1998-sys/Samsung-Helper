import { env } from '@hub/config';
import type { Connector, NormalizedEvent } from '../types';
import { exchangeCode, getAuthUrl, OUTLOOK_PROVIDER, OUTLOOK_SCOPES, refresh } from './auth';
import { normalizeOutlook } from './normalize';
import { deltaSync, fullSync } from './sync';
import { renew, subscribe, unsubscribe } from './webhook';

export const outlookConnector: Connector = {
  provider: OUTLOOK_PROVIDER,
  scopes: OUTLOOK_SCOPES,
  getAuthUrl,
  exchangeCode,
  refresh,
  fullSync,
  deltaSync,
  subscribe,
  renew,
  unsubscribe,
  normalize: (raw: unknown): NormalizedEvent[] => normalizeOutlook(raw, env.ownerEmails),
};

export * from './auth';
export * from './normalize';
export * from './sync';
export * from './webhook';
