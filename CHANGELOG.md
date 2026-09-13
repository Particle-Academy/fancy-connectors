# Changelog

All notable changes to the `fancy-connectors` catalogue are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

**Pre-1.0, so breaking changes land in MINOR releases.** The version number is
not a promise it can keep yet; the entries below are.

Connectors ship as **vendored source**, so "released" here means *the registry
serves this version and `fancy-cli` will copy it*. A consumer who vendored an
earlier copy keeps it until they re-vendor — see the `connectorApi` note below,
which is what makes that safe rather than merely quiet.

## [Unreleased]

### Added

- **`bluesky` and `discord` now declare `providerCodeFrom`, so a failed call
  carries the provider's own error code.** Core 0.5.0 added the reader and no
  connector here declared one, so `error.providerCode` was empty on every call —
  which reads as "this provider has no code", false for two of the four.
  - `bluesky` — the XRPC error name, e.g. `AuthenticationRequired`, via the new
    pure `blueskyErrorNameFrom()`. Carried only when it is shaped like one (ASCII,
    no whitespace, as the XRPC spec defines it), so a proxy's
    `{"error":"Bad Gateway"}` is not published as a code.
  - `discord` — the JSON error code, e.g. `10015` (Unknown webhook), via the new
    pure `discordErrorCodeFrom()`. Integers only, as documented. Worth more here
    than anywhere: a webhook's 404 is its auth answer, and only the code says
    whether the webhook or the token was wrong.
  - `mastodon` and `telegram` **deliberately declare none**, with the reason at
    the declaration: Mastodon's `error` is documented as "The error message." (a
    sentence — `"The access token is invalid"`), and Telegram documents
    `error_code` as "subject to change in the future", besides repeating the
    HTTP status.

  `tests/provider-codes.test.ts` replays each provider's recorded refusal through
  the connector's own service descriptor and pins all four decisions, both
  directions. The two positive cases fail without the declarations; the guards
  against a naive reader (`JSON.parse(body).error`, and the same on Mastodon or
  Telegram) were checked by planting one in each connector — four of the seven
  cases then fail. The recorded bodies moved to `tests/real-refusals.ts`, with
  the Drift run they came from, shared with `probes-read-the-status.test.ts`.

  **What a consumer must DO: nothing.** Re-vendor `bluesky` or `discord` to get
  the code; a copy vendored earlier keeps working with it absent. Needs core
  0.5.0 or later, which the floor already requires.

### Fixed

- **The scheduled Drift workflow failed on every run since it was added — 25
  of 25 — while every provider answered correctly.** Each probe asks the real
  provider to refuse an impossible credential and reads `error.status` off the
  failed call. Core up to 0.4.0 threw that error with no `status` at all, so
  Bluesky's, Mastodon's and Telegram's `401` and Discord's `404` all reported
  *"the request failed before any status arrived"*, and the `drift` step behind
  them never ran.

  The fix is in `fancy-connector-core` 0.5.0, which keeps the status, the
  classified error class and a declared provider code on a failed call. Here:
  the core floor moves to **`>=0.5.0 <2.0.0`** — the probes in every
  `contract.ts` rely on `status` being there, and a floor that admitted 0.4.0
  claimed a core they cannot work with — and `tests/probes-read-the-status.test.ts`
  replays each provider's real refusal through the probe's own request builder,
  with no network, so `npm test` now sees what only a scheduled run could see
  before. Against core 0.4.0 all eight per-probe cases in it fail.

  **What a consumer must DO:** nothing in a vendored connector. A host running
  these probes needs core 0.5.0 or later.

### Changed

- **Every provider now declares `proves` on the ADAPTER**, not only on each
  `VerifyResult`. `providerProblems()` in core 0.2.0 caught all four of them the
  day it was written, and it was right to: a setup surface has to be able to say
  what a check will and will not prove *before* anyone runs it, which is the
  wrong way round if the sentence only exists on the result.


## [0.1.0] — unreleased

First cut: four exemplars, chosen for what each gets wrong when nobody is paying
attention. Built on `@particle-academy/fancy-connector-core`.

### Added

- **`bluesky`** — AT Protocol. Grapheme counting (`"👍".length` is 2), link
  facets as **UTF-8 byte ranges** (a character-offset implementation is correct
  for ASCII and silently corrupts the *link* on any post with an emoji), and a
  thread that is a **chain** rather than a fan. Declares `idempotent: false`,
  citing `com.atproto.repo.createRecord` having no key.
- **`mastodon`** — a per-instance base URL, the instance's configured limit
  passed **in** as a render rule so it is part of what was approved, and
  `Idempotency-Key` derived from the approved bytes so a retry is the same
  request across a process restart.
- **`discord`** — a channel webhook URL that **is a secret** (it carries its
  token in the path), `?wait=true` because a `204 No Content` leaves no ref, and
  a 2xx with no id treated as a failure. No metrics at all, and **no
  `metricShape`** rather than an empty one.
- **`telegram`** — a token in the URL path, and a `200 OK` carrying
  `{"ok": false}` treated as the real refusal it is. Its `verify` states
  explicitly that `getMe` proves the token and says **nothing** about whether the
  bot reached the target chat, which is where everyone actually gets stuck.
- An `ApiContract` and a credential-free `ProbeSpec` per connector, plus
  `npm run drift` and `npm run probe` to run them out of band.
- **`connectorApi` on every connector, as a literal.** The catalogue and the core
  release on separate clocks; a vendored copy has no manifest to carry a version
  range, so this number is the only thing that can tell it the surface it was
  written against has moved. Declaring it via the core's own constant would make
  the check agree with itself forever, so `tests/release-clocks.test.ts` fails on
  anything that is not a literal.

[Unreleased]: https://github.com/Particle-Academy/fancy-connectors/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Particle-Academy/fancy-connectors/releases/tag/v0.1.0
