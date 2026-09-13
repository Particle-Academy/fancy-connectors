# AGENTS.md — fancy-connectors

**The connector catalogue.** One directory per connector, shipped as **vendored
source** — a consumer copies the directory into their project and owns it. There
is no published package here.

`CLAUDE.md` is a symlink to this file. Process rules — publishing, versioning,
backports, the kit lifecycle — live in the envelope's `AGENTS.md`, never here.
This file describes THIS REPO'S CODE.

The runtime these are written on is a **different repository**:
[`fancy-connector-core`](../fancy-connector-core). Read its `AGENTS.md` before
changing anything here — the invariants about retries, rendering, byte ranges and
metric shapes all live there, and this repository only ever declares.

Design doc: [`.ai/plans/fancy-connectors.md`](../../.ai/plans/fancy-connectors.md).

---

## The shape

```
connectors/<id>/
  connector.ts    the ProviderAdapter + Connector
  contract.ts     the ApiContract (drift) + the ProbeSpec
  faker.ts        deterministic, every operation
  README.md       the sandbox shape, the setup trap, what verify does NOT prove
connectors/index.ts   the catalogue, and the compatibility check
tests/                node --import tsx --test
scripts/              probe.ts, drift.ts, link-core.mjs
```

---

## Two repositories, two release clocks

Deliberate: **a provider changing its API is a connector fix and must not wait on
a core release.** Almost every change here — a moved path, a new operation, a
corrected rate citation, a whole new connector — ships from this repository
alone.

**When a connector needs a core change, the core ships first. That is blocking,
and it is not negotiable**: this repository cannot vendor source importing a
symbol nobody can install. In practice it is the rare case, because most
connector work is provider-shaped rather than primitive-shaped — which is the
whole reason the split is affordable.

Three things keep the clocks from drifting into breakage, and all three are tests
in `tests/release-clocks.test.ts`:

**1. The range is open.** `>=X.Y.Z <2.0.0` on the core, **never a caret on a
`0.x`.** A caret there locks the MINOR and pins the core at whatever it was the
day the line was written; every later core release then reads to the resolver as
a *conflict* rather than an upgrade, and nothing reports it — a resolver quietly
choosing an older version, or installing a second copy of a shared core, looks
exactly like success. Widening is safe by construction, because it only adds
candidates.

**2. `connectorApi` is a LITERAL, never the imported constant.** This is the one
that is easy to get wrong and impossible to notice. A connector is copied into a
consumer's project and frozen there. If it read `CONNECTOR_API_VERSION`, then
upgrading the core would change what the copy claims to have been written
against — the check would agree with itself forever while the surface moved
underneath. A literal is the only value that still means something a year after
it was copied.

**3. Nothing imports the core by path.** A relative import into a sibling
checkout typechecks in this workspace and is a dangling module the moment the
directory is vendored.

### The consumer's side, which is the case worth getting right

A consumer vendors a connector, then upgrades the core six months later. Their
copy has no manifest, so no version range can protect it. What protects it is
that **`CONNECTOR_API_VERSION` moves far more slowly than the core's package
version** — it tracks only the surface a connector can see, so a core can go
0.3 to 0.9 without a single vendored connector caring. When it does move, the
connector's frozen literal no longer matches and the core refuses at
registration, with a message naming which side is behind:

- connector **ahead** of the core, upgrade the core;
- connector **behind** the window, re-vendor the connector.

Nothing is adapted automatically. A connector that quietly ran against a surface
it was not written for is exactly the failure the number exists to prevent.

---

## What a connector must get right

Everything below is enforced by `tests/connectors-catalogue.test.ts`, because a
catalogue is where "we always do X" quietly stops being true.

- **`call(target, { dryRun, credentials })`.** The host decides `dryRun`. A dry
  run still produces a real-shaped `ref`, so a host can exercise its whole path.
- **Credentials are arguments.** No `process.env`, anywhere. Scanned.
- **`delivery` is cited.** `idempotent` plus a `why` that names the mechanism,
  `minIntervalMs`, `rateSource`, and a dated `citation`. `idempotent: true` is
  the one claim whose failure is a public duplicate.
- **`metricShape` is ABSENT where there are none**, never `[]`, and
  `capabilities.metrics` must agree. The mapping is a **pure exported function**
  so the declared shape can be checked against what the code actually returns,
  from a synthetic response with no credentials.
- **No length rule outside the renderer.** Declare `renderRules`; let the core
  split.
- **The spec source is honest.** `kind: "none"` needs a **reason** — a `none`
  with no reason is indistinguishable from nobody having looked. A spec that
  exists but is abandoned is `none` with that fact recorded, not a spec.
- **`authStatuses` on a probe is per provider.** A Discord webhook answers 404
  for an unknown id, so 404 IS its auth answer; on a provider that does not do
  that, a 404 means the endpoint moved — the exact drift a probe is for.
- **`providerCodeFrom` only where the provider DOCUMENTS a stable code**, cited
  at the declaration, and a stated reason where there is none. Bluesky's XRPC
  `error` name and Discord's integer `code` are carried; Mastodon's `error` is a
  sentence and Telegram's `error_code` is documented as subject to change, so
  neither is. Both directions are pinned by `tests/provider-codes.test.ts`,
  which replays each provider's recorded refusal (`tests/real-refusals.ts`) —
  a field that looks like a code is the plausible mistake, not the rare one.

No network in tests. Ever. The fakers exist for exactly this.

---

## Commands

| | |
|---|---|
| typecheck | `npx tsc --noEmit` |
| test | `npm test` |
| link the sibling core (local dev) | `npm run link-core` |
| probes (needs network, no credentials) | `npm run probe` |
| drift check | `npm run drift` |

`npm install` overwrites the link; re-run `link-core` after one. It is a
bootstrap tool until the core is published, and after that it is how you test an
unreleased core change against the catalogue before shipping it.

## Adding a connector

1. `connectors/<id>/` with the four files above.
2. `connectorApi: 1` as a **literal**.
3. Register it in `connectors/index.ts` — the compatibility check runs over the
   catalogue at assembly, so a mismatch is a build failure with a name attached.
4. `tests/<id>.test.ts`: the declared metric shape equals what the pure mapping
   produces, `dryRun` sends nothing, and whatever this provider's own trap is.
