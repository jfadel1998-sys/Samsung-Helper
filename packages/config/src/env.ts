/**
 * Typed environment access.
 *
 * Everything is read lazily. A Next.js route that never touches Gmail must not
 * crash at import time because GOOGLE_CLIENT_SECRET is unset — the missing-var
 * error should surface at the point of use, naming the variable.
 */

export function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

export function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function csv(name: string): string[] {
  return optional(name)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const env = {
  get databaseUrl() {
    return required('DATABASE_URL');
  },
  get tokenEncryptionKey() {
    return required('TOKEN_ENCRYPTION_KEY');
  },
  /** Previous keys, newest first. Used for decrypt-only during key rotation (§9). */
  get tokenEncryptionKeyPrevious() {
    return optional('TOKEN_ENCRYPTION_KEY_PREVIOUS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  },
  get anthropicApiKey() {
    return required('ANTHROPIC_API_KEY');
  },
  /** Public https origin — OAuth redirects and webhook callbacks are built from this. */
  get appBaseUrl() {
    return required('APP_BASE_URL').replace(/\/$/, '');
  },
  /** Single shared secret gating the whole web UI (§9 — no multi-tenant auth). */
  get hubAccessToken() {
    return required('HUB_ACCESS_TOKEN');
  },

  /** Every address that counts as "the owner" for To/Cc and is_from_owner checks. */
  get ownerEmails() {
    return csv('OWNER_EMAILS');
  },
  get briefTimezone() {
    return optional('BRIEF_TIMEZONE', 'America/Los_Angeles');
  },

  microsoft: {
    get clientId() {
      return required('MS_CLIENT_ID');
    },
    get clientSecret() {
      return required('MS_CLIENT_SECRET');
    },
    /** Single-tenant (§M2) — the Traxtone directory id, not "common". */
    get tenantId() {
      return required('MS_TENANT_ID');
    },
    get webhookClientState() {
      return required('GRAPH_WEBHOOK_CLIENT_STATE');
    },
  },

  google: {
    get clientId() {
      return required('GOOGLE_CLIENT_ID');
    },
    get clientSecret() {
      return required('GOOGLE_CLIENT_SECRET');
    },
    /** projects/<project>/topics/<topic> */
    get pubsubTopic() {
      return required('GOOGLE_PUBSUB_TOPIC');
    },
    /** Service account that Pub/Sub signs push JWTs with. */
    get pubsubServiceAccount() {
      return required('GOOGLE_PUBSUB_SERVICE_ACCOUNT');
    },
  },

  delivery: {
    get resendApiKey() {
      return optional('RESEND_API_KEY');
    },
    get fromAddress() {
      return optional('BRIEF_FROM_ADDRESS');
    },
    get toAddress() {
      return optional('BRIEF_TO_ADDRESS');
    },
  },
} as const;

export function isOwnerAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  return env.ownerEmails.includes(address.trim().toLowerCase());
}
