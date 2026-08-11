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
packages/connectors Connector interface + outlook/ + gmail/
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

## Operational facts worth knowing

These are the things that silently break this project.

| | |
|---|---|
| Gmail refresh tokens | Die after **7 days** if the Google Cloud app is in "Testing". Use an **Internal** Workspace app. See §2.1 and `docs/gmail-setup.md`. |
| Gmail `users.watch()` | Expires after 7 days — renewed daily. |
| Graph subscriptions | Expire after ~2.9 days — renewed every 6h, anything inside 24h. |
| Gmail `historyId` | Valid ~7 days. A 404 falls back to a bounded 30-day full sync, it does not error. |
| Webhooks | Never trusted for content. A notification means "something changed, go sync". |
| Polling | Runs every 30 min per account regardless of webhook health. Webhook-only ingestion is how these systems die. |

## Docs

- `docs/gmail-setup.md` — Google Cloud, OAuth consent, Pub/Sub push
- `docs/outlook-setup.md` — Azure AD app registration
- `docs/key-rotation.md` — rotating `TOKEN_ENCRYPTION_KEY` without reconnecting mailboxes
