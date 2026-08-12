# Personal Ops Hub

Ingests Outlook and Gmail into one event store and produces a daily 7:00 AM
brief tuned to stone-import project management.

The brief is supposed to read like this:

> **2269.2 GVR Local Stone** — T. Nickolas confirmed revised pricing on 12 line
> items. Moet still waiting on FOB clarification from the supplier (3 days open).

not like "you have 14 unread emails." If it ever reads like the second one, the
extraction layer is wrong — that is the whole product.

## Layout

```
apps/web            Next.js — UI, OAuth callbacks, webhook receivers
apps/worker         Job runner (pg-boss), all scheduled work
packages/db         Drizzle schema, migrations, repositories
packages/crypto     AES-256-GCM token vault
packages/connectors Connector interface + outlook/ + gmail/ + imap/
packages/extraction Zod schema, prompts, batched Haiku extraction
packages/brief      Prefilter, days-open SQL, Sonnet synthesis
packages/config     Typed env + counterparty allowlist loader
packages/jobs       pg-boss queues, shared by web and worker
config/             counterparties.json — the allowlist, edited weekly
```

Adding a connector in a later phase means one new folder under
`packages/connectors` and one row in the registry. Nothing else should move.

## Local development

```sh
pnpm install
cp .env.example .env          # fill in at minimum DATABASE_URL + TOKEN_ENCRYPTION_KEY

pnpm db:migrate
pnpm dev:web                  # http://localhost:3000
pnpm dev:worker
```

Seed a realistic day of mail and a brief, without connecting a mailbox or
spending anything on the API:

```sh
pnpm exec tsx scripts/seed-demo.ts
```

Run the test suite:

```sh
pnpm test                     # unit tests, no network, no real API calls
pnpm typecheck
```

Integration tests that need Postgres read `TEST_DATABASE_URL` and skip
themselves when it is unset:

```sh
TEST_DATABASE_URL=postgres://hub@localhost:5432/hub_test pnpm test
```

## Deployment (Railway)

One project, three services: **web**, **worker**, and managed **Postgres**.

1. Create the project and add Postgres. `DATABASE_URL` is injected automatically —
   reference it from both services.
2. Create the web service from this repo. Set its config path to
   `apps/web/railway.json`. Generate a public domain and set `APP_BASE_URL` to it.
3. Create the worker service from the same repo with config path
   `apps/worker/railway.json`. The worker runs `pnpm db:migrate` on boot, so
   migrations apply on deploy.
4. Set the remaining variables from `.env.example` on both services.

Health check: `GET /api/health` returns 200 when the database is reachable and
the required env vars are present, 503 otherwise.

## Pages

| Path | What it shows |
|---|---|
| `/` | Connected mailboxes, latest brief |
| `/brief/[date]` | One day's brief. `?audience=moet` for another person's |
| `/ops` | Per-account sync status, subscription expiry, consecutive failures, pipeline counts, recent briefs |

Everything except `/api/health` and the webhook receivers is behind a single
session check against `HUB_ACCESS_TOKEN` (§9 — one user, no auth SaaS).

`/ops` is where §8's "silent degradation is the enemy" is cashed out: an
account that has failed three times in a row, or that needs reauthorizing,
appears at the top with a reconnect link.

## Operational facts worth knowing

These are the things that silently break this project.

| | |
|---|---|
| Gmail refresh tokens | Die after **7 days** if the Google Cloud app is in "Testing". Use an **Internal** Workspace app. See §2.1 and `docs/gmail-setup.md`. |
| Personal @gmail.com | Cannot use the Internal escape hatch, and OAuth for it means Google's CASA assessment. Connect it over **IMAP with an app password** instead — `docs/imap-setup.md`. |
| IMAP mailboxes | No push equivalent exists; they are picked up by the 30-min poll only. Fine for a 7:00 AM brief. |
| IMAP UIDVALIDITY | A server rotation reissues every UID. Treated like a stale cursor — bounded full re-sync, not an error. |
| Gmail `users.watch()` | Expires after 7 days — renewed daily. |
| Graph subscriptions | Expire after ~2.9 days — renewed every 6h, anything inside 24h. |
| Gmail `historyId` | Valid ~7 days. A 404 falls back to a bounded 30-day full sync, it does not error. |
| Webhooks | Never trusted for content. A notification means "something changed, go sync". |
| Polling | Runs every 30 min per account regardless of webhook health. Webhook-only ingestion is how these systems die. |

## Audiences

Each person in `config/audiences.json` gets their own brief, built only from
the mailboxes assigned to them. Mail in one person's mailbox never appears in
another person's brief, and "Needs you today" means the items assigned to
*that* person.

Assign a mailbox when you connect it:

```
/api/auth/outlook/start?audience=moet
/api/auth/gmail/start?audience=moet
/api/auth/imap/start?audience=moet     # personal Gmail, app password
```

The audience travels inside the signed OAuth state, so it cannot be swapped
between the start of the flow and the callback. IMAP has no redirect to
protect — it picks the audience on the form itself. Reconnecting a mailbox keeps
its existing audience unless you explicitly pass a different one.

Audience keys must match a value of the extraction schema's `action_owner`
enum — adding a third person means adding them there too.

## Job numbers

The canonical form is `NNNN` or `NNNN.S` — `2269` or `2269.2`. Four-digit base,
optional sub-job with no leading zeros.

Mail never uses one spelling, so parsing is loose and storage is strict. All of
these normalize to `2269.2` and land in one block in the brief:

```
2269.2   2269-2   2269_2   #2269.2   Job 2269.2   PROJECT 2269.02   No. 2269.2
```

A number with an explicit marker (`job`, `project`, `#`, `no.`) is treated as
unambiguous and may be 3–6 digits. A bare number must be exactly four digits
*and* have stone or project vocabulary nearby, because otherwise every year,
price, and zip code reads as a job number.

## Docs

- `docs/audiences.md` — who gets a brief, and how mail is routed
- `docs/counterparties.md` — what the allowlist is and how to generate it from your own mail
- `docs/gmail-setup.md` — Google Cloud, OAuth consent, Pub/Sub push
- `docs/imap-setup.md` — personal Gmail via app password, and any other IMAP host
- `docs/outlook-setup.md` — Azure AD app registration
- `docs/key-rotation.md` — rotating `TOKEN_ENCRYPTION_KEY` without reconnecting mailboxes
