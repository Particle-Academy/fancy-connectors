# AGENTS.md — fancy-connectors

The runtime under every Fancy connector, and the connector catalogue that sits on
it. Matched TypeScript + PHP, one repo, **zero runtime dependencies in either
ecosystem.**

`CLAUDE.md` is a symlink to this file. Process rules — publishing, versioning,
backports, the kit lifecycle — live in the envelope's `AGENTS.md`, never here.
This file describes THIS REPO'S CODE.

---

## The shape

```
src/            the TypeScript core        → @particle-academy/fancy-connectors (npm)
php/src/        the PHP core               → particle-academy/fancy-connectors (Composer)
connectors/     the catalogue, as VENDORABLE SOURCE (see below)
tests/          node --import tsx --test
php/tests/      Pest
```

Design doc, and the reasoning behind every decision here:
[`.ai/plans/fancy-connectors.md`](../../.ai/plans/fancy-connectors.md) in the
envelope.

---

## The one thing to understand first

**This package owns the wire. It never owns a gate.**

Approval, liveness, the approved-bytes comparison, consent, second review and
every journal belong to the HOST — because each is enforced in one place and
every connector inherits it from the host's dispatch path rather than
implementing it. A packager that owned any of them would be unusable by a host
that takes them seriously, which is the only kind worth building for.

Three consequences are **tests**, not intentions, in
`tests/core-discipline.test.ts`:

1. **Nothing reads the environment.** No `process.env`, no `getenv`, anywhere
   under `src/` or `connectors/`. Credentials are arguments. A docblock may talk
   about the environment — the scanner strips comments — but no code may reach
   for it.
2. **Nothing contacts a URL of its own.** There is no literal URL in `src/` at
   all. The drift checker deliberately **does not fetch**: the caller fetches and
   passes the document in, so a scheduled check cannot become an outbound
   connection nobody asked for.
3. **An ambiguous failure is never retried** unless the connector declared that
   repeating a request is harmless.

`call(target, { dryRun, credentials })` — the host decides `dryRun`. A connector
that resolved its own liveness would end the host's guarantee, and there is no
API here for it to do so.

---

## Failure classification — the module that decides whether this package can
## ever produce a duplicate

`src/delivery.ts`. Four kinds, and the third is the whole design:

| kind | did the provider receive it? | retry? |
|---|---|---|
| `unreachable` — DNS, refused, reset before send | **no** | always safe |
| `refused-explicitly` — 429, 5xx | **yes**, and it said it did nothing | safe |
| `ambiguous` — timeout, abort, **anything unrecognised** | **unknown** | only where the connector is idempotent |
| `rejected` — other 4xx | yes, and the answer was a real no | never |

**An unrecognised error falls to `ambiguous`, never to `unreachable`.** Guessing
in the safe-looking direction is how this goes wrong.

`kind` is the primitive. `error.retryable` answers only the narrower question —
*safe whatever the connector is?* — so a caller that reads it becomes
conservative rather than wrong. Ask `shouldRetry(kind, { idempotent })` for the
full answer.

**Retry wraps ONE request, never a sequence.** Wrapping a multi-message publish
re-sends every earlier segment when a later one fails, turning a partial send
into a duplicated one. `chain.ts` composes above `deliver`, never below it.

### The bug this replaced

The previous runtime (`px-ui-sandbox/resources/flow-nodes/_connector/js/client.ts`)
caught a thrown transport, called it `ConnectorTransient` with
`retryable = true`, and retried it twice. A thrown transport includes a
**timeout**, which may be a request the provider already acted on — so a
connector with no idempotency key was retried into a silent double write. The
regression test in `tests/delivery.test.ts` asserts exactly one attempt; against
the old code it reads three.

---

## Text, and the two one-line bugs

`src/text.ts` exists because both of these are invisible when you test with
ASCII, which is what everyone tests with.

- **`.length` counts UTF-16 code units**, not anything a provider limits.
  `"👍".length` is 2. Use `measure(text, unit)`; `.length` should never appear in
  a connector.
- **`indexOf` gives a character index; rich-text formats want BYTES.** A
  `ByteRange` is a type that can only be produced by `byteRangeOf()` or
  `linkRanges()`, both of which encode before they index. A character-offset
  implementation is correct for ASCII and silently corrupts the *link* on any
  post containing an emoji — the post looks fine and goes somewhere wrong.

---

## Rendering

`src/render.ts` is **pure, versioned, and honest about loss**, and those three
are the whole contract:

- **Pure.** Rules in, payload out. No clock, no randomness, no network. Anything
  variable (a Mastodon instance's configured limit) is resolved by the CALLER and
  passed in as a rule, so it becomes part of what was approved.
- **Versioned.** `RENDERER_VERSION` is **inside** `payloadHash`, so it cannot be
  checked separately and forgotten. Bump it on any change to how text is split,
  counted or faceted.
- **Loss is reported, never applied.** A token too long to fit is a problem on
  the payload. A truncated URL is worse than a refused message, because it looks
  deliberate.

**No length rule outside this module.** A validator and a renderer that both
judge length will disagree, and the validator will refuse content the renderer
already solved. `validate()` checks media, alt text, required fields — never
length.

`SENTENCE_BOUNDARY` is `/(?<=[.!?])(?=\s)|(?<=\n)/` and the whitespace lookahead
is load-bearing: a regex that treats every `.` as a terminator splits inside
`https://example.test/x`, and at a low limit the URL lands across two messages.

---

## What a connector declares

`src/seam.ts`. Two objects, deliberately separate — they answer different
questions and change on different clocks.

- **`ProviderAdapter`** — how an operator stands it up. `fields` (names and
  shapes, never values), `setup` (with the trap in each step named), `scopes`,
  `sandbox`, `verify`.
  - **`secret` is chosen per field, never inferred from the type.** A Discord
    webhook URL is entirely a secret: it carries its token in the path.
  - **`VerifyResult.proves`** states what the check does NOT prove. Telegram's
    `getMe` validates the token and says nothing about whether the bot reached
    the target chat, which is where everyone gets stuck. A green tick that means
    more than it should is worse than no tick.
- **`Connector`** — what calling it involves. `capabilities`, `delivery`,
  `metricShape?`, `validate`, `render?`/`renderRules?`, `call`, `fetchMetrics?`,
  `fetchFeedback?`.

Rules that `metrics.ts`'s `capabilityProblems()` enforces, so they are checkable
rather than remembered:

- **`metricShape` is ABSENT where there are none, never `[]`.** "This reports
  nothing" and "nobody has asked yet" need opposite actions.
- **A capability flag must not outrun the code.** `metrics: true` with a
  `fetchMetrics` that returns `[]` turns an unimplemented feature into a reported
  zero, which on a dashboard is indistinguishable from "we asked and nobody
  engaged".
- **`delivery.idempotent: true` must cite the mechanism**, not restate the flag.
  It is the one claim whose failure is a public duplicate.
- **`rateSource` says whose number it is.** A confident figure nobody can cite is
  worse than an honest one that is too slow.
- **Absent stays absent** in metrics: use `reported()`, which drops non-numbers.
  A zero says "nothing happened"; an absence says "we don't know".

---

## Probes

`src/probe.ts`. Call the REAL API with a deliberately invalid credential and
require an auth-shaped refusal. That proves the host resolved, the path exists,
the method was accepted and a failure was recognised — **none of which a fake
server can prove, because a fake server agrees with whatever the code does.**

- `authStatuses` is **declared per provider**. A Discord webhook answers 404 for
  an unknown id, so 404 IS its auth answer; on a provider that does not do that,
  a 404 means the endpoint moved — the exact drift a probe exists to catch.
- **A 2xx is a FAIL.** The credential is reaching nothing.
- **Offline is `skip`, never `fail`.** A check that goes red on a train gets
  ignored, and is then worth nothing when it goes red for real.
- Every probe is a READ. A probe that wrote would be a send, and sends are the
  host's to gate.

Probes are not part of `npm test` — they need a network. `npm run probe`.

---

## Drift

`src/drift.ts`. **It reports. It never adapts, and it never changes runtime
behaviour.**

A connector that reshaped itself around a changed API could not be reviewed, its
behaviour would depend on when it ran, and adaptation is only ever a guess at
intent. And a check that failed a working call because a *document* changed would
be a self-inflicted outage.

What is checked is a **narrow projection**, not a diff: for the operations this
connector actually calls, do the path, method, sent fields and read fields still
exist? A full OpenAPI diff would report thousands of changes to parts of the API
nobody calls, and a drift report nobody reads is worse than none.

- `outcome` is `clean` | `drifted` | **`unchecked`**. The third is not a failure
  state and is never collapsed into `clean` — a checker that could not see is not
  a checker that saw nothing wrong.
- `missing-response-field` is the dangerous finding: the code keeps running and
  produces nothing.
- **Additive change is not drift.** A provider adding fields is healthy.
- Remote `$ref`s are deliberately **not followed**: fetching arbitrary URLs out
  of a document we do not control, on a schedule, with nobody watching, is a
  request-forgery surface.
- Where a provider publishes nothing, the fallback is a **recorded shape** —
  field NAMES only. A recorded response body from a real account is a data leak
  wearing a test fixture's clothes.

---

## `connectors/` is vendorable source

Each `connectors/<id>/` is a directory a consumer can copy, the way a flow node
is copied. In this repo it imports `../../src/*.ts`; vendored, those become the
package specifier.

The catalogue is also the source for the flow-node marketplace's `_connector/`
shared directory, which is **generated** from `src/` and `php/src/` rather than
maintained beside it. Two hand-kept copies of a retry ladder is the failure this
arrangement exists to prevent — the sandbox test that compares them is the part
that makes it safe.

---

## Commands

| | |
|---|---|
| typecheck | `npx tsc --noEmit` |
| test (TS) | `npm test` |
| test (PHP) | `composer test` |
| build | `npm run build` |
| probes (needs network) | `npm run probe` |
| drift check | `npm run drift` |
| re-vendor `_connector` | `node scripts/vendor.mjs --target ../px-ui-sandbox/resources/flow-nodes/_connector` |
| verify the vendored copy | same, with `--check` (exits 1 on any difference) |

**After changing `src/` or `php/src/`, re-vendor and re-run the sandbox's flow-node
tests.** The vendored copy is generated; nothing in CI compares it yet, because
the check needs both repositories checked out at once — the sandbox side guards
the half it can see, by failing when a generated file has lost its banner.

## Adding a connector

1. `connectors/<id>/connector.ts` — the `ProviderAdapter` + `Connector`.
2. `connectors/<id>/contract.ts` — the `ApiContract` and the `ProbeSpec`. Be
   honest about the spec source: `kind: "none"` needs a **reason**, because a
   `none` with no reason is indistinguishable from nobody having looked.
3. `connectors/<id>/faker.ts` — deterministic, every operation. An unknown
   operation throws rather than inventing a response.
4. `connectors/<id>/README.md` — the sandbox shape, the setup trap, and what
   `verify` does NOT prove.
5. `tests/<id>.test.ts` — at minimum: the declared metric shape equals what the
   pure mapping produces; `capabilityProblems()` is empty; `dryRun: true` sends
   nothing; and whatever this provider's own trap is.

No network in tests. Ever. The fakers exist for exactly this.
