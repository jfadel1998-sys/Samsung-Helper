import type { OAuthTokens } from '@hub/crypto';

export type { OAuthTokens };

/**
 * Provider-agnostic event. Every connector — including the RSS / social /
 * Replit connectors in later phases — produces these, and nothing downstream
 * of `normalize` knows which provider a row came from.
 */
export interface NormalizedEvent {
  source: string;
  type: 'email' | 'article' | 'comment' | 'job_result';
  externalId: string;
  threadId: string | null;
  actorName: string | null;
  actorHandle: string | null;
  subject: string | null;
  /** Normalized plaintext. Capped at 4000 chars on write. */
  bodyExcerpt: string | null;
  url: string | null;
  occurredAt: Date;
  isFromOwner: boolean;
  raw: unknown;
  /**
   * Everything the deterministic prefilter (§7.1) needs, lifted out of the
   * provider payload at normalize time so the prefilter stays provider-blind.
   */
  signals: PrefilterSignals;
}

export interface PrefilterSignals {
  /** List-Unsubscribe header present. */
  listUnsubscribe: boolean;
  /** Auto-Submitted header present and not 'no' — bounces, OOO, robots. */
  autoSubmitted: boolean;
  /** Gmail category labels (CATEGORY_PROMOTIONS etc). Empty for Graph. */
  categories: string[];
  toAddresses: string[];
  ccAddresses: string[];
  /** True when the payload carried no body text at all (bare calendar invites). */
  emptyBody: boolean;
  /**
   * False when the provider did not return internet headers on this payload,
   * so header-based rules must not be read as "header absent".
   */
  headersAvailable: boolean;
}

export interface SyncResult {
  events: NormalizedEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Everything a sync needs, supplied by the worker. */
export interface SyncCtx {
  accountId: string;
  tokens: OAuthTokens;
  /** Stored cursor: gmail historyId | graph deltaLink. */
  cursor: string | null;
  subscriptionId: string | null;
  /** Persist refreshed tokens. Called by the connector after a token refresh. */
  saveTokens: (tokens: OAuthTokens) => Promise<void>;
  /** Public https origin, for webhook callback URLs. */
  baseUrl: string;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface Connector {
  readonly provider: string;
  readonly scopes: string[];

  getAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<{
    tokens: OAuthTokens;
    externalId: string;
    email?: string;
    displayName?: string;
  }>;
  refresh(tokens: OAuthTokens): Promise<OAuthTokens>;

  /** Bounded backfill. Must be safely re-runnable. */
  fullSync(ctx: SyncCtx, opts: { since: Date }): Promise<SyncResult>;

  /** Incremental via stored cursor. Throws CursorExpiredError to trigger fullSync. */
  deltaSync(ctx: SyncCtx): Promise<SyncResult>;

  subscribe(ctx: SyncCtx): Promise<{ id: string; expiresAt: Date }>;
  renew(ctx: SyncCtx): Promise<{ expiresAt: Date }>;
  unsubscribe(ctx: SyncCtx): Promise<void>;

  /** Provider payload -> NormalizedEvent[]. Pure function, unit tested. */
  normalize(raw: unknown): NormalizedEvent[];
}

/**
 * The stored cursor is too old to be useful. The caller must fall back to a
 * bounded full sync and re-seed (§2.3 for Gmail, Graph 410 for Outlook).
 */
export class CursorExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorExpiredError';
  }
}

/**
 * The refresh token is dead. §8: set status='reauth_required' and stop
 * retrying — a retry storm against invalid_grant helps nobody.
 */
export class ReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    /** Seconds, from Retry-After when the provider supplies it. */
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}
