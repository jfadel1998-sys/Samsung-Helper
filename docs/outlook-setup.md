# Outlook / Microsoft Graph setup

Everything here happens once, in the Azure portal, before the connector can be
used. Open question #2 in the spec applies: this needs the tenant that owns
Traxtone email, and app-registration rights in it. If Jason cannot register
apps, IT has to do steps 1–4.

## 1. Register the application

Azure Portal → **Microsoft Entra ID** → **App registrations** → **New registration**

- **Name:** Personal Ops Hub
- **Supported account types:** *Accounts in this organizational directory only*
  (single tenant — this is what M2 specifies; do not pick multitenant)
- **Redirect URI:** Web → `https://<your-app>.up.railway.app/api/auth/outlook/callback`

Copy from the Overview page:

- **Application (client) ID** → `MS_CLIENT_ID`
- **Directory (tenant) ID** → `MS_TENANT_ID`

## 2. Client secret

**Certificates & secrets** → **New client secret**. Copy the *Value* (not the
Secret ID) into `MS_CLIENT_SECRET`.

Secrets expire — 24 months maximum. Put the expiry in a calendar now: when it
lapses, every sync starts failing `invalid_client` and the account flips to
`reauth_required`.

## 3. API permissions

**API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated**:

- `Mail.Read`
- `offline_access`
- `User.Read`

Delegated, not Application. Application permissions would grant access to every
mailbox in the tenant; this app reads one mailbox, as its owner.

If the tenant requires admin consent, click **Grant admin consent** — otherwise
the first OAuth attempt dies at the consent screen.

## 4. Redirect URI must match exactly

`APP_BASE_URL` + `/api/auth/outlook/callback` has to equal the registered
redirect URI character for character, including scheme and any trailing path.
A mismatch fails at the callback with `AADSTS50011`.

## 5. Webhook client state

Generate the shared secret Graph echoes back in every notification:

```sh
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Set it as `GRAPH_WEBHOOK_CLIENT_STATE` on both services. The receiver at
`/api/webhooks/graph` compares it on every notification and ignores any that
does not match.

## 6. Connect

Visit `/` on the deployed app, sign in with `HUB_ACCESS_TOKEN`, and click
**Connect Outlook**. The callback enqueues a full sync, which backfills 30 days
and then creates the webhook subscription.

## Things that will bite

**Subscriptions expire in ~2.9 days.** Graph caps mail subscriptions at 4230
minutes. `renew-subscriptions` runs every 6h and renews anything inside 24h. If
renewal fails, the stored subscription id is cleared so the next sync recreates
it — and polling covers the gap either way.

**Graph validates the notification URL synchronously.** Creating a subscription
makes Graph POST `?validationToken=…` to `/api/webhooks/graph` and expect the
token echoed back as `text/plain` within seconds. If the web service is down or
the URL is not publicly reachable, subscription creation fails — the sync still
succeeds, it just falls back to polling.

**Never return 4xx from the webhook.** Graph disables subscriptions that error.
The receiver answers 202 even for notifications it rejects, and logs the
rejection instead.

**`internetMessageHeaders` is not guaranteed on collection responses.** Graph
returns it on single-message GETs reliably, and on delta/list responses only
sometimes. The normalizer records `headersAvailable` so the prefilter can tell
"this message has no List-Unsubscribe header" apart from "Graph did not tell us
either way" — a distinction that otherwise silently misclassifies newsletters
as actionable mail.

**Delta tokens go stale.** A 410 Gone (or a 400 with `SyncStateNotFound`)
becomes `CursorExpiredError`, and the sync job falls back to a bounded 30-day
full sync and re-seeds. This is an expected state, not an error.
