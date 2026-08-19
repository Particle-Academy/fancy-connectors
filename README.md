# fancy-connectors

**The runtime under every Fancy connector.** Modes and estates, connections, one
call path, a failure taxonomy that knows the difference between *it never
arrived* and *nobody can tell*, deterministic fakers, webhook verification, pure
versioned rendering, chain posting, declared metric shapes, credential-free
probes, and API-drift reporting.

Matched **TypeScript + PHP**, one repository, **zero runtime dependencies in
either ecosystem**.

```bash
npm install @particle-academy/fancy-connectors
composer require particle-academy/fancy-connectors
```

---

## It owns the wire. It never owns a gate.

Approval, liveness, the approved-bytes comparison, consent, second review and
every journal belong to the **host** — because each is enforced in one place and
every connector inherits it from the host's dispatch path rather than
implementing it.

```ts
await connector.call(target, { dryRun, credentials });
//                              ^^^^^^  ^^^^^^^^^^^
//                              yours   yours
```

Three of those promises are **tests**, not intentions:

1. **Nothing here reads the environment.** No `process.env`, no `getenv`. Your
   credential storage discipline — a gitignored file behind a whitelist, a secret
   manager, Laravel config — stays yours, because the package cannot reach past
   it.
2. **Nothing here contacts a URL of its own.** No telemetry, no phone-home, no
   default endpoint. Even the drift checker does not fetch: you fetch, and pass
   the document in.
3. **Nothing here retries an ambiguous failure** unless the connector declared
   that repeating a request is harmless.

---

## The one that matters: retry, without ever sending twice

A network hiccup should not lose a call. A retry after a request that succeeded
and whose response was lost is a **double write** — the exact failure an
idempotency gate exists to prevent, arriving through the door marked
*reliability*.

Nearly every retry helper reconciles those the same way and loses: it catches an
error, waits, and tries again, because from the caller's side all failures look
alike.

| what happened | did the provider receive it? | retry? |
|---|---|---|
| DNS failure, connection refused | **no** | always safe |
| HTTP 429 / 5xx | **yes**, and it explicitly refused | safe — it says it did nothing |
| timeout, abort, **anything unrecognised** | **unknown** | only where the connector is idempotent |
| other 4xx | yes, and the answer was a real no | never |

```ts
import { classifyError, shouldRetry } from "@particle-academy/fancy-connectors";

shouldRetry(classifyError(err).kind, { idempotent: connector.delivery.idempotent });
```

`idempotent` defaults to **false**, and `delivery.why` must cite the mechanism —
`Idempotency-Key`, or the absence of one — because `idempotent: true` is the one
claim whose failure is a public duplicate.

---

## Text, and two one-line bugs that ASCII hides

```ts
import { measure, linkRanges, sliceByteRange } from "@particle-academy/fancy-connectors";

measure("👍", "graphemes");   // 1   — "👍".length is 2
linkRanges("👍 https://example.test");  // UTF-8 BYTE ranges, not char offsets
```

`ByteRange` is a **type**, producible only by a function that encoded the string.
A character-offset implementation is correct for ASCII and silently corrupts the
*link* on any post containing an emoji — the post looks fine and goes somewhere
wrong.

---

## Rendering: pure, versioned, honest about loss

```ts
const payload = render(copy, {
  limit: 300, unit: "graphemes", thread: true, links: true, label: "Bluesky",
});

payload.segments;  // one entry per message; more than one means a thread
payload.problems;  // what could NOT be fitted. Never silently applied.
await payloadHash(payload);  // RENDERER_VERSION is INSIDE the hash
```

Show the payload before you approve it, recompute it at dispatch, refuse on
mismatch. That is the only way "what was approved is what was sent" survives the
existence of adaptation — and the renderer version being inside the hash is what
stops it being checked separately and forgotten.

---

## Threading

```ts
await postChain(payload.segments.map((s) => s.text), answering, post);
```

Root fixed at the top of the chain; parent advancing to whatever was just posted.
Reverse them and every message attaches to the first — a fan, not a thread — and
the provider's response looks identical either way. The post function is an
**argument** so that is reachable by a test.

---

## Probes: an auth error proves the transport

A connector written from documentation can be wrong in three ways that look
identical until a credential arrives: the URL is wrong, the request shape is
wrong, or the error handling never runs. **All three are invisible to a fake
server, because a fake server agrees with whatever your code does.**

So call the real API with a deliberately invalid credential and require an
auth-shaped refusal.

- `authStatuses` is declared per provider — a Discord webhook answers `404` for
  an unknown id, so 404 IS its auth answer.
- **A 2xx is a failure.** The credential is reaching nothing.
- **Offline is `skip`, never `fail`.** A check that goes red on a train gets
  ignored, and is then worth nothing when it goes red for real.

---

## Drift: it reports, it never adapts

A connector's worst failure is silent — the provider changes its API and nothing
says so until something breaks.

**And the fix is not a connector that reshapes itself.** That connector cannot be
reviewed, its behaviour depends on when it ran, and adaptation is only ever a
guess at intent. So:

> Drift reports. The provider decides. A person acts.

Drift also never changes runtime behaviour: it runs out of band, and a check that
failed a working call because a *document* changed would be a self-inflicted
outage.

What is checked is a narrow projection, not a diff — *for the operations this
connector actually calls, do the path, method, sent fields and read fields still
exist?* Where a provider publishes no spec (most do not), the fallback is a
recorded shape: field **names** only.

`outcome` is `clean` | `drifted` | **`unchecked`**. The third is never collapsed
into the first — a checker that could not see is not a checker that saw nothing
wrong.

---

## Documentation

- [`AGENTS.md`](./AGENTS.md) — the invariants, the traps, and what a change here
  breaks.
- `.ai/plans/fancy-connectors.md` in the envelope — the architecture, the
  Socialite seam, the drift research, and every decision with its reason.

MIT.
