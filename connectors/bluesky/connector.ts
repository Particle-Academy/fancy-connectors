/**
 * Bluesky — AT Protocol, and the three things it makes you get right.
 *
 * Vendored source: a consumer copies this directory into their own project and
 * owns it. It imports the runtime from `@particle-academy/fancy-connector-core`,
 * which is the ONE dependency a connector costs — and the reason the core is a
 * package while the catalogue is not.
 *
 * ## What this connector is an exemplar OF
 *
 * 1. **Graphemes.** The limit is 300 GRAPHEMES. `"👍".length` is 2 and
 *    `"👨‍👩‍👧".length` is 8, so `.length` overcounts exactly the posts most
 *    likely to sit near the limit — and it fails in the worse direction, because
 *    a post that passes our check and is refused by the server reads as the
 *    network being flaky rather than as our bug. `unit: "graphemes"` on the
 *    render rules is the whole fix; no code here counts anything.
 * 2. **Facets are UTF-8 BYTE ranges.** Built from `linkRanges()`, never from
 *    `indexOf`. A character-offset implementation is correct for ASCII and
 *    silently corrupts every post containing an emoji or an accent — and it
 *    corrupts the *link*, so the post looks fine and goes somewhere wrong.
 * 3. **A thread is a CHAIN.** `postChain` fixes the root and advances the
 *    parent. Reverse them and every message attaches to the first: a fan, not a
 *    thread, and the API response looks identical either way.
 *
 * ## How `call` reports
 *
 * - **Returns `ok: false` with `ref: null`** when the connector refused before
 *   touching the network — a blocking `validate` problem, a render that could
 *   not fit something, an empty payload. Nothing was attempted, so there is
 *   nothing to classify.
 * - **Returns `ok: false` with a non-null `ref`** when part of a thread went out
 *   and a later segment failed. The public half is the urgent fact and a throw
 *   would hide it.
 * - **Throws** otherwise, with a `ConnectorError` whose `kind` says whether
 *   repeating is safe. Collapsing that into a boolean would throw away the only
 *   thing a host can route on.
 * - **Never returns `ok: true` with a null `ref`.** A send you cannot point at
 *   is barely a send.
 */

import {
  ConnectorAmbiguous,
  callConnector,
  isEmptyPayload,
  linkRanges,
  postChain,
  render,
  reported,
  respectRate,
  type ByteRange,
  type CallResult,
  type ChainLinks,
  type Connector,
  type ConnectorMode,
  type DeliveryDeclaration,
  type MetricDescriptor,
  type MetricSample,
  type Problem,
  type ProviderAdapter,
  type RenderRules,
  type RenderedPayload,
  type ServiceDescriptor,
  type TransportResponse,
  type VerifyResult,
} from "@particle-academy/fancy-connector-core";

import { blueskyFaker } from "./faker.ts";

/* ── The host's content, as this connector needs it ──────────────────────── */

/**
 * What a host hands this connector.
 *
 * Declared here rather than imported so the directory vendors on its own. The
 * package has no opinion about a host's content model, and a field named for one
 * host's has no business in a shared contract.
 */
export type BlueskyTarget = {
  /** The copy, exactly as approved. */
  text: string;
  /**
   * What Bluesky will ACTUALLY receive, already rendered and already approved.
   *
   * `call` uses this when present rather than re-rendering `text`, because
   * re-rendering at dispatch is how bytes nobody approved reach the public.
   */
  rendered?: RenderedPayload;
  /** Assets and their alt text. The renderer cannot judge either. */
  media?: Array<{ file: string; alt: string | null }>;
  /**
   * What this answers, when it is a reply. The bag is opaque to a host and
   * shaped by whichever connector collected it — AT Protocol needs a root and a
   * parent, each as uri + cid.
   */
  replyTo?: { provider: string; context: Record<string, string> };
};

/* ── Facets, in the only unit that is not a lie ──────────────────────────── */

export type BlueskyFacet = {
  index: ByteRange;
  features: Array<{ $type: "app.bsky.richtext.facet#link"; uri: string }>;
};

/**
 * Bare URLs as AT Protocol link facets.
 *
 * The offsets come from `linkRanges`, which encoded the string. This function
 * only reshapes them into the provider's schema — the package owns the offsets
 * because the offsets are what people get wrong, and does not own the schema,
 * because the schema is Bluesky's.
 */
export function blueskyFacets(text: string): BlueskyFacet[] {
  return linkRanges(text).map((range) => ({
    index: { byteStart: range.byteStart, byteEnd: range.byteEnd },
    features: [{ $type: "app.bsky.richtext.facet#link", uri: range.url }],
  }));
}

/* ── Refs ────────────────────────────────────────────────────────────────── */

/**
 * A post, as AT Protocol identifies it.
 *
 * **Both halves are needed.** A reply names its root and its parent as uri +
 * cid, and a cid is not derivable from a uri — so a connector that returned the
 * uri alone could post a top-level message and never a thread.
 *
 * A `type` alias rather than an `interface` on purpose: only an alias gets the
 * implicit index signature that satisfies `ChainRef`.
 */
export type BlueskyRef = { uri: string; cid: string };

/**
 * Read the ref out of a `createRecord` response, or fail.
 *
 * A 2xx with no uri means the record was accepted and we cannot say what it
 * produced. `ConnectorAmbiguous` rather than a plain error: the post probably
 * exists, so a retry would duplicate it, and `ambiguous` on a connector that
 * declares `idempotent: false` is precisely "report this for a person".
 */
export function blueskyRefFrom(record: unknown): BlueskyRef {
  const bag = (record ?? {}) as { uri?: unknown; cid?: unknown };
  const uri = typeof bag.uri === "string" ? bag.uri : "";
  const cid = typeof bag.cid === "string" ? bag.cid : "";

  if (uri === "" || cid === "") {
    throw new ConnectorAmbiguous(
      "Bluesky accepted the record but did not return both a uri and a cid, so there is nothing to record it " +
        "as and no way to hang the rest of a thread off it. The post has probably been created — go and look " +
        "rather than re-running, because createRecord has no idempotency key.",
      { service: "bluesky", operation: "post_create" },
    );
  }

  return { uri, cid };
}

/** What `target.replyTo` means here, or nothing if it is not ours. */
export function blueskyReplyLinks(
  replyTo: BlueskyTarget["replyTo"],
): ChainLinks<BlueskyRef> | undefined {
  if (replyTo?.provider !== "bluesky") return undefined;

  const parentUri = replyTo.context.parentUri ?? "";
  if (parentUri === "") return undefined;

  const parent: BlueskyRef = { uri: parentUri, cid: replyTo.context.parentCid ?? "" };

  return {
    // A reply to a top-level post has no separate root, so the parent IS the
    // root. Falling back rather than requiring both is what makes answering our
    // own posts work as well as answering a deep reply.
    root: {
      uri: replyTo.context.rootUri || parent.uri,
      cid: replyTo.context.rootCid || parent.cid,
    },
    parent,
  };
}

/* ── Metrics: the mapping is a PURE function, so the shape is checkable ──── */

export type BlueskyPostView = {
  uri?: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
};

/**
 * One post's counts, from one post's API object.
 *
 * Pure and exported so a test can feed it a synthetic response with every field
 * populated and compare the keys against `metricShape`. Declared shape and real
 * output are the classic pair that agrees on the day it is written and drifts
 * silently after — and the drift only shows up once a channel is live.
 *
 * **Absent stays absent**, which `reported()` enforces: a count the provider did
 * not send is omitted, never reported as zero.
 */
export function blueskyMetricsFrom(post: BlueskyPostView): Record<string, number> {
  return reported({
    likes: post.likeCount,
    reposts: post.repostCount,
    replies: post.replyCount,
    quotes: post.quoteCount,
  });
}

export const BLUESKY_METRIC_SHAPE: MetricDescriptor[] = [
  { key: "likes", label: "Likes", canonical: "like", means: "People who liked the post." },
  {
    key: "reposts",
    label: "Reposts",
    canonical: "share",
    means: "People who put it on their own timeline unchanged.",
  },
  {
    key: "replies",
    label: "Replies",
    canonical: "reply",
    means: "Direct replies. Not the whole thread below it.",
  },
  {
    key: "quotes",
    label: "Quotes",
    canonical: "quote",
    means: "People who reposted it with their own words attached — agreement and disagreement both.",
  },
];

/* ── Rendering ───────────────────────────────────────────────────────────── */

/**
 * Bluesky's rules, as DATA.
 *
 * There is no length rule anywhere else in this file. A validator and a renderer
 * that both judge length will disagree, and then the validator refuses content
 * the renderer had already solved.
 */
export const BLUESKY_RULES: RenderRules = {
  limit: 300,
  unit: "graphemes",
  thread: true,
  links: true,
  label: "Bluesky",
};

function payloadFor(target: BlueskyTarget): RenderedPayload {
  return target.rendered ?? render(target.text, BLUESKY_RULES);
}

/* ── Delivery ────────────────────────────────────────────────────────────── */

export const BLUESKY_DELIVERY: DeliveryDeclaration = {
  idempotent: false,
  why:
    "com.atproto.repo.createRecord takes no idempotency key and no client-supplied request id, so a repeated " +
    "call creates a SECOND record. An ambiguous failure is therefore reported for a person, who can look at " +
    "the profile — which is something no amount of retry logic can do.",
  // Bluesky publishes a points budget per hour and per day, not a minimum gap
  // between writes, so this floor is OURS. A thread's segments going out
  // back-to-back from inside one call is the case it exists for.
  minIntervalMs: 1_000,
  rateSource: "self-imposed",
  citation: {
    url: "https://docs.bsky.app/docs/rate-limits",
    readOn: "2026-08-19",
    quote:
      "The limit is 5,000 points per hour and 35,000 points per day. … CREATE 3 points … an account may " +
      "create at most 1,666 records per hour and 11,666 records per day.",
  },
};

/* ── The wire ────────────────────────────────────────────────────────────── */

/** The public PDS. A self-hosted PDS is a different base URL and the same code. */
export const BLUESKY_PDS = "https://bsky.social";

/**
 * The XRPC error NAME off a failed response — `AuthenticationRequired`,
 * `InvalidRequest`, `ExpiredToken` — or nothing. Carried as `error.providerCode`.
 *
 * A code a host can route on, because the spec makes it one: an XRPC error body's
 * `error` is the *"type name of the error (generic ASCII constant, no
 * whitespace)"*, and the human sentence lives in `message`
 * (https://atproto.com/specs/xrpc, read 2026-09-13). The real refusal to an
 * impossible app password is
 * `{"error":"AuthenticationRequired","message":"Invalid identifier or password"}`.
 *
 * **Only a value shaped like that name is carried.** Anything with whitespace —
 * a proxy's `{"error":"Bad Gateway"}` — is a sentence that happens to sit in the
 * same field, and publishing it as a code is exactly the Mastodon mistake: the
 * field is called `error` there too, and it holds prose. Pure and exported so the
 * refusal is checkable without a network.
 */
export function blueskyErrorNameFrom(response: TransportResponse): string | undefined {
  let body: unknown;

  try {
    body = JSON.parse(response.body);
  } catch {
    return undefined;
  }

  const name = (body as { error?: unknown } | null)?.error;

  return typeof name === "string" && /^[\x21-\x7E]+$/.test(name) ? name : undefined;
}

export const BLUESKY_SERVICE: ServiceDescriptor = {
  service: "bluesky",
  title: "Bluesky",
  // Bluesky operates no test estate. `fake` and `live` are the honest choices,
  // and asking for `sandbox` fails loudly rather than reaching production.
  sandbox: "none",
  baseUrls: { live: BLUESKY_PDS, sandbox: BLUESKY_PDS },
  requires: ["identifier", "appPassword"],
  authorize: (credentials, request) => {
    // The session JWT is a credential like any other: minted by the first
    // request of a send and passed into the second. It is absent on
    // `createSession` itself, which authenticates with the body — which is why
    // this is a conditional rather than a required header.
    if (credentials.accessJwt) request.headers.Authorization = `Bearer ${credentials.accessJwt}`;
  },
  faker: blueskyFaker,
  providerCodeFrom: blueskyErrorNameFrom,
};

type BlueskySession = { accessJwt?: string; did?: string; handle?: string };

async function openSession(
  mode: ConnectorMode,
  credentials: Record<string, string>,
): Promise<BlueskySession> {
  const result = await callConnector<BlueskySession>(BLUESKY_SERVICE, {
    operation: "session_create",
    mode,
    credentials,
    config: { operation: "session_create" },
    request: {
      method: "POST",
      path: "/xrpc/com.atproto.server.createSession",
      json: { identifier: credentials.identifier ?? "", password: credentials.appPassword ?? "" },
    },
    // Minting a session writes nothing to the repo, so repeating it is harmless
    // — the one request in a Bluesky send that IS safe to retry. The write below
    // is not, and says so.
    idempotent: true,
  });

  return result.data ?? {};
}

/* ── Validation: everything the renderer cannot judge, and NOT length ────── */

export function validateBluesky(target: BlueskyTarget): Problem[] {
  const problems: Problem[] = [];

  if (target.text.trim() === "") {
    problems.push({ severity: "block", message: "There is no copy to post." });
  }

  for (const asset of target.media ?? []) {
    if (!asset.alt) {
      problems.push({
        severity: "block",
        message: `"${asset.file}" has no alt text, and Bluesky surfaces alt text prominently.`,
      });
    }
  }

  return problems;
}

/* ── Standing it up ──────────────────────────────────────────────────────── */

const BLUESKY_VERIFY_PROVES =
  "That the app password is valid right now AND that it reaches the account we believe it does — the DID it " +
  "returns is the part a form cannot check, so a typo in the handle is caught here rather than by a post " +
  "appearing under the wrong name. It does NOT prove anything about a future send: an app password is " +
  "revocable on its own and can stop working between this check and a dispatch.";

export const blueskyProvider: ProviderAdapter = {
  id: "bluesky",
  label: "Bluesky",
  implemented: true,
  summary:
    "AT Protocol. The cheapest real setup here — an app password, no OAuth app, no review queue, no paid tier.",
  // A verify that asked for scopes it did not need would be asking for trouble;
  // an app password has none to ask for. The empty list is the statement.
  scopes: [],
  sandbox: "none",
  // Declared on the ADAPTER as well as on each VerifyResult, because a
  // surface has to be able to say what a check will and will not prove
  // BEFORE anyone runs it. A green tick that means more than it should is
  // worse than no tick, and the moment to say so is while somebody is
  // still deciding whether the setup is finished.
  proves: BLUESKY_VERIFY_PROVES,
  fields: [
    {
      key: "identifier",
      label: "Handle",
      help: "The account this posts as. A DID works too, and is what verify resolves the handle to.",
      scope: "account",
      secret: false,
      required: true,
      placeholder: "brand.bsky.social",
    },
    {
      key: "appPassword",
      label: "App password",
      help:
        "Generated in Settings → Privacy and Security → App Passwords. NEVER the account password — an app " +
        "password is revocable on its own, so a leak costs one integration rather than the account.",
      scope: "account",
      secret: true,
      required: true,
    },
  ],
  setup: [
    {
      title: "Create an app password",
      detail:
        "Settings → Privacy and Security → App Passwords. Use one per integration. The trap is reaching for the " +
        "account password because it is to hand: it works, and it cannot be revoked without locking out " +
        "everything else you have connected.",
      url: "https://bsky.app/settings/app-passwords",
    },
    {
      title: "That is the whole setup",
      detail:
        "No app registration, no review, no scopes. The trap here is expecting more and going looking for a " +
        "developer portal — there isn't one, and the time is better spent running verify below, which resolves " +
        "the handle to its DID and catches a typo before a campaign relies on it.",
    },
  ],
  async verify(credentials): Promise<VerifyResult> {
    if (!credentials.identifier || !credentials.appPassword) {
      return {
        ok: false,
        detail: "Needs both a handle and an app password.",
        proves: BLUESKY_VERIFY_PROVES,
      };
    }

    try {
      const session = await openSession("live", credentials);

      return {
        ok: true,
        detail: `Signed in as ${session.handle ?? "(unknown handle)"} (${session.did ?? "(no did)"}).`,
        proves: BLUESKY_VERIFY_PROVES,
      };
    } catch (error) {
      return {
        ok: false,
        detail:
          error instanceof Error
            ? `${error.message} App passwords are revocable individually, so this may have been revoked rather than mistyped.`
            : String(error),
        proves: BLUESKY_VERIFY_PROVES,
      };
    }
  },
};

/* ── The connector ───────────────────────────────────────────────────────── */

export const blueskyConnector: Connector<BlueskyTarget> = {
  id: "bluesky",
  // The core surface this was written against — a LITERAL, never the
  // imported CONNECTOR_API_VERSION.
  //
  // That distinction is the whole mechanism. This file is VENDORED: it is
  // copied into a consumer's project and frozen there. If it read the
  // constant, then upgrading the core would change what this copy claims
  // to have been written against, and the check would agree with itself
  // forever while the surface moved underneath. A literal is the only
  // value that still means something a year after it was copied.
  connectorApi: 1,
  label: "Bluesky",
  provider: "bluesky",
  capabilities: {
    call: true,
    metrics: true,
    // `getPostThread` would make this reportable, and it is deliberately not
    // built here: this directory is an exemplar of the seam, not the whole
    // surface. `false` says "this cannot tell you" rather than "nobody replied",
    // which are different answers needing different actions.
    feedback: false,
  },
  delivery: BLUESKY_DELIVERY,
  metricShape: BLUESKY_METRIC_SHAPE,
  renderRules: BLUESKY_RULES,
  validate: validateBluesky,

  async call(target, options): Promise<CallResult> {
    // The HOST decides liveness. A dry run is `fake` mode, which runs the same
    // code path down to and including the chaining, against this connector's own
    // faker — so the ref a dry run produces is shaped by the same
    // `blueskyRefFrom` that shapes a live one.
    const mode: ConnectorMode = options.dryRun ? "fake" : (options.mode ?? "live");
    const dryRun = mode === "fake";
    const payload = payloadFor(target);
    const blocking = validateBluesky(target)
      .filter((problem) => problem.severity === "block")
      .map((problem) => problem.message);
    const refusals = [
      ...blocking,
      ...payload.problems,
      ...(isEmptyPayload(payload)
        ? ["The rendered payload is empty. The sha of the empty string is a valid sha, so this has to be refused here."]
        : []),
    ];

    if (refusals.length > 0) {
      return {
        ok: false,
        ref: null,
        dryRun,
        mode,
        detail: `Refused before anything was sent — ${refusals.join(" ")}`,
      };
    }

    const credentials = options.credentials ?? {};
    const session = await openSession(mode, credentials);
    const authed = { ...credentials, accessJwt: session.accessJwt ?? "" };

    const outcome = await postChain<BlueskyRef>(
      payload.segments.map((segment) => segment.text),
      blueskyReplyLinks(target.replyTo),
      async (text, links, index) => {
        // Nothing leaves the building in fake mode, so there is nothing to
        // space. The floor exists for the segments of one thread, which no host
        // can get between because they are one call.
        if (!dryRun) await respectRate("bluesky", BLUESKY_DELIVERY.minIntervalMs);

        const created = await callConnector<{ uri?: string; cid?: string }>(BLUESKY_SERVICE, {
          operation: "post_create",
          mode,
          credentials: authed,
          config: { text, position: index },
          request: {
            method: "POST",
            path: "/xrpc/com.atproto.repo.createRecord",
            json: {
              repo: session.did ?? "",
              collection: "app.bsky.feed.post",
              record: {
                $type: "app.bsky.feed.post",
                text,
                // Byte ranges, computed per segment. An offset into the whole
                // text is meaningless once the text has been split.
                facets: blueskyFacets(text),
                createdAt: new Date().toISOString(),
                ...(links ? { reply: { root: links.root, parent: links.parent } } : {}),
              },
            },
          },
          // The declaration, honoured rather than restated: an ambiguous failure
          // here is never retried, because a second attempt is a second post.
          idempotent: BLUESKY_DELIVERY.idempotent,
        });

        return blueskyRefFrom(created.data);
      },
    );

    const posted = outcome.posted;

    if (outcome.failed) {
      // Part of the thread is public. That is the urgent fact, so it is
      // returned rather than thrown — a throw would hand back a classification
      // and lose the posts.
      if (posted.length === 0) throw outcome.failed.error;

      const reason =
        outcome.failed.error instanceof Error ? outcome.failed.error.message : String(outcome.failed.error);

      return {
        ok: false,
        ref: posted[0]?.uri ?? null,
        dryRun,
        mode,
        detail:
          `Posted ${posted.length} of ${payload.segments.length} messages, then segment ` +
          `${outcome.failed.index + 1} failed: ${reason} The messages already posted are public and were NOT ` +
          "unwound — nothing here can delete a public post, and pretending otherwise would be worse than the hole.",
      };
    }

    return {
      ok: true,
      // The FIRST uri: it is what metrics are read against and the rest of the
      // thread hangs off it.
      ref: posted[0]?.uri ?? null,
      dryRun,
      mode,
      detail: dryRun
        ? `Dry run — would post ${describe(posted.length)} as ${session.handle ?? "the connected account"} ` +
          `(${payload.segments.map((segment) => `${segment.count}/300 graphemes`).join(", ")}). ` +
          "Nothing left the building."
        : `Posted ${describe(posted.length)} as ${session.handle ?? "(unknown handle)"} (${session.did ?? "(no did)"}).`,
    };
  },

  async fetchMetrics(refs, credentials): Promise<MetricSample[]> {
    // Only refs this connector could have produced. Anything else is somebody
    // else's identifier and asking about it would be noise.
    const uris = refs.filter((ref) => ref.startsWith("at://"));
    if (uris.length === 0) return [];

    const session = await openSession("live", credentials);
    const authed = { ...credentials, accessJwt: session.accessJwt ?? "" };
    const at = new Date().toISOString();
    const samples: MetricSample[] = [];

    // `getPosts` caps at 25 uris per call.
    for (let index = 0; index < uris.length; index += 25) {
      const batch = uris.slice(index, index + 25);
      // Repeated query parameters, which `query` cannot express — it sets one
      // value per key. Put in the path so the URL is exactly what AT Protocol
      // documents rather than approximately it.
      const search = batch.map((uri) => `uris=${encodeURIComponent(uri)}`).join("&");

      const result = await callConnector<{ posts?: BlueskyPostView[] }>(BLUESKY_SERVICE, {
        operation: "posts_get",
        mode: "live",
        credentials: authed,
        config: { uris: batch },
        request: { method: "GET", path: `/xrpc/app.bsky.feed.getPosts?${search}` },
        // A read. Repeating it changes nothing, so an ambiguous failure here is
        // genuinely safe to retry — unlike every write on this connector.
        idempotent: true,
      });

      for (const post of result.data?.posts ?? []) {
        if (typeof post.uri !== "string") continue;
        samples.push({ ref: post.uri, at, metrics: blueskyMetricsFrom(post) });
      }
    }

    // A uri the provider did not answer for is simply absent. A zeroed entry
    // would say "nobody engaged" where the truth is "we do not know".
    return samples;
  },
};

function describe(count: number): string {
  return count === 1 ? "1 post" : `a ${count}-post thread`;
}
