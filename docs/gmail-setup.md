# Gmail setup

> **Read §2.1 first.** `gmail.readonly` is a **restricted scope**. A Google
> Cloud project left in "Testing" publishing status issues refresh tokens that
> **expire after 7 days**. The hub will appear to work, then stop, and the
> failure is quiet — no error surfaces anywhere until the brief silently loses
> a mailbox.
>
> **This decision has to be made before the connector is used in anger.**

## Step 0 — the decision that determines everything else

**Is the Gmail account on Google Workspace, or is it a personal @gmail.com?**

| | Path | Cost |
|---|---|---|
| **Workspace** | Register the OAuth consent screen as **Internal**. No verification, no expiry. | Minutes. This is the correct path. |
| **Personal Gmail** | Publishing "In production" with a restricted scope triggers Google's CASA security assessment. | Paid, weeks. **Do not start without a decision from Jason.** |

If the answer is Workspace, follow this document. If it is a personal account,
stop and decide — Outlook works today and does not block on any of this.

## 1. Project and consent screen

1. Create (or pick) a Google Cloud project.
2. **APIs & Services → Library** → enable **Gmail API** and **Cloud Pub/Sub API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **Internal** ← the whole point of step 0
   - Fill in app name and support email
4. **Scopes** → add `https://www.googleapis.com/auth/gmail.readonly`.
   `openid` and `email` are added automatically and are not restricted.

If "Internal" is greyed out, the account is not on Workspace. Go back to step 0.

## 2. OAuth client

**Credentials → Create credentials → OAuth client ID → Web application**

- Authorized redirect URI: `https://<your-app>.up.railway.app/api/auth/gmail/callback`

Copy into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. The redirect URI must
match `APP_BASE_URL` + `/api/auth/gmail/callback` exactly.

## 3. Pub/Sub topic and push subscription

`users.watch()` publishes change notifications to a Pub/Sub topic, which pushes
to our webhook.

```sh
gcloud pubsub topics create gmail-push

# Gmail's own service account must be allowed to publish to the topic.
# This exact address is correct for every project — it is Google's, not yours.
gcloud pubsub topics add-iam-policy-binding gmail-push \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher

# The service account that signs push requests to our endpoint.
gcloud iam service-accounts create gmail-push \
  --display-name="Gmail push to Ops Hub"

gcloud pubsub subscriptions create gmail-push-sub \
  --topic=gmail-push \
  --push-endpoint=https://<your-app>.up.railway.app/api/webhooks/gmail \
  --push-auth-service-account=gmail-push@<project>.iam.gserviceaccount.com
```

Then set:

- `GOOGLE_PUBSUB_TOPIC=projects/<project>/topics/gmail-push`
- `GOOGLE_PUBSUB_SERVICE_ACCOUNT=gmail-push@<project>.iam.gserviceaccount.com`

The receiver verifies the push JWT against Google's public keys **and** checks
that it was signed by this exact service account. A valid Google-signed token
from someone else's project is rejected — the endpoint is public, so signature
alone is not authorization.

## 4. Connect

Visit `/`, sign in, click **Connect Gmail**. The callback enqueues a full sync
that backfills 30 days, reads the mailbox `historyId` as the cursor, and calls
`users.watch()`.

## Things that will bite

**The 7-day refresh token.** Covered above, and worth repeating because the
failure is invisible: an app in "Testing" issues refresh tokens that die after
a week. When that happens the connector raises `ReauthRequiredError` with a
message naming this cause, the account flips to `reauth_required`, and it
appears on `/ops`. If a mailbox needs reconnecting weekly, this is why.

**`users.watch()` expires after 7 days.** Renewed daily by
`renew-subscriptions`, not weekly — a lapsed watch stops all push notification
with no error anywhere. Polling still covers ingestion either way.

**`historyId` is valid for roughly 7 days.** An older cursor returns 404 from
`history.list`. That is expected, not an error: it becomes `CursorExpiredError`
and falls back to a bounded 30-day full sync that re-seeds the cursor.

**No refresh token on reconnect.** Google issues one only on first consent,
which is why the auth URL sends `access_type=offline&prompt=consent`. If a
connection still arrives without one, the callback refuses it rather than
storing a connection that dies in an hour. Revoke at
<https://myaccount.google.com/permissions> and reconnect.

**Quota is measured in units, not requests.** `messages.get` costs 5 units
against a per-user-per-second ceiling, so syncs run at concurrency 1 per
account and cap at 250 messages per run, resuming via `hasMore`.
