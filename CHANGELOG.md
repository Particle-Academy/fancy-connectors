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
