# Changelog

All notable changes to `fancy-connectors` are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

**This package is pre-1.0, so breaking changes land in MINOR releases.** The
version number is not a promise it can keep yet; the entries below are.

## [Unreleased]

## [0.1.0] — unreleased

First cut. Extracted and generalised from the `_connector` shared runtime in the
fancy-flow node marketplace, then rebuilt around the requirements in The Ripple
Effect's packager brief, which came from five adapters dry-verified against real
APIs.

### Added

- **Core runtime, TypeScript and PHP, with zero runtime dependencies in either
  ecosystem.** WebCrypto and `fetch` on Node; `hash()` and cURL behind a
  swappable `Transport` in PHP.
- **`delivery` — a four-way failure classification.** `unreachable` /
  `refused-explicitly` / `ambiguous` / `rejected`, with retryability a function
  of the kind **and** the connector's declared idempotency. An unrecognised
  error falls to `ambiguous`, never to safe.
- **`DeliveryDeclaration`** — `idempotent` + a cited `why` + `minIntervalMs` +
  `rateSource` (`documented` | `self-imposed`) + a dated `Citation`.
- **`seam` — `ProviderAdapter` and `Connector`**, deliberately separate, plus
  the written list of everything the package never owns: approval, liveness, the
  approved-bytes comparison, consent, second review, journals, credential
  storage.
- **`text`** — `measure(text, unit)` over graphemes / characters / UTF-8 bytes,
  and a `ByteRange` type producible only by a function that encoded the string.
- **`render`** — pure, versioned (version **inside** the payload hash), loss
  reported rather than applied, driven by a declarative `RenderRules` so most
  providers need no rendering code at all.
- **`chain`** — root fixed, parent advancing, with the post function as an
  argument so threading is testable without a live session.
- **`metrics`** — declared metric shapes, `compareShape()`,
  `capabilityProblems()`, and `reported()` so *absent stays absent* is a
  property of the code.
- **`probe`** — dry-verify against the real API with a deliberately invalid
  credential, per-provider `authStatuses`, a 2xx counted as a failure, and
  offline reported as **skipped** rather than failed.
- **`drift`** — API-drift *reporting*: a narrow projection of an OpenAPI
  document against the operations a connector actually calls, a recorded-shape
  fallback for the majority of providers that publish nothing, and `unchecked`
  as a first-class outcome that is never collapsed into `clean`.
- **Explicit-credentials resolution.** Credentials passed straight in bypass the
  connection registry entirely; an incomplete set is a loud failure rather than
  a silent fall-through.
- Four exemplar connectors as vendorable source.

#### Two things the PHP core does differently, and why

- **A custom `Transport` must throw `TransportException`** — via
  `unreachable()`, `ambiguous()` or `fromCurlErrno()` — to get the *always safe
  to retry* case. PHP has no error-code vocabulary the way Node does, and
  matching on message text is not an option: it is localised and changes between
  HTTP-client versions. **What a consumer must do:** nothing if you use the
  bundled `CurlTransport`. If you bind your own, throw `TransportException`
  rather than a bare exception — a bare one is classified `Ambiguous`, which is
  conservative and correct but gives up the retry a refused connection deserves.
- **`RunIdentity` is bridged rather than implemented.** PHP interfaces are
  nominal, so `FancyFlow\Runtime\RunIdentity` — which matches the shape exactly —
  is not an instance of ours. `ForeignRunIdentity::adapt()` wraps any object
  carrying the five members, and every `Idempotency` entry point runs its
  argument through it. **What a consumer must do: nothing.** Pass `$ctx->run`
  straight in, exactly as the TypeScript side does.

### Fixed

- **An ambiguous failure was retried on a non-idempotent connector.** The
  runtime this was extracted from classified a thrown transport as
  `ConnectorTransient` with `retryable = true` and retried it twice. A thrown
  transport includes a timeout, which may be a request the provider already
  acted on — so any connector without an idempotency key could be retried into a
  silent double write. **What a consumer must do: nothing, unless you relied on
  that behaviour.** A connector that genuinely is safe to repeat now says so
  with `idempotent: true` and keeps its retries; everything else becomes
  conservative, which is the correct direction.
- **The sentence splitter broke URLs.** `splitToFit` treated every `.` as a
  sentence terminator, so `https://example.test/x` was a candidate break point
  and a link could land across two messages at a low limit. A terminator now
  only ends a sentence when whitespace or the end follows it. **What a consumer
  must do: nothing** — but any payload hash computed under the old splitting
  will differ, so an approval recorded against it will correctly refuse.
- **The core no longer imports a workflow engine.** The run identity used for
  idempotency keys is declared structurally, so `fancy-flow`'s `RunIdentity`
  satisfies it with no dependency in either direction and a host that has never
  heard of a workflow engine can implement it.

[Unreleased]: https://github.com/Particle-Academy/fancy-connectors/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Particle-Academy/fancy-connectors/releases/tag/v0.1.0
