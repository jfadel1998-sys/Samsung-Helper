# The counterparty allowlist

## What a "domain" is

The domain is the part of an email address after the `@`.

```
m.rossi@marmi-carrara.it
        └────────────┘
          the domain
```

So if your Carrara supplier emails you from `m.rossi@marmi-carrara.it`,
`sales@marmi-carrara.it`, and `logistics@marmi-carrara.it`, you do **not** list
three addresses. You list the domain once:

```json
"marmi-carrara.it": "supplier"
```

and every person at that company is covered, including people who haven't
emailed you yet. Subdomains are covered too — an entry for `marmi-carrara.it`
also matches `mail.marmi-carrara.it` and `notifications.marmi-carrara.it`.

## What it does

Mail from an allowlisted domain is **always** kept, even when it trips a rule
that would otherwise filter it out — a mailing-list footer, a Promotions label,
an auto-generated ticket header. That is the whole job: your suppliers use
mailing-list software and ticketing systems too, and without the allowlist
their mail looks like marketing to a generic filter.

Everything else still has to earn its place: a job number with stone vocabulary
near it, or being addressed to you and surviving the newsletter and
notification rules.

## The types

Each domain is tagged with what that company is to you. The tag flows into the
brief, so "a supplier is waiting on you" reads differently from "a GC is
waiting on you".

| Type | Who |
|---|---|
| `supplier` | Quarries, mills, importers, distributors — whoever you buy material from |
| `freight_forwarder` | Forwarders, carriers, customs brokers, drayage |
| `fabricator` | Cutting, templating, polishing, install crews |
| `gc` | General contractors and construction managers |
| `designer` | Architects, interior designers, specifiers |
| `client` | Owners, developers, hotel and resort groups |
| `internal` | Your own domains |

If you're unsure, use the closest one — the tag colors the brief's wording, it
does not gate anything.

## Don't write it by hand — generate it

Hand-listing every counterparty from memory is the wrong way round: you'd miss
the ones that matter and add ones that never email you. Instead, connect a
mailbox, let it backfill 30 days, then run:

```sh
pnpm exec tsx scripts/suggest-counterparties.ts
```

That reads the mail you've actually received and ranks every sender domain by
how much it looks like a real working relationship. The strongest signal is
**whether you have ever replied** — you don't reply to newsletters.

It prints a paste-ready JSON block with a type already guessed for each domain,
plus the evidence behind each guess:

```
marmi-carrara.it            42 msgs  11 threads   9 replied   → supplier
   guessed from: "slab", "quarry", "FOB", "lot"
   senders: m.rossi@, sales@, logistics@

genoa-forwarding.com        28 msgs   7 threads   7 replied   → freight_forwarder
   guessed from: "vessel", "container", "bill of lading"
   senders: ops@, docs@
```

Review it, fix any wrong guesses, paste the block into
`config/counterparties.json`, and commit. It is a plain file on purpose — no
settings UI, so changes are reviewable and revertible like any other change.

Re-run it every few weeks. It flags domains already in your config so you only
look at what's new.

## Keeping it current

New counterparty starts emailing you → their first few messages still reach the
brief if they quote a job number (they usually do), and the next run of the
suggester will surface them for a permanent entry.

Someone stops working with you → leave them. A stale entry costs a fraction of
a cent; removing one that's still active loses real mail.
