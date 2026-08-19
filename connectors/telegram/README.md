# Telegram (Bot API)

Vendored source. Copy `connectors/telegram/` into your project and rewrite the
`*` imports to `@particle-academy/fancy-connector-core`.

```
connector.ts   the ProviderAdapter + Connector
contract.ts    what it depends on (nothing machine-readable) + the probe
faker.ts       the Bot API envelope, with nothing real in it
```

---

## The sandbox shape: `none`

BotFather issues one kind of token and there is no test estate behind it. `fake`
and `live` are the honest choices; asking for `sandbox` throws rather than
messaging a real chat.

`call(target, { dryRun: true })` runs `fake` mode down the same code path — same
envelope check, same `telegramMessageUrl`, same refusals — and returns a ref
shaped like a live one:

```
live      https://t.me/yourchannel/4412        (a public @channel)
          4412                                  (a private numeric chat)
dry run   https://t.me/fake_example_channel/900421337
```

Message ids are small integers, so a fake one cannot carry the word "fake". It
starts at 900000000 instead — an implausible message number in a young chat and
recognisable next to a real one.

The faker returns the **full envelope**, `{ ok, result }`, not the bare result. A
faker that unwrapped it would let this connector forget the envelope exists —
which is precisely the bug the live path has to guard against.

---

## A `200 OK` is not a success

The Bot API answers **`200 OK` with `{"ok": false, "description": "…"}`** for
real failures: the bot is not in the chat, the chat id does not exist, the bot
has no permission to post.

A caller that trusted the HTTP status would record a successful send for a
message that was never delivered, and the dispatch journal would say we published
something we did not. That is the worst failure available here, because it is
green.

So `telegramResultFrom()` checks the envelope, reports **Telegram's own
`description`** — its words are more useful than anything paraphrased — and
classifies it with `httpFailure(400, …)`, which makes it a **rejection**: every
cause is configuration and none of them improves on a retry. `errors.ts`
documents this exact case as the reason `httpFailure` exists.

The thrown error carries `.classified`, the shape `deliver()` reads and a host
can route on:

```ts
try { await telegramConnector.call(target, { dryRun: false, credentials }); }
catch (error) {
  classificationOf(error)?.kind;   // "rejected" — do not retry, tell a person
}
```

---

## The token is in the URL PATH

Not a header. `telegramPath(token, "sendMessage")` builds `bot<token>/sendMessage`
and URL-encodes the token because it is a path segment.

`authorize` on the service descriptor is deliberately empty **and** deliberately
present, with that written in it — an empty function invites someone to "fix" it
by adding a `Bearer` header that would do nothing while looking correct.

The consequence: **the credential appears in every request URL.** A host that
logs request URLs leaks the bot token, and a leaked token means anyone can post
as the bot until someone runs `/revoke`.

---

## Setup, and the trap in each step

1. **Create the bot.** Message @BotFather, send `/newbot`, keep the token. No
   review, no app registration. **The trap:** the token is shown once in a chat
   message that scrolls away, and `/revoke` is the only recovery — which
   invalidates the one you lost along with the one you are using.
2. **Add the bot to the chat AND give it permission to post.** **This is the step
   that catches people.** Being a member is not enough: in a channel the bot must
   be an administrator with *Post Messages*. A token that verifies perfectly is
   still refused at send time without it — and the refusal arrives as a `200 OK`
   with `ok: false`.
3. **Get the chat id right.** Public channel: `@its_name`. Private channel or
   group: the numeric id, beginning `-100`. **The trap:** assuming the `@name`
   always works. It does not exist for a private chat, and the numeric id is not
   discoverable from the Telegram app without forwarding a message to a lookup
   bot or reading `getUpdates`.

---

## What `verify` proves, and what it does not

**This is the most important `proves` line in the catalogue.**

`verify` calls `getMe`.

**It proves** the bot **token** is valid and names the bot it belongs to.

**It says NOTHING about whether the bot has been added to your channel or group,
or given permission to post there** — which is step 2 above, the step everyone
actually gets stuck on, and the one this check cannot reach. A valid token that
reaches nothing looks identical to a valid token that reaches everything until
the first send.

So a green tick here is **not** evidence that a dispatch will land. The first dry
run against the real chat is what proves that end. A green tick that means more
than it should is worse than no tick, and `VerifyResult.proves` carries that
sentence in the object rather than only in this file, so a surface cannot render
the tick without it.

---

## A public link exists only for `@public` channels

`telegramMessageUrl(chat, messageId)` returns `https://t.me/<name>/<id>` for an
`@name` chat and **`null` for a numeric one**.

Inventing `t.me/c/<internal>/<id>` for a private chat produces a link that works
for members and 404s for everyone else — worse than no link, because it looks
checkable. When there is no URL the ref is the message id, and the detail says
*"a private chat, so there is no public link"* rather than leaving someone to
wonder.

---

## Rendering: 4096 characters, `thread: false` — a judgement, flagged

`reply_to_message_id` exists, so a chain is technically possible. In a channel it
renders as a run of quoted replies rather than as a thread a reader follows, and
at 4096 characters copy that needs splitting is nearly always copy that needs
rewriting. So over-length content is **refused, not split** into fragments that
arrive looking deliberate.

This one is a judgement rather than a platform fact, and it is marked as one. A
host that disagrees sets `thread: true` and gets numbered segments.

The connector still passes `reply_to_message_id` when the target names a message
it is answering — answering somebody is a different act from threading.

There is **no length rule outside the renderer.** `validate()` checks copy
presence and alt text, and nothing else.

---

## Metrics: `false`, and **no `metricShape` at all**

Not an empty array. The key is absent from the object, and there is no
`fetchMetrics`.

The Bot API gives a bot no dependable view of a channel post's views or
reactions. Claiming metrics and returning nothing would turn *not available* into
a reported zero — which on a dashboard is indistinguishable from *"we asked and
nobody engaged"*. `capabilityProblems()` checks the three agree.

---

## Delivery: `idempotent: false`, rate `documented`

`sendMessage` takes **no idempotency key** and no client-supplied nonce. A
repeated call sends a second message, so an ambiguous failure is reported for a
person rather than retried.

**The rate figure is Telegram's, and this is the only `documented` one in the
catalogue.** Their FAQ says, in these words: *"In a single chat, avoid sending
more than one message per second. We may allow short bursts that go over this
limit, but eventually you'll begin receiving 429 errors."*

That is a genuine **minimum gap**, which is why it is `documented` here where
Bluesky's and Mastodon's are `self-imposed` — both of those publish a *budget*
(points per hour; requests per five minutes) and a floor derived from a budget is
arithmetic on their number, not their number.

Two further published figures this connector does not encode, because they are
about fan-out rather than one chat: 20 messages per minute in a group, and about
30 messages per second across all chats.

Cited: <https://core.telegram.org/bots/faq>, read 2026-08-19.

---

## Drift: `kind: "none"`, with the reason

Telegram publishes **nothing** machine-readable. Checked 2026-08-19:

- `core.telegram.org/bots/api` is HTML prose. It is versioned and has a
  changelog, and it is the only authoritative description that exists.
- The best-known generated spec, `ark0f/tg-bot-api`, still serves 200 — but its
  `Last-Modified` is **2025-02-14** and its `gh-pages` branch has not moved
  since. Checking against an 18-month-old generated document would report
  **clean** about a spec nobody is regenerating, which is strictly worse than
  reporting unchecked: a clean report is evidence somebody is watching.

So `kind: "none"`, and the `note` says why and names the fallback —
`checkAgainstRecordedShape()` against the declared `reads`, field NAMES only,
because a recorded response from a real account is a data leak wearing a test
fixture's clothes. A `none` with no reason is indistinguishable from nobody
having looked.

`ok` is declared in `reads` deliberately. The envelope is not decoration here: it
is where a real failure arrives, and a response that stopped carrying it would
break the one check that separates a send from a silent non-send.

## Probe

`TELEGRAM_PROBE` calls the real `getMe` with a token that is the right **shape**
and cannot be valid — shape matters, because an obviously malformed token could
plausibly draw a 404 on the path rather than a 401 on the credential, and then
the probe would be testing the wrong thing.

`authStatuses: [401]`. Telegram answers 401 even though the token is in the path
— **unlike Discord, which answers 404 for the same shape of mistake.** That
difference is exactly why `authStatuses` is declared per provider instead of
assumed: here a 404 would mean the method name is wrong or the API moved, which
is drift, and accepting it would let real drift read as a pass.

Offline is reported as **skipped**, never failed. The probe is never run by the
unit suite.
