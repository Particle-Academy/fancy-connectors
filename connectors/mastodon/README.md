# Mastodon

Vendored source. Copy `connectors/mastodon/` into your project and rewrite the
`*` imports to `@particle-academy/fancy-connector-core`.

```
connector.ts   the ProviderAdapter + Connector
contract.ts    what it depends on + the probe (per instance)
faker.ts       the shape an instance returns, on a host nobody owns
```

---

## The sandbox shape: `none`

**Mastodon operates no test estate**, and the obvious workaround is not one
either. You can stand up your own instance, but that is a second *real* server
that federates — a post from it reaches the network. It is not a sandbox anybody
publishes, so the declaration is `none` rather than `separate-account`, and
asking for `sandbox` throws rather than quietly reaching the fediverse.

`call(target, { dryRun: true })` runs `fake` mode down the **same code path** —
same chaining, same `mastodonRefFrom`, same refusals — against this connector's
own faker, so the ref is shaped like a live one:

```
live      https://mastodon.social/@brand/113402993111222333
dry run   https://mastodon.example.test/@fake/fake9a1c02b4de77
```

`example.test` is a reserved domain that will never resolve, and `fake` appears
twice, so a dry-run ref cannot be mistaken for a real status. It still parses as
a URL and `.split("/").pop()` still yields an id, so every join a host has built
keeps working before a credential exists.

If you pass real credentials with `dryRun: true`, the faker uses the real
instance host so the ref looks like *yours* — nothing is sent either way.

---

## The variable no other provider here has: there is no single host

Mastodon is thousands of independent servers. **A token is valid on exactly
one.** So the instance is a field, `scope: "account"`, and:

- `mastodonService(instance)` is built **per call**. A module-level descriptor
  with a mutable base URL would be a global that two concurrent sends to two
  instances fight over.
- `normaliseInstance` accepts `mastodon.social`,
  `https://mastodon.social` and a trailing slash. All three mean the same server
  and rejecting two of them would be pedantry dressed as validation.
- There is deliberately **no default instance**. A default would post one
  account's voice from another server.

---

## Setup, and the trap in each step

1. **Pick the instance this account posts from.** **The trap:** a token issued on
   a different instance looks identical and fails with a 401, which reads as a
   bad token — so the usual next move is to re-issue a token that was never the
   problem.
2. **Create an application on that instance.** Settings → Development → New
   application. **The trap:** the scope checkboxes default to more than you need,
   and the one you actually need — `write:statuses` — is easy to lose while
   unticking the rest. A token without it **passes verify** and is refused at
   send time.
3. **Copy the access token.** **The trap:** looking for an OAuth round trip or a
   review queue. There isn't one; that is the whole setup.
4. **Read the instance's character limit and pass it to `render`.**
   `GET /api/v2/instance` → `configuration.statuses.max_characters`. **The
   trap:** hardcoding 500 — many instances raise it, and a hardcoded limit
   refuses posts the server would happily accept.

---

## What `verify` proves, and what it does not

`verify` calls `GET /api/v1/accounts/verify_credentials`, a read that names the
account the token acts as.

**It proves** the token is valid **on this instance** and which account it is —
which catches the single most common failure here, a good token pasted against
the wrong server.

**It does not prove the token can POST.** `verify_credentials` needs only a read
scope. A token issued without `write:statuses` gets a green tick from this check
and a 403 at send time. That is the gap worth knowing about, and the `proves`
field on the result says it in the object rather than only in this file.

It also says nothing about the instance's character limit, which the caller
resolves separately.

---

## The limit is the instance's, and it is passed IN

`renderRules` declares the default (500 characters, threaded). `render(target,
{ maxCharacters })` takes the instance's real number:

```ts
const limit = await readInstanceLimit(instance);      // the HOST's call
const payload = mastodonConnector.render!(target, { maxCharacters: limit });
// …approve `payload`, hash it, and hand the same object back to `call`.
```

That ordering is the point. The limit is **resolved by the caller and becomes
part of what was approved**, rather than something the connector reaches for
later behind the approver's back. `render` stays pure — no clock, no network — so
a host that re-renders at dispatch and compares payload hashes gets a genuine
guarantee. If the instance raises its limit between approval and send, the
hashes differ and the send refuses. That is the correct outcome.

There is **no length rule outside the renderer.** `validate()` checks copy
presence and alt text, and nothing else.

---

## Delivery: `idempotent: true`, keyed on the approved bytes

The only `true` in this catalogue, and it has to earn it.

`POST /api/v1/statuses` honours an **`Idempotency-Key`** header — a documented
request header, not folklore. This connector derives it from the **SHA-256 of
each segment's approved bytes** (`mastodonIdempotencyKey`, WebCrypto, the same
mechanism `render.ts` uses for `payloadHash`). Keyed per *segment*, so a retry of
message 2 is the same request while message 1 stays put.

**Why bytes and not a run identity.** A byte-derived key survives a process
restart, which is precisely when a retry has no run identity to carry. That is
the failure a network retry actually presents.

**The cost, stated plainly.** Posting the *same text twice on purpose* inside the
window collapses into one status. For a daily "good morning" that is a real
surprise. A host that wants a deliberate repeat should vary the bytes or supply
its own key.

**The window is one hour**, from Mastodon's own docs: *"Idempotency keys are
stored for up to 1 hour."* Past it the instance has forgotten the key and a retry
posts again — so `idempotent: true` is **not unbounded**, and a host using
`idempotencyKeyFor()` from `idempotency.ts` must pass `windowSeconds: 3600`. That
module's default is Stripe's 24 hours and would let a stale retry through.

**Rate: `self-imposed`, 1000 ms.** Mastodon documents a *budget* — "All endpoints
and methods can be called 300 times within 5 minutes" — not a minimum gap. 1000 ms
is our spacing of their number, so it is labelled ours. Calling it "documented"
would be a small lie that gets quoted as a platform fact.

Cited: <https://docs.joinmastodon.org/api/rate-limits/>, read 2026-08-19.

---

## Metrics

| key | Mastodon's word | canonical |
|---|---|---|
| `favourites` | Favourites | `like` |
| `reblogs` | Boosts | `share` |
| `replies` | Replies | `reply` |

The key is the **API's** word (`reblogs_count`) and the label is the
**interface's** (Boost). Those genuinely differ here, and picking one for both
would make either the wire or the screen wrong.

`mastodonMetricsFrom()` is a **pure exported function**; a test feeds it a
synthetic response with every field populated and compares the keys against the
declared shape. **Absent stays absent** via `reported()`.

### On quotes — a fact that has changed since the reference implementation

The shape has **no quote entry**, and that is deliberate: the mapping does not
read one, and a declared key nothing produces is exactly the drift
`compareShape` catches.

But the *reason* is no longer "Mastodon has no quotes". **It does.** Quote posts
landed in Mastodon 4.5 (`quoted_status_id` and `quote_approval_policy` on the
create endpoint) and the `Status` entity carries **`quotes_count`** as of API
version 4.7 — both verified against the spec on 2026-08-19. The reason to leave
it out here is fleet version spread: an instance on 4.3 does not send the field,
and until yours are past 4.5 the honest thing is not to offer a column.

When they are, this is the whole change:

```ts
// MASTODON_METRIC_SHAPE
{ key: "quotes", label: "Quotes", canonical: "quote",
  means: "People who quoted the status with their own words attached." }

// mastodonMetricsFrom
reported({ …, quotes: status.quotes_count })
```

Add both or neither — the shape test fails on either half alone, which is the
point of it.

---

## What is deliberately NOT here

- **`fetchFeedback`.** `GET /api/v1/statuses/{id}/context` returns descendants
  and would make replies readable. `capabilities.feedback: false` says *this
  cannot tell you*, distinctly from *nobody replied*.
- **Media upload**, and therefore alt text on the wire. `validate()` refuses an
  asset with no alt text; uploading blobs is `POST /api/v2/media` and needs its
  own contract entry.
- **Scheduled statuses.** Mastodon has `scheduled_at`, and scheduling is a host
  concern — an approval attaches to a moment, so moving the date moves what was
  blessed.

---

## Drift

Three operations, checked against a **community-maintained** OpenAPI document —
`abraham/mastodon-openapi`, regenerated 2026-08-19, describing API 4.7.0.
Mastodon publishes no spec of its own; `mastodon/mastodon-openapi` does not exist
(404, checked 2026-08-19) and `docs.joinmastodon.org` is prose.

It is declared `openapi` rather than `none` because it is genuinely maintained
and genuinely checkable, and a `none` would throw away a usable signal. The
`note` carries the caveat: a clean result means *the docs still say this*, which
is one step removed from the server, and instances run different versions anyway.

One known soft spot: that document expresses the create-status body as form
parameters rather than a JSON schema, so `propertiesOf` reads an empty request
schema and the checker **skips** the `sends` comparison rather than reporting
three false findings. The fields are declared anyway, because they are what this
connector really sends.

## Probe

`mastodonProbe(instance)` is a factory, because "which server" is the question
this provider always asks. `MASTODON_PROBE` defaults to `mastodon.social` —
chosen because a probe needs a host that certainly exists, since the whole point
is distinguishing *this credential is refused* from *this host is not there*.

`authStatuses: [401]`. **404 is deliberately excluded**: on Mastodon it means the
hostname has no API at that address, which is the wrong-instance failure that
otherwise looks exactly like an outage. Offline is reported as **skipped**, never
failed.

The probe is never run by the unit suite.
