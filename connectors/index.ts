/**
 * The exemplar catalogue — four connectors, chosen for what each gets wrong when
 * nobody is paying attention.
 *
 * ## These are VENDORED SOURCE, not a package export
 *
 * Every directory under `connectors/` is a self-contained unit: a
 * `ProviderAdapter`, a `Connector`, an `ApiContract`, a `ProbeSpec`, a
 * deterministic faker, and a README that names the trap. A consumer copies ONE
 * directory into their project and rewrites its `../../src/*` imports to
 * `@particle-academy/fancy-connectors`. Nothing else changes, and adding a
 * connector costs no new dependency.
 *
 * That is why each connector declares its own `*Target` type rather than
 * importing a shared one. `PostTarget` below is the shape they happen to agree
 * on — it exists so this catalogue can be typed as one thing, not so the four
 * directories can depend on each other.
 *
 * ## What each is an exemplar OF
 *
 * | connector | the thing it makes you get right |
 * |---|---|
 * | `bluesky` | grapheme counting, UTF-8 byte facets, a thread that is a CHAIN |
 * | `mastodon` | a per-instance base URL, a limit passed IN, `Idempotency-Key` on the approved bytes |
 * | `discord` | a URL that is a secret, `?wait=true`, a 2xx with no id being a failure, no metrics at all |
 * | `telegram` | a `200 OK` that means no, a token in the path, a link that must not be invented |
 *
 * ## What none of them owns
 *
 * Approval, liveness, the approved-bytes comparison, consent, journals and
 * credential storage. `call` takes `{ dryRun, credentials }` because the HOST
 * decides both — see `src/seam.ts`, which states this in full. Nothing in this
 * tree reads `process.env`, and a test asserts it over the whole source.
 */

import type { RenderedPayload } from "../src/render.ts";
import type { ApiContract } from "../src/drift.ts";
import type { ProbeSpec } from "../src/probe.ts";
import type { Catalogue } from "../src/seam.ts";

import { blueskyConnector, blueskyProvider } from "./bluesky/connector.ts";
import { BLUESKY_CONTRACT, BLUESKY_PROBE } from "./bluesky/contract.ts";
import { mastodonConnector, mastodonProvider } from "./mastodon/connector.ts";
import { MASTODON_CONTRACT, MASTODON_PROBE } from "./mastodon/contract.ts";
import { discordConnector, discordProvider } from "./discord/connector.ts";
import { DISCORD_CONTRACT, DISCORD_PROBE } from "./discord/contract.ts";
import { telegramConnector, telegramProvider } from "./telegram/connector.ts";
import { TELEGRAM_CONTRACT, TELEGRAM_PROBE } from "./telegram/contract.ts";

/**
 * The content shape these four agree on.
 *
 * A host's own content model is the host's; this is the projection of it the
 * connectors need. Every field is JSON-friendly on purpose — an agent has to be
 * able to emit one.
 */
export type PostTarget = {
  /** The copy, exactly as approved. */
  text: string;
  /**
   * What the provider will ACTUALLY receive, already rendered and approved.
   *
   * `call` uses this when present rather than re-rendering, because re-rendering
   * at dispatch is how bytes nobody approved reach the public.
   */
  rendered?: RenderedPayload;
  /** Assets and their alt text. The renderer cannot judge either. */
  media?: Array<{ file: string; alt: string | null }>;
  /**
   * What this answers, when it is a reply. The bag is opaque to a host and
   * shaped by whichever connector collected it: AT Protocol needs a root and a
   * parent as uri + cid, Mastodon needs one status id, Telegram needs a message
   * id. A field named for one provider's model would be wrong for the next.
   */
  replyTo?: { provider: string; context: Record<string, string> };
};

/**
 * A plain lookup rather than a registry with lifecycle.
 *
 * The host owns which connectors it installed, and a package-level global would
 * be one more thing that can be half-initialised.
 */
export const EXEMPLAR_CATALOGUE: Catalogue<PostTarget> = {
  providers: {
    bluesky: blueskyProvider,
    mastodon: mastodonProvider,
    discord: discordProvider,
    telegram: telegramProvider,
  },
  connectors: {
    bluesky: blueskyConnector,
    mastodon: mastodonConnector,
    discord: discordConnector,
    telegram: telegramConnector,
  },
};

/** Every contract, for an out-of-band drift check. Never run at call time. */
export const EXEMPLAR_CONTRACTS: ApiContract[] = [
  BLUESKY_CONTRACT,
  MASTODON_CONTRACT,
  DISCORD_CONTRACT,
  TELEGRAM_CONTRACT,
];

/**
 * Every probe, for a credential-free CI check against the REAL APIs.
 *
 * Declarative here and never executed by the unit suite: a probe reaches the
 * network, and the suite's whole value is that it runs everywhere including on a
 * laptop with no connection.
 */
export const EXEMPLAR_PROBES: ProbeSpec[] = [
  BLUESKY_PROBE,
  MASTODON_PROBE,
  DISCORD_PROBE,
  TELEGRAM_PROBE,
];

export { blueskyConnector, blueskyProvider } from "./bluesky/connector.ts";
export { mastodonConnector, mastodonProvider } from "./mastodon/connector.ts";
export { discordConnector, discordProvider } from "./discord/connector.ts";
export { telegramConnector, telegramProvider } from "./telegram/connector.ts";

/**
 * Shorter aliases.
 *
 * The `EXEMPLAR_` names are the primary ones — this directory is a set of
 * worked examples, and a host that vendors one will have its own catalogue with
 * its own name. These exist so `scripts/` and a consumer can use whichever reads
 * better at the call site without a second source of truth.
 */
export { EXEMPLAR_CATALOGUE as CATALOGUE, EXEMPLAR_CONTRACTS as CONTRACTS, EXEMPLAR_PROBES as PROBES };
