# Audiences — who gets a brief

Each audience in `config/audiences.json` gets **its own brief each day**, built
only from the mailboxes assigned to it. Jason's mail never appears in Moet's
brief and vice versa.

```json
{
  "audiences": {
    "jason": { "label": "Jason", "deliverTo": "jason@traxtone.com", "default": true },
    "moet":  { "label": "Moet",  "deliverTo": "moet@traxtone.com" }
  }
}
```

| Field | Meaning |
|---|---|
| key | Must match a value of the extraction schema's `action_owner` enum |
| `label` | Shown in the UI and used in the email subject |
| `deliverTo` | 07:00 recipient. Empty means generate but don't email — still readable at `/brief/<date>` |
| `default` | Whose brief `/brief/<date>` shows with no `?audience=` |

## Assigning a mailbox

Pass the audience when you connect it — the home page has a link per person:

```
/api/auth/outlook/start?audience=moet
```

The audience is carried **inside the signed OAuth state**, not as a loose query
parameter, so it cannot be swapped between the start of the flow and the
callback. An unknown value falls back to the default rather than erroring, so a
typo can't create a mailbox whose mail reaches nobody's brief.

Reconnecting keeps the existing audience unless you explicitly pass a different
one — otherwise a routine reconnect would silently empty someone's brief.

## What changes per audience

**"Needs you today"** is the items where `action_owner` equals the audience
key. The same extracted fact reads as actionable in one person's brief and as
context in another's.

**Owner detection** uses the account's own addresses
(`accounts.owner_emails`), not a global list. In Moet's mailbox Moet is the
owner, so her sent mail reads as owner-authored and the "owner in To" rule
matches her address.

**Delivery** goes to each audience's own `deliverTo`, with the reader's name in
the subject.

## Adding a third person

1. Add them to `config/audiences.json`.
2. Add their key to the `ACTION_OWNERS` enum in
   `packages/extraction/src/schema.ts` — otherwise extraction can never assign
   them an action and their "Needs you today" is always empty.
3. Connect their mailbox with `?audience=<key>`.

## What is deliberately not shared

A brief is built strictly from its own audience's mailboxes. An item in
Jason's mailbox assigned to Moet appears in *Jason's* brief (under its job
block), not in hers — she sees her own mailbox's copy of that conversation.
Cross-mailbox routing would mean showing one person mail from another's
inbox, which is a different and much larger decision than "give Moet a brief".
