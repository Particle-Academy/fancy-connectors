# fancy-connectors

[![Fancified](art/fancified.svg)](https://particle.academy)

**The Fancy connector catalogue.** One directory per connector, shipped as
**vendored source**: you copy the directory into your project and own it.

```bash
# from a checkout of this repository
cp -r connectors/bluesky path/to/your-project/connectors/bluesky
```

`fancy-cli` has no `add connector` command (0.8.3 routes only `add node` as a
subcommand), so `npx fancy-cli add connector bluesky` treats both words as
component names: it vendors fancy-whiteboard's `Connector` component, then stops
on `bluesky`, which the registry does not have. Copy the directory.

That costs you exactly **one** dependency — the runtime the connector is written
on:

```bash
npm install @particle-academy/fancy-connector-core
composer require particle-academy/fancy-connector-core
```

and nothing else, ever, however many connectors you add. There is no package
published from this repository, and there is not going to be one: a catalogue
that arrived as a dependency would make every provider you do not use a liability
you carry.

---

## The four exemplars, and what each one is an exemplar OF

| connector | the thing it makes you get right |
|---|---|
| **bluesky** | 300 **graphemes**, link facets as **UTF-8 byte ranges**, and a thread that is a chain rather than a fan |
| **mastodon** | a per-instance base URL, the instance's limit passed **in**, `Idempotency-Key` on the approved bytes |
| **discord** | a webhook URL that **is a secret**, `?wait=true`, and a 2xx with no id being a failure |
| **telegram** | a token in the path, and a `200 OK` that means **no** |

Each carries a `README.md` naming its sandbox shape, the step in its setup that
everyone actually gets stuck on, and what its `verify` does **not** prove.

---

## What a connector never does

`call(target, { dryRun, credentials })` — **the host decides `dryRun`**, and
credentials are arguments. Approval, liveness, the approved-bytes comparison,
consent, second review and every journal belong to you. Nothing here reads the
environment, and a test scans the whole tree to keep it that way.

---

## Two release clocks, on purpose

The catalogue and the core are separate repositories, because a provider changing
its API is a connector fix and must not wait on a core release.

Because a connector is **vendored** — a frozen copy in your project, with no
manifest to carry a version range — each one declares a `connectorApi` number.
It moves far more slowly than the core's version, so a core can go 0.3 to 0.9
without your copies caring. When it does move, the core refuses at registration
and says **which side is behind**: upgrade the core, or re-vendor the connector.
Nothing is adapted for you, because a connector quietly running against a surface
it was not written for is the failure the number exists to prevent.

---

## Out of band, never on a call path

```bash
npm run probe   # call the real APIs with a deliberately invalid credential
npm run drift   # check declared contracts against published specs
```

**A probe requires an auth-shaped refusal.** That proves the host resolved, the
path exists, the method was accepted and a failure was recognised — none of which
a fake server can prove, because a fake server agrees with whatever your code
does. A 2xx is a failure. Offline is *skipped*, never failed.

**Drift reports; it never adapts, and it never changes runtime behaviour.**
`unchecked` is a first-class outcome and is never collapsed into `clean` — a
checker that could not see is not a checker that saw nothing wrong.

---

- [`AGENTS.md`](./AGENTS.md) — the invariants, and what a change here breaks.
- [`fancy-connector-core`](https://github.com/Particle-Academy/fancy-connector-core) — the runtime.

MIT.
