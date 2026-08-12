# Personal Gmail over IMAP

> This is the answer to the question `docs/gmail-setup.md` step 0 leaves open:
> **what to do about a personal @gmail.com account.**
>
> The OAuth path for a personal account requires publishing an app with a
> restricted scope, which triggers Google's CASA security assessment — paid,
> weeks of turnaround. Until that clears, an unverified app issues refresh
> tokens that **expire every 7 days**.
>
> IMAP with an app password sidesteps all of it. No verification, no consent
> screen, nothing expires, and it works for as many personal accounts as you
> want to add.

## What you give up

Worth knowing before you start, so nothing is a surprise later:

| | OAuth (Gmail API) | IMAP |
|---|---|---|
| Google verification | CASA assessment for personal accounts | None |
| Credential expiry | 7 days while unverified | Never |
| Push notifications | Pub/Sub, near-instant | **None** — polled every 30 min |
| Revocation | Revoke the app's access | Revoke the app password |
| Scope | `gmail.readonly` | Whole mailbox, read |

The one real loss is push. Gmail's IMAP has no webhook equivalent, so an IMAP
mailbox is picked up by the 30-minute poll rather than within seconds. For a
brief that is generated once at 7:00 AM this does not matter.

An app password grants read *and write* access to the mailbox — IMAP has no
read-only scope. This hub never issues a write command, but the credential
itself is broader than an OAuth scope would be. Treat it accordingly: it lives
in the same AES-256-GCM vault as every other credential (§9) and is only ever
decrypted to open a socket.

## Setup

### 1. Turn on 2-step verification

<https://myaccount.google.com/security>

App passwords do not exist as an option without it. If you skip this, step 2 is
a dead end with no explanation of why.

### 2. Create an app password

<https://myaccount.google.com/apppasswords>

Name it something you will recognise in six months — "Ops Hub" — so it is
obvious which one to revoke later.

Google shows it as four groups of four letters: `abcd efgh ijkl mnop`. Paste it
however it is displayed; the spaces are stripped before anything is stored.

**This is shown once.** If you lose it, delete that entry and make another —
there is no way to read an existing one back.

### 3. Check IMAP is enabled

Gmail → **Settings → See all settings → Forwarding and POP/IMAP → Enable IMAP**.

New accounts usually have it on already. An account that has never used a mail
client may not.

### 4. Connect it

```
https://<your-app>.up.railway.app/connect/imap
```

or, to route the mailbox to a specific person's brief:

```
https://<your-app>.up.railway.app/api/auth/imap/start?audience=moet
```

Fill in the address and the app password, pick whose brief it feeds, and leave
the host blank for Gmail. The credentials are verified by actually opening the
mailbox before anything is written to the database — a wrong password fails on
the form, not silently at 3 AM.

There are **no environment variables** to set for IMAP. That is the point of it.

## Other providers

The host field accepts any IMAP server, so the same form covers Fastmail
(`imap.fastmail.com`), iCloud (`imap.mail.me.com`), and most others. Only
implicit TLS on port 993 is accepted — the connector refuses to send
credentials to a remote host on any other port rather than quietly downgrading.

## How syncing works

The cursor is `<UIDVALIDITY>:<lastUID>`. Each poll fetches everything with a
UID above the stored one.

UIDs are only meaningful within one UIDVALIDITY generation. When a server
rotates it, every UID is reissued and the stored high-water mark becomes
meaningless — so the connector raises `CursorExpiredError` and falls back to a
bounded full sync, exactly as it does for an expired Graph delta token or a
stale Gmail `historyId` (§2.3).

Messages are keyed on their RFC `Message-ID`, not on the UID, for the same
reason: keying on UIDs would re-ingest the entire mailbox the first time
UIDVALIDITY rotated. Every event upserts on `(source, external_id)`, so a
re-run is free.

## When it breaks

| Symptom | Cause |
|---|---|
| Account flagged `needs_reauth` right after connecting | Wrong password, or the account password was used instead of an app password |
| Worked for months, now `needs_reauth` | The app password was revoked, or 2-step verification was turned off — turning it off invalidates every app password |
| `Application-specific password required` | 2-step verification is on and the plain account password was used |
| Connects, syncs nothing | IMAP disabled in Gmail settings (step 3) |
| A full re-sync out of nowhere | The server rotated UIDVALIDITY. Expected, handled, harmless |

A failed login is treated as terminal, not retryable: the account is flagged
and syncing stops (§8). Retrying a wrong password on a schedule is how an
account gets locked.

To revoke access, delete the app password at
<https://myaccount.google.com/apppasswords>. The next sync flags the account.
