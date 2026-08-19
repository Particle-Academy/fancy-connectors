# Bluesky (AT Protocol)

Vendored source. Copy `connectors/bluesky/` into your project and rewrite the
`../../src/*` imports to `@particle-academy/fancy-connectors`. Nothing else
changes — there is no package to install for the connector itself.

```
connector.ts   the ProviderAdapter + Connector
contract.ts    what it depends on (lexicons) + the probe
faker.ts       the shape AT Protocol returns, with nothing real in it
```

---

## The sandbox shape: `none`

**Bluesky operates no test estate.** There is no `sandbox.bsky.social`, no test
key that selects a different ledger. The honest modes are `fake` and `live`, and
asking for `sandbox` throws `ConnectorModeError` rather than quietly reaching
production.

That makes the faker the whole of the development story here, so it is not an
afterthought: `call(target, { dryRun: true })` runs `fake` mode down the **same
code path** as a live send — the same chaining, the same `blueskyRefFrom`, the
same refusals — and returns a ref shaped exactly like a live one:

```
live      at://did:plc:ic6zqvuw5ulmfpjiwnhdc4dq/app.bsky.feed.post/3kv7x2ycsn22u
dry run   at://did:plc:fake0000000000000000000/app.bsky.feed.post/fake1a2b3c4d5
```

It parses as an AT URI, `startsWith("at://")` filters keep working, splitting on
`/` still yields an rkey — so a host can exercise its entire path, including the
joins, before a credential exists. The identity inside it says `fake` in three
places, because a ref that could be mistaken for a real post would be worse than
no ref at all.

A dry-run ref is a **local fiction**: `fetchMetrics` will pass it to the provider
like any other, and the provider will not know it, so it is simply absent from
the samples. Absent, not zero.

If you want an isolated estate for real, run your own PDS and point
`BLUESKY_PDS` at it. That is a self-hosted server, not a sandbox Bluesky
publishes, so the declaration stays `none`.

---

## Setup, and the trap in each step

**Two fields, both per account.** `identifier` (the handle) and `appPassword`.
There is no app to register, no OAuth client, no review queue and no scopes —
`scopes: []` is the statement, not an omission.

1. **Create an app password.** Settings → Privacy and Security → App Passwords.
   **The trap:** the account password is right there and it works. It also
   cannot be revoked without locking out everything else you have connected. One
   app password per integration is the whole discipline.
2. **That is the setup.** **The trap:** expecting more and going looking for a
   developer portal. There isn't one. Spend the time on `verify` instead.

---

## What `verify` proves, and what it does not

`verify` calls `com.atproto.server.createSession` — a read in the sense that
matters: it writes nothing to the repo.

**It proves** the app password is valid *right now*, and that it reaches the
account we believe it does. The DID it returns is the part a form cannot check,
so a typo in the handle is caught here rather than by a post appearing under the
wrong name.

**It does not prove** anything about a future send. An app password is revocable
on its own and can stop working between this check and a dispatch. A green tick
means "valid at 14:02", not "valid".

The `proves` field on `VerifyResult` says this in the object, not just in this
file, so a surface cannot show the tick without the caveat.

---

## Three things this connector exists to get right

### 1. The limit is 300 GRAPHEMES

`unit: "graphemes"` on `BLUESKY_RULES`, and that is the whole of it — **no code
in `connector.ts` counts anything**. `"👍".length` is 2 and `"👨‍👩‍👧".length` is
8, so `.length` overcounts exactly the posts most likely to sit near the limit,
and it fails in the worse direction: a post that passes our check and is refused
by the server reads as the network being flaky rather than as our bug.

There is **no length rule outside the renderer**. `validate()` checks copy
presence and alt text — things the renderer cannot judge — and leaves length
alone, because a validator and a renderer that both judge length will disagree
and the validator will refuse posts the renderer had already solved.

### 2. Facets are UTF-8 BYTE ranges

`blueskyFacets()` maps `linkRanges()` output into
`{ index: { byteStart, byteEnd }, features: [{ $type: "app.bsky.richtext.facet#link", uri }] }`.
The offsets come from a function that encoded the string; `indexOf` never
appears.

A character-offset implementation is correct for ASCII and silently corrupts
every post containing an emoji or an accent — and it corrupts the **link**, so
the post looks fine and goes somewhere wrong. `👍 https://example.test` puts the
URL at byte 5, not character 2. The test suite asserts this with
`sliceByteRange`, which is the only way to catch an off-by-one that ASCII hides.

Facets are computed **per segment**, never sliced from the original: an offset
into the whole text is meaningless once the text has been split.

### 3. A thread is a CHAIN, not a fan

`postChain` fixes `root` at the top and advances `parent` to whatever was just
posted. Reverse them and every message attaches to the first — a fan, not a
thread — and the API response looks identical either way, which is why this
needs a test rather than care.

Chaining lives in `postChain` and takes the post function as an argument, so it
is provable with a fake transport and no session. In the reference
implementation it lived inside a loop that needed a live one, and a rendered
thread went out as three unconnected posts numbered `(1/3)`, `(2/3)`, `(3/3)`.
Nothing threw. The numbering made it look deliberate.

**A partial chain is never unwound.** Nothing here can delete a public post, so
a failure part-way returns `ok: false` with the first uri as the `ref` and a
detail naming exactly where it stopped.

---

## Delivery: `idempotent: false`, and why that is the load-bearing line

`com.atproto.repo.createRecord` takes **no idempotency key** and no
client-supplied request id. A repeated call creates a **second record**.

So an ambiguous failure — a timeout, an abort, an error nothing recognises — is
never retried here. It is reported for a person, who can look at the profile,
which is something no amount of retry logic can do. `shouldRetry(kind, delivery)`
gets that right for free; nothing in this file re-decides it.

Two requests make up one send and they are **not** the same on this point, which
is why the declaration is per request and not per connector:

| request | idempotent | why |
|---|---|---|
| `com.atproto.server.createSession` | `true` | mints a token, writes nothing to the repo |
| `com.atproto.repo.createRecord` | `false` | creates a record; a repeat creates a second |

**Rate: `self-imposed`, 1000 ms.** Bluesky publishes a *points budget* — 5,000
per hour and 35,000 per day, `CREATE` costing 3 points, so 1,666 records an hour
— and **no minimum gap between writes**. The 1000 ms floor is therefore ours and
is labelled as ours. A confident figure nobody can cite gets quoted as a platform
fact; an honest one that is too slow gets revised when evidence turns up.

Cited: <https://docs.bsky.app/docs/rate-limits>, read 2026-08-19.

---

## Metrics

Declared, not inferred:

| key | Bluesky's word | canonical |
|---|---|---|
| `likes` | Likes | `like` |
| `reposts` | Reposts | `share` |
| `replies` | Replies | `reply` |
| `quotes` | Quotes | `quote` |

`blueskyMetricsFrom()` is a **pure exported function**, so a test feeds it a
synthetic response with every field populated and compares the keys it returns
against the shape declared. That check is the one that caught the real bug in the
reference implementation: two connectors declared `metrics: true` while returning
`[]`, so a pull did not skip them — it asked, got nothing, and reported nothing,
which on a dashboard is indistinguishable from *"we asked and nobody engaged"*.

**Absent stays absent.** The mapping is built on `reported()`, which drops
anything the provider did not send. `0` survives; a missing count does not become
one.

`app.bsky.feed.defs#postView` also carries `bookmarkCount` as of 2026-08-19. It
is deliberately not declared: additive fields are not drift, and a shape should
carry what this connector actually reads.

---

## What is deliberately NOT here

- **`fetchFeedback`.** `app.bsky.feed.getPostThread` would make replies
  readable. `capabilities.feedback: false` says *this cannot tell you*, which is
  a different answer from *nobody replied* and needs a different action. An empty
  array would have collapsed the two.
- **`schedule`.** Bluesky has no native scheduling, so there is nothing to hand a
  post to. The seam has no `schedule`; a host that wants one owns the queue.
- **Media upload.** `validate()` refuses an asset with no alt text, but this
  connector does not upload blobs. Adding it is `com.atproto.repo.uploadBlob`
  plus an `embed` on the record, and it needs its own contract entry.

---

## Drift

`contract.ts` declares three operations and their fields, read out of the
first-party lexicons on **2026-08-19**. AT Protocol publishes **lexicons, not
OpenAPI** — `spec.kind` says `"lexicon"` so a checker cannot report this
connector as unspecified, which would be false. The lexicons are authoritative
rather than descriptive: the server is generated from them, so a lexicon change
*is* an API change.

Until a lexicon checker exists, use `checkAgainstRecordedShape()` against the
`reads` listed.

## Probe

`BLUESKY_PROBE` calls the real `createSession` with a credential that cannot be
valid and requires **401**. That proves the host resolved, the path exists, the
method was accepted, and a failure was recognised as a failure — none of which a
test with a fake server can prove, because a fake server agrees with whatever the
code does.

A 400 would mean the request *shape* is wrong; a 404 would mean the XRPC method
moved. Offline is reported as **skipped**, never failed: a check that goes red on
a train gets ignored, and then it is worth nothing when it goes red for real.

The probe is built through `BLUESKY_SERVICE`, so it exercises this connector's
own URL and auth placement rather than a second copy of them. It is never run by
the unit suite.
