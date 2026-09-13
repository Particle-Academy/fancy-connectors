/**
 * Mastodon — the fediverse, and the one variable no other provider here has.
 *
 * Vendored source. It imports from `*`; a consumer who copies this
 * directory rewrites those to `@particle-academy/fancy-connector-core`.
 *
 * ## The variable: there is no single host
 *
 * Mastodon is thousands of independent servers. Every call needs the instance as
 * well as the token, and **a token is valid on exactly one of them** — so the
 * instance is a credential-adjacent field (`scope: "account"`), not a constant,
 * and a perfectly good token pasted against the wrong server fails with a 401
 * that reads as a bad token. The field help says so, because the usual next move
 * is to re-issue a token that was never the problem.
 *
 * ## And the second one: the limit is the instance's, not Mastodon's
 *
 * 500 characters is the default. Instances configure it and many raise it. The
 * limit is therefore **passed IN as a render rule**, resolved by the caller from
 * `GET /api/v2/instance` → `configuration.statuses.max_characters`, so it
 * becomes part of what was approved rather than something this connector
 * resolves later behind the approver's back. `render` stays pure; if the
 * instance changes the number afterwards, re-rendering differs and a host that
 * compares payload hashes refuses the send. That is the correct outcome.
 *
 * ## How `call` reports
 *
 * Identical to the other three connectors in this catalogue:
 * `ok: false` + `ref: null` when it refused before touching the network;
 * `ok: false` + a non-null `ref` when part of a thread went out and a later
 * segment failed; a throw carrying a classified `ConnectorError` otherwise;
 * never `ok: true` with a null `ref`.
 */

import {
  ConnectorAmbiguous,
  ConnectorConfigError,
  callConnector,
  isEmptyPayload,
  postChain,
  render,
  reported,
  respectRate,
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
  type VerifyResult,
} from "@particle-academy/fancy-connector-core";

import { mastodonFaker } from "./faker.ts";

/* ── The host's content, as this connector needs it ──────────────────────── */

export type MastodonTarget = {
  /** The copy, exactly as approved. */
  text: string;
  /** What the instance will ACTUALLY receive, already rendered and approved. */
  rendered?: RenderedPayload;
  /** Assets and their alt text. The renderer cannot judge either. */
  media?: Array<{ file: string; alt: string | null }>;
  /** What this answers, when it is a reply. Mastodon needs one status id. */
  replyTo?: { provider: string; context: Record<string, string> };
};

/* ── The instance, which is a value a human pastes ───────────────────────── */

/**
 * Accept what a person would actually paste.
 *
 * `mastodon.social`, `https://mastodon.social` and a URL with a trailing slash
 * all mean the same server. Rejecting two of the three would be pedantry dressed
 * as validation, and the person would be right to be annoyed.
 */
export function normaliseInstance(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return null;

  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);

    return url.hostname ? `https://${url.hostname}` : null;
  } catch {
    return null;
  }
}

/* ── Refs ────────────────────────────────────────────────────────────────── */

/**
 * A status, as this connector holds it.
 *
 * **The id you post with is not the id you store.** `in_reply_to_id` wants the
 * instance's own id; what a person needs to see is the URL. Conflating them is
 * how a reply 404s, so both travel together.
 *
 * A `type` alias rather than an `interface`: only an alias gets the implicit
 * index signature that satisfies `ChainRef`.
 */
export type MastodonRef = { id: string; url: string };

export function mastodonRefFrom(status: unknown): MastodonRef {
  const bag = (status ?? {}) as { id?: unknown; url?: unknown };
  const id = typeof bag.id === "string" ? bag.id : "";

  if (id === "") {
    throw new ConnectorAmbiguous(
      "The instance accepted the status but returned no id, so there is nothing to record it as and nothing " +
        "to chain the rest of a thread onto. It has probably been posted — go and look. (A retry would carry " +
        "the same Idempotency-Key and so would be safe, but only inside the instance's one-hour window.)",
      { service: "mastodon", operation: "status_create" },
    );
  }

  return { id, url: typeof bag.url === "string" ? bag.url : "" };
}

/**
 * The ref a host stores: the public URL when there is one, the instance's id
 * otherwise. Never an invented URL — a link that 404s looks checkable.
 */
export function mastodonStoredRef(ref: MastodonRef): string {
  return ref.url !== "" ? ref.url : ref.id;
}

/** The instance's id, back out of whichever of the two we stored. */
export function mastodonStatusId(storedRef: string): string {
  return storedRef.startsWith("http") ? (storedRef.split("/").pop() ?? "") : storedRef;
}

/** What `target.replyTo` means here, or nothing if it is not ours. */
export function mastodonReplyLinks(
  replyTo: MastodonTarget["replyTo"],
): ChainLinks<MastodonRef> | undefined {
  if (replyTo?.provider !== "mastodon") return undefined;

  const statusId = replyTo.context.statusId ?? "";
  if (statusId === "") return undefined;

  const parent: MastodonRef = { id: statusId, url: replyTo.context.statusUrl ?? "" };

  // Mastodon threads on `in_reply_to_id` alone, so only the parent is read. The
  // root travels anyway because `postChain` carries it, and carrying an unused
  // value costs nothing next to a chain builder that behaves differently per
  // provider.
  return { root: parent, parent };
}

/* ── Idempotency, keyed on the APPROVED BYTES ────────────────────────────── */

/**
 * The `Idempotency-Key` for one segment: the SHA-256 of its text.
 *
 * **Bytes, not a run identity, and the trade is deliberate.** A key derived from
 * the bytes is the same on a retry after a process restart, when no run identity
 * survives — which is the failure a network retry actually presents. The cost is
 * that posting the *same text twice on purpose* inside the instance's window
 * collapses into one status. For a daily "good morning" that is a real
 * surprise, and a host that wants it should vary the bytes or send its own key.
 *
 * **The window is one hour.** Mastodon's own documentation: "Idempotency keys
 * are stored for up to 1 hour." Past that the instance has forgotten the key and
 * a retry posts again — so a host using `idempotencyKeyFor()` from
 * `idempotency.ts` must pass `windowSeconds: 3600`, because that module's
 * default is Stripe's 24 hours and would let a stale retry through.
 *
 * WebCrypto, which is the only hash available on every runtime the suite
 * supports — the same choice `render.ts` makes for `payloadHash`.
 */
export async function mastodonIdempotencyKey(segmentText: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;

  if (!subtle) {
    throw new ConnectorConfigError(
      "WebCrypto is not available in this runtime, so an Idempotency-Key cannot be derived from the approved " +
        "bytes. Refusing rather than sending without one: a weaker key that a host trusted equally would turn " +
        "a retry into a second public post.",
      { service: "mastodon", operation: "status_create" },
    );
  }

  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(segmentText));

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/* ── Metrics: the mapping is a PURE function, so the shape is checkable ──── */

export type MastodonStatus = {
  id?: string;
  url?: string;
  favourites_count?: number;
  reblogs_count?: number;
  replies_count?: number;
};

/**
 * One status's counts, from one status's API object.
 *
 * Pure and exported so the declared shape can be checked against what this
 * really returns, with a synthetic response and no credentials.
 *
 * **Absent stays absent** via `reported()`.
 */
export function mastodonMetricsFrom(status: MastodonStatus): Record<string, number> {
  return reported({
    favourites: status.favourites_count,
    reblogs: status.reblogs_count,
    replies: status.replies_count,
  });
}

/**
 * Three entries, and the absence of a fourth is the statement.
 *
 * The key is the API's word (`reblogs_count`) and the label is the interface's
 * (Boost). Those two genuinely differ here and picking one for both would make
 * either the wire or the screen wrong.
 *
 * **On quotes.** This shape has no quote entry, because the mapping does not
 * read one — and a declared key nothing produces is exactly the drift
 * `compareShape` exists to catch. Note that this is no longer a statement about
 * Mastodon itself: quote posts landed in 4.5 and the Status entity carries
 * `quotes_count` as of API 4.7 (checked 2026-08-19). The reason to leave it out
 * is fleet version spread, not absence of the concept — see the README for
 * exactly what to add when your instances have caught up.
 */
export const MASTODON_METRIC_SHAPE: MetricDescriptor[] = [
  {
    key: "favourites",
    label: "Favourites",
    canonical: "like",
    means: "The same act Bluesky calls a like.",
  },
  {
    key: "reblogs",
    label: "Boosts",
    canonical: "share",
    means: "The same act Bluesky calls a repost. The API says reblog; the interface says boost.",
  },
  {
    key: "replies",
    label: "Replies",
    canonical: "reply",
    means: "Direct replies, as this instance counts them.",
  },
];

/* ── Rendering ───────────────────────────────────────────────────────────── */

/** Mastodon's default. Instances configure it, and many raise it. */
export const MASTODON_DEFAULT_MAX_CHARACTERS = 500;

/**
 * The declared default. `render(target, { maxCharacters })` overrides the limit
 * with the instance's real number, which the CALLER resolves.
 */
export const MASTODON_RULES: RenderRules = {
  limit: MASTODON_DEFAULT_MAX_CHARACTERS,
  unit: "characters",
  thread: true,
  label: "Mastodon",
};

export function renderMastodon(target: MastodonTarget, rules?: Record<string, number>): RenderedPayload {
  return render(target.text, {
    ...MASTODON_RULES,
    limit: rules?.maxCharacters ?? MASTODON_DEFAULT_MAX_CHARACTERS,
  });
}

function payloadFor(target: MastodonTarget): RenderedPayload {
  return target.rendered ?? renderMastodon(target);
}

/* ── Delivery ────────────────────────────────────────────────────────────── */

export const MASTODON_DELIVERY: DeliveryDeclaration = {
  idempotent: true,
  why:
    "Mastodon honours an Idempotency-Key header on POST /api/v1/statuses, and this connector derives it from " +
    "the SHA-256 of each segment's approved bytes — so a retried request is the same request to the instance " +
    "even across a process restart. The instance stores keys for one hour; past that a retry posts again, so " +
    "a host must not treat this flag as unbounded.",
  // Mastodon documents a BUDGET — 300 requests per 5 minutes per account — not a
  // minimum gap. 1000ms is our spacing of their number, so it is labelled ours.
  minIntervalMs: 1_000,
  rateSource: "self-imposed",
  citation: {
    url: "https://docs.joinmastodon.org/api/rate-limits/",
    readOn: "2026-08-19",
    quote:
      "Per account: All endpoints and methods can be called 300 times within 5 minutes. " +
      "(A budget, not a floor — the 1000ms gap is ours, and instances may configure their own limits.)",
  },
};

/* ── The wire ────────────────────────────────────────────────────────────── */

/**
 * A descriptor per instance, because the base URL IS a credential here.
 *
 * Built per call rather than held as a module constant: `ServiceDescriptor` is
 * data, and the alternative — one descriptor with a mutable base URL — is a
 * global that two concurrent sends to two instances would fight over.
 */
export function mastodonService(instance: string): ServiceDescriptor {
  return {
    service: "mastodon",
    title: "Mastodon",
    // No provider-published test estate. A scratch instance you host yourself is
    // a second real server that federates, not a sandbox — so `fake` and `live`
    // are the honest choices and `sandbox` fails loudly.
    sandbox: "none",
    baseUrls: { live: instance, sandbox: instance },
    requires: ["instance", "accessToken"],
    authorize: (credentials, request) => {
      request.headers.Authorization = `Bearer ${credentials.accessToken ?? ""}`;
    },
    faker: mastodonFaker,
    idempotencyHeader: "Idempotency-Key",
    // NO `providerCodeFrom`, deliberately — and `tests/provider-codes.test.ts`
    // fails if one is added.
    //
    // Mastodon's error body has a field called `error`, the same name as
    // Bluesky's, and it is not a code. The Error entity documents it as "The
    // error message." (https://docs.joinmastodon.org/entities/Error/, read
    // 2026-09-13), and the real refusal to an impossible token is
    // `{"error":"The access token is invalid"}` — a sentence, which an instance
    // is free to reword or translate. The docs' own example of a code-shaped
    // `error` (`invalid_grant`) comes from the OAuth endpoints, which this
    // connector never calls. So there is no stable code to carry: the status is
    // the machine-readable answer, and a reader here would publish prose as
    // something a host routes on.
  };
}

/**
 * The instance a call runs against, or a refusal naming the field.
 *
 * `fake` mode gets the faker's own host rather than nothing, so a dry run
 * produces a ref of the right shape before any credential exists.
 */
function instanceFor(credentials: Record<string, string>, dryRun: boolean): string {
  const instance = normaliseInstance(credentials.instance ?? "");

  if (instance) return instance;
  if (dryRun) return "https://mastodon.example.test";

  throw new ConnectorConfigError(
    'No Mastodon instance. Mastodon is thousands of independent servers, so the instance is part of the ' +
      'connection — set `instance` (e.g. "mastodon.social"). There is deliberately no default: a default ' +
      "would post one account's voice from another server.",
    { service: "mastodon", operation: "status_create" },
  );
}

/* ── Validation: everything the renderer cannot judge, and NOT length ────── */

export function validateMastodon(target: MastodonTarget): Problem[] {
  const problems: Problem[] = [];

  if (target.text.trim() === "") {
    problems.push({ severity: "block", message: "There is no copy to post." });
  }

  for (const asset of target.media ?? []) {
    if (!asset.alt) {
      problems.push({
        severity: "block",
        message:
          `"${asset.file}" has no alt text. The fediverse is unusually strict about this culturally, so a ` +
          "post without it reads as careless as well as being unreadable.",
      });
    }
  }

  return problems;
}

/* ── Standing it up ──────────────────────────────────────────────────────── */

const MASTODON_VERIFY_PROVES =
  "That the token is valid ON THIS INSTANCE and names the account it acts as — which catches the single most " +
  "common setup failure, a good token pasted against the wrong server. It does NOT prove the token can POST: " +
  "verify_credentials needs only a read scope, so a token issued without write:statuses passes this check and " +
  "is refused at send time. It also says nothing about the instance's character limit, which the caller " +
  "resolves separately and passes into render.";

export const mastodonProvider: ProviderAdapter = {
  id: "mastodon",
  label: "Mastodon",
  implemented: true,
  summary:
    "The fediverse. No app review, no paid tier — but thousands of independent servers, so the instance is " +
    "part of the connection.",
  scopes: ["write:statuses", "read:accounts", "read:statuses"],
  sandbox: "none",
  // Declared on the ADAPTER as well as on each VerifyResult, because a
  // surface has to be able to say what a check will and will not prove
  // BEFORE anyone runs it. A green tick that means more than it should is
  // worse than no tick, and the moment to say so is while somebody is
  // still deciding whether the setup is finished.
  proves: MASTODON_VERIFY_PROVES,
  fields: [
    {
      key: "instance",
      label: "Instance",
      help:
        "The server this account lives on. A token is valid on exactly ONE instance, so this is not cosmetic: " +
        "mastodon.social and any other server are different systems. Paste the hostname or the URL; both work.",
      // Credential-adjacent rather than secret: it is not a secret, and it is
      // per account rather than per installation, because two accounts are two
      // servers as often as not.
      scope: "account",
      secret: false,
      required: true,
      placeholder: "mastodon.social",
    },
    {
      key: "accessToken",
      label: "Access token",
      help:
        "Settings → Development → New application, on that instance. Ask for write:statuses to post, " +
        "read:accounts so verify can name the account, read:statuses so engagement can be read back — and " +
        "nothing more.",
      scope: "account",
      secret: true,
      required: true,
    },
  ],
  setup: [
    {
      title: "Pick the instance this account posts from",
      detail:
        "Everything below happens on that server. **The trap:** a token issued on a different instance looks " +
        "identical and fails with a 401, which reads as a bad token — so the usual next move is to re-issue a " +
        "token that was never the problem.",
    },
    {
      title: "Create an application on that instance",
      detail:
        "Settings → Development → New application. **The trap:** the scope checkboxes default to more than " +
        "you need, and the one you actually need — write:statuses — is easy to miss while unticking the rest. " +
        "A token without it passes verify and is refused at send time.",
    },
    {
      title: "Copy the access token",
      detail:
        "The application page shows it directly. **The trap:** looking for an OAuth round trip or a review " +
        "queue. There isn't one; that is the whole setup.",
    },
    {
      title: "Read the instance's character limit and pass it to render",
      detail:
        "GET /api/v2/instance → configuration.statuses.max_characters. **The trap:** hardcoding 500. Many " +
        "instances raise it, and a hardcoded limit refuses posts the server would happily accept. The CALLER " +
        "resolves it and passes it in as `{ maxCharacters }`, so the number is part of what was approved.",
      url: "https://docs.joinmastodon.org/methods/instance/",
    },
  ],
  async verify(credentials): Promise<VerifyResult> {
    const instance = normaliseInstance(credentials.instance ?? "");

    if (!instance) {
      return { ok: false, detail: "Needs an instance — e.g. mastodon.social.", proves: MASTODON_VERIFY_PROVES };
    }
    if (!credentials.accessToken) {
      return { ok: false, detail: "Needs an access token.", proves: MASTODON_VERIFY_PROVES };
    }

    try {
      const result = await callConnector<{ acct?: string; url?: string }>(mastodonService(instance), {
        operation: "account_verify",
        mode: "live",
        credentials: { ...credentials, instance },
        config: { instance },
        request: { method: "GET", path: "/api/v1/accounts/verify_credentials" },
        idempotent: true,
      });

      return {
        ok: true,
        detail:
          `Signed in as @${result.data?.acct ?? "(unknown)"} (${result.data?.url ?? instance}). ` +
          `The token is valid on ${instance}.`,
        proves: MASTODON_VERIFY_PROVES,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        ok: false,
        detail:
          `${message} Mastodon tokens are per-instance, so a 401 also happens when a perfectly good token is ` +
          `pasted against the wrong server; a 404 usually means ${instance} has no Mastodon API at that ` +
          "address, and a typo there looks exactly like an outage.",
        proves: MASTODON_VERIFY_PROVES,
      };
    }
  },
};

/* ── The connector ───────────────────────────────────────────────────────── */

export const mastodonConnector: Connector<MastodonTarget> = {
  id: "mastodon",
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
  label: "Mastodon",
  provider: "mastodon",
  capabilities: { call: true, metrics: true, feedback: false },
  delivery: MASTODON_DELIVERY,
  metricShape: MASTODON_METRIC_SHAPE,
  // The DEFAULT, declared. `render` below takes the instance's real number.
  renderRules: MASTODON_RULES,
  validate: validateMastodon,
  render: renderMastodon,

  async call(target, options): Promise<CallResult> {
    const mode: ConnectorMode = options.dryRun ? "fake" : (options.mode ?? "live");
    const dryRun = mode === "fake";
    const payload = payloadFor(target);
    const blocking = validateMastodon(target)
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
    const instance = instanceFor(credentials, dryRun);
    const service = mastodonService(instance);

    const outcome = await postChain<MastodonRef>(
      payload.segments.map((segment) => segment.text),
      mastodonReplyLinks(target.replyTo),
      async (text, links, index) => {
        if (!dryRun) await respectRate("mastodon", MASTODON_DELIVERY.minIntervalMs);

        const created = await callConnector<MastodonStatus>(service, {
          operation: "status_create",
          mode,
          credentials: { ...credentials, instance },
          config: { instance, text, position: index },
          request: {
            method: "POST",
            path: "/api/v1/statuses",
            json: {
              status: text,
              visibility: "public",
              // One `in_reply_to_id` walks the chain forward. `postChain` fixes
              // the root and advances the parent; Mastodon reads the parent.
              ...(links ? { in_reply_to_id: links.parent.id } : {}),
            },
          },
          // Keyed per SEGMENT on its approved bytes, so a retry of message 2 is
          // the same request while message 1 stays put.
          idempotencyKey: await mastodonIdempotencyKey(text),
          idempotent: MASTODON_DELIVERY.idempotent,
        });

        return mastodonRefFrom(created.data);
      },
    );

    const posted = outcome.posted;

    if (outcome.failed) {
      if (posted.length === 0) throw outcome.failed.error;

      const reason =
        outcome.failed.error instanceof Error ? outcome.failed.error.message : String(outcome.failed.error);

      return {
        ok: false,
        ref: mastodonStoredRef(posted[0]!),
        dryRun,
        mode,
        detail:
          `Posted ${posted.length} of ${payload.segments.length} statuses, then segment ` +
          `${outcome.failed.index + 1} failed: ${reason} The statuses already posted are public and were NOT ` +
          "unwound.",
      };
    }

    return {
      ok: true,
      ref: posted[0] ? mastodonStoredRef(posted[0]) : null,
      dryRun,
      mode,
      detail: dryRun
        ? `Dry run — would post ${describe(posted.length)} to ${instance} ` +
          `(${payload.segments.map((segment) => `${segment.count}/${payload.limit ?? "no limit"}`).join(", ")} ` +
          "characters). Nothing left the building."
        : `Posted ${describe(posted.length)} to ${instance}.`,
    };
  },

  async fetchMetrics(refs, credentials): Promise<MetricSample[]> {
    const instance = normaliseInstance(credentials.instance ?? "");
    if (!instance) return [];

    const service = mastodonService(instance);
    const at = new Date().toISOString();
    const samples: MetricSample[] = [];

    for (const ref of refs) {
      const id = mastodonStatusId(ref);
      if (id === "") continue;

      const result = await callConnector<MastodonStatus>(service, {
        operation: "status_get",
        mode: "live",
        credentials: { ...credentials, instance },
        config: { instance, statusId: id },
        request: { method: "GET", path: `/api/v1/statuses/${encodeURIComponent(id)}` },
        idempotent: true,
      });

      const status = result.data;
      if (!status) continue;

      // The ref the HOST gave us, echoed back — not the one the instance
      // happens to prefer. A sample keyed on something the host does not hold
      // joins to nothing.
      samples.push({ ref, at, metrics: mastodonMetricsFrom(status) });
    }

    return samples;
  },
};

function describe(count: number): string {
  return count === 1 ? "1 status" : `a ${count}-status thread`;
}
