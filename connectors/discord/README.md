# Discord (channel webhook)

Vendored source. Copy `connectors/discord/` into your project and rewrite the
`../../src/*` imports to `@particle-academy/fancy-connectors`.

```
connector.ts   the ProviderAdapter + Connector
contract.ts    what it depends on (Discord's own OpenAPI) + the probe
faker.ts       a webhook's answer, with nothing real in it
```

The cheapest real channel there is: one URL, one POST, no app registration, no
OAuth, no review queue. A channel owner pastes a URL and it works.

---

## The near-miss: the webhook URL **is** a secret

It looks like a URL. It carries its token **in the path**:

```
https://discord.com/api/webhooks/<id>/<token>
                                       ^^^^^^^ this is the credential
```

Anyone holding it can post to that channel. In the reference implementation it
very nearly went into configuration alongside the channel name and the display
label, because everything about its shape says "URL" and nothing about its shape
says "password" — and configuration is the half that gets logged, screenshotted,
committed and pasted into an issue.

That is why `secret` is **chosen per field and never inferred from the type**.
`CredentialField.secret` is a `boolean` you set, and this field sets `true`.

Two consequences worth knowing:

- The token appears in **every request URL** for this connector. A host that logs
  request URLs leaks it. `authorize` on the service descriptor is deliberately
  empty *and* deliberately present, with that written in it — an empty function
  invites someone to "fix" it by adding a `Bearer` header that would do nothing
  while looking correct.
- `discordWebhookParts()` rejects anything that is not a webhook URL up front. A
  channel link, an invite, or a truncated copy-paste all look like URLs and none
  of them can post; catching it at parse time names the mistake instead of
  producing a 404 twenty minutes later.

---

## The sandbox shape: `none`

There is no staging Discord and no test webhook. `fake` and `live` are the honest
choices; asking for `sandbox` throws rather than reaching a real channel.

`call(target, { dryRun: true })` runs `fake` mode down the same code path — same
`discordRefFrom`, same refusals — and returns a message id shaped like a real
one:

```
live      1310448220936142859
dry run   000000000000482913
```

Snowflakes are digits, so a fake one cannot carry the word "fake". It carries a
twelve-zero prefix instead, which is not a shape Discord ever mints and is
recognisable at a glance. It is still a string of digits, so a host's storage,
joins and `channels/…/…/<id>` link building all keep working before a credential
exists.

A dry run needs no credentials at all: with none, the connector uses a
placeholder base URL that only the faker ever sees.

---

## Setup, and the trap in each step

1. **Make the webhook in the channel you actually want.** **The trap:** creating
   it from Server Settings → Integrations, where every channel is in a dropdown
   and the default is whichever is first. A webhook is bound to **one** channel
   and cannot be redirected — only deleted and remade. Open the channel's own
   settings so the channel you are looking at is the channel it posts to.
2. **Store the URL as a secret.** **The trap:** it looks like a URL, so it lands
   in configuration. See above.
3. **Know what it cannot do.** **The trap:** planning to report engagement from
   this channel. See below.

---

## What `verify` proves, and what it does not

`verify` does a `GET` on the webhook URL itself, which returns the webhook's own
record. Read-only by construction: there is no way for that call to post
anything, which is what makes it safe to run from a setup screen.

**It proves** the token inside the URL is live, and it **names the channel** the
webhook is bound to — so a URL copied from the wrong channel is caught now rather
than by a post appearing somewhere unexpected. That is the single most valuable
thing it can tell you, because "wrong channel" is the failure this setup actually
produces.

**It does not prove** the webhook will still exist at send time. A channel owner
can delete it in two clicks and nothing notifies you. And it says nothing about
engagement, because a webhook cannot read.

---

## `?wait=true` is not optional

Discord's own documentation: *"Returns a message or 204 No Content depending on
the `wait` query parameter."*

Without it you get **`204 No Content`** — success, empty body, no id. No id means
no ref, and the ref is what every later question about a message is joined on.

So: **a 2xx with no id is a failure here.** `discordRefFrom` raises rather than
reporting a success nobody can point at. It raises a `ConnectorAmbiguous`
specifically, because that is exactly the situation — the message almost
certainly went out, so a retry would post a second one, and `ambiguous` on a
connector declaring `idempotent: false` resolves to *report this for a person*
rather than *try again*. `shouldRetry` gets that right without this file
re-deciding it.

`wait` is a **query** parameter and is deliberately absent from `contract.ts`'s
`sends`, which the drift checker compares against the request *body* schema.
Listing it there would produce a permanent false finding.

---

## Rendering: 2000 characters, `thread: false`

A webhook has no thread mechanism it can use. `thread_id` posts *into* a thread
somebody already made; it cannot create one.

So over-length copy is **refused, not split**. Splitting would invent a structure
the webhook does not have and post two unrelated messages numbered as if they
were connected — worse than a refusal, because it looks deliberate. The refusal
comes back as `ok: false` with the renderer's own problem text, before anything
touches the network.

There is **no length rule outside the renderer.** `validate()` checks copy
presence and alt text, and nothing else.

---

## Metrics: `false`, and **no `metricShape` at all**

Not an empty array. The key is absent from the object.

A webhook can post and cannot read — no reactions, no replies, no counts. An
empty shape would say *"reports nothing yet"* where the truth is *"will never"*,
and those need opposite actions: one is a pull waiting to be wired, the other is
a channel to leave off the dashboard. There is no `fetchMetrics` either, and
`capabilityProblems()` checks the three agree.

Reading would need a bot with its own token, its own permissions and its own
conversation with the server owner. That is a different integration, not a gap in
this one.

---

## Delivery: `idempotent: false`, rate `self-imposed`

The execute-webhook endpoint takes **no idempotency key** and no client-supplied
nonce. A repeated POST posts a second message, so an ambiguous failure is
reported for a person rather than retried.

**The rate figure is ours, and this corrects the reference implementation.** The
widely-quoted "5 requests per 2 seconds per webhook" — which is where 400 ms
comes from — **is not in Discord's current rate-limit documentation**. That page
says webhooks are a top-level bucket (`webhook_id` or `webhook_id +
webhook_token`) and that the real limits arrive per response in `X-RateLimit-*`
headers; it publishes no fixed figure for this route. The reference
implementation labelled 400 ms `documented`. It is `self-imposed`.

A confident figure nobody can cite is worse than an honest one that is too slow,
because the honest one gets revised when evidence turns up and the confident one
gets quoted as a platform fact.

Cited: <https://discord.com/developers/docs/topics/rate-limits>, read 2026-08-19.

---

## Drift

Two operations, checked against **Discord's own first-party OpenAPI** at
`discord/discord-api-spec`. Verified 2026-08-19: 200, about 1.1 MB, 150 paths;
`/webhooks/{webhook_id}/{webhook_token}` carries both `get` and `post`; the POST
body lists `content`; the 2xx response lists `id` and `channel_id`. So these
fields check clean against the provider's own document rather than against
somebody's reading of the docs.

## Probe: 404 is auth-shaped **here**

`DISCORD_PROBE` calls the real API with an all-zero snowflake and a token that is
words, and accepts **`[401, 404]`**.

This is the case the whole `authStatuses` field exists for. The credential is *in
the path*, so an unknown credential and an unknown resource are literally the
same request to Discord — it answers 404. On a provider that does not do this, a
404 means the endpoint moved, which is the one outcome a probe exists to catch.
Guessing would let genuine drift read as a pass, so the provider declares it.

401 stays in the list because Discord returns it for a malformed `Authorization`
header on other routes, and a future change here should not read as a pass.

Offline is reported as **skipped**, never failed. The probe is never run by the
unit suite.
