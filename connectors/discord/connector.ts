/**
 * Discord — a channel webhook, which is the whole reason it is worth having.
 *
 * Vendored source. It imports from `*`; a consumer who copies this
 * directory rewrites those to `@particle-academy/fancy-connector-core`.
 *
 * ## Three facts that shape every line below
 *
 * 1. **The webhook URL IS the credential.** It carries its token in the path.
 *    `secret: true` is chosen on the field, never inferred from the type — the
 *    reference implementation very nearly stored it as configuration because it
 *    looks like a URL, and anyone holding it can post to that channel.
 * 2. **`?wait=true` is not optional.** Without it Discord answers
 *    `204 No Content` and there is no id — so no ref, so nothing every later
 *    question can be joined on. **A 2xx with no id is a failure here**, raised
 *    rather than reported as a success nobody can point at.
 * 3. **A webhook cannot read.** No reactions, no replies, no counts. So
 *    `capabilities.metrics` is `false` and there is **no `metricShape` at all**
 *    — not an empty one. An empty shape would say "reports nothing yet" where
 *    the truth is "will never", and those need opposite actions.
 *
 * ## How `call` reports
 *
 * `ok: false` + `ref: null` when it refused before touching the network; a throw
 * carrying a classified `ConnectorError` otherwise; never `ok: true` with a null
 * `ref`. There is no partial case here — a webhook message is one request.
 */

import {
  ConnectorAmbiguous,
  ConnectorConfigError,
  callConnector,
  isEmptyPayload,
  render,
  respectRate,
  type CallResult,
  type Connector,
  type ConnectorMode,
  type DeliveryDeclaration,
  type Problem,
  type ProviderAdapter,
  type RenderRules,
  type RenderedPayload,
  type ServiceDescriptor,
  type TransportResponse,
  type VerifyResult,
} from "@particle-academy/fancy-connector-core";

import { discordFaker } from "./faker.ts";

/* ── The host's content, as this connector needs it ──────────────────────── */

export type DiscordTarget = {
  /** The copy, exactly as approved. */
  text: string;
  /** What Discord will ACTUALLY receive, already rendered and approved. */
  rendered?: RenderedPayload;
  /** Assets and their alt text. Discord has screen-reader users like anywhere. */
  media?: Array<{ file: string; alt: string | null }>;
};

/* ── The credential, which is a URL and is entirely a secret ─────────────── */

export type DiscordWebhookParts = { origin: string; path: string };

/**
 * Split a webhook URL into the base and the path that carries its token.
 *
 * Also the validation: a channel link, an invite, or a truncated copy-paste all
 * look like URLs and none of them can post. Catching that here means the failure
 * names the mistake instead of arriving as a 404 twenty minutes later.
 *
 * `/api/v10/webhooks/…` is accepted as well as `/api/webhooks/…`, because
 * Discord's own copy button has emitted both.
 */
export function discordWebhookParts(webhookUrl: string): DiscordWebhookParts {
  const raw = webhookUrl.trim();
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorConfigError(
      "The Discord `webhookUrl` is not a URL. Copy it with the channel's own Integrations → Webhooks → Copy " +
        "Webhook URL button; a channel link or an invite will not work.",
      { service: "discord", operation: "webhook_execute" },
    );
  }

  if (url.protocol !== "https:" || !/^\/api\/(v\d+\/)?webhooks\/[^/]+\/[^/]+/.test(url.pathname)) {
    throw new ConnectorConfigError(
      `"${url.origin}${url.pathname}" is not a Discord webhook URL — it should look like ` +
        "https://discord.com/api/webhooks/<id>/<token>. A channel link or an invite will not work, and a " +
        "truncated copy fails the same way.",
      { service: "discord", operation: "webhook_execute" },
    );
  }

  return { origin: url.origin, path: url.pathname };
}

/* ── Refs ────────────────────────────────────────────────────────────────── */

/**
 * The message id out of an execute-webhook response, or a failure.
 *
 * **A 2xx with no id is a failure.** It happens when `?wait=true` was not sent:
 * Discord answers `204 No Content`, the message exists, and we cannot say what
 * it produced. `ConnectorAmbiguous` rather than a plain error, because that is
 * exactly the situation — the message probably went out, so a retry would post a
 * second one, and `ambiguous` on a connector declaring `idempotent: false` means
 * "report this for a person" rather than "try again".
 */
export function discordRefFrom(message: unknown): { id: string; channelId: string | null } {
  const bag = (message ?? {}) as { id?: unknown; channel_id?: unknown };
  const id = typeof bag.id === "string" ? bag.id : "";

  if (id === "") {
    throw new ConnectorAmbiguous(
      "Discord accepted the message but returned no id, so there is nothing to record it as and every later " +
        "join is broken. This is what a webhook answers without `?wait=true` — a 204 No Content. The message " +
        "has probably been posted: go and look at the channel rather than re-running, because the webhook " +
        "endpoint takes no idempotency key.",
      { service: "discord", operation: "webhook_execute" },
    );
  }

  return { id, channelId: typeof bag.channel_id === "string" ? bag.channel_id : null };
}

/**
 * The public URL of a message, when we know which guild it is in.
 *
 * Best-effort and honest about it: an execute response carries `channel_id` but
 * not a guild, so this needs the guild from `verify`'s webhook record. A link
 * built from a guessed guild would 404 for the person who clicked it, and null
 * is better than a broken link because a broken link looks checkable.
 */
export function discordMessageUrl(
  guildId: string | null,
  channelId: string | null,
  messageId: string,
): string | null {
  if (!guildId || !channelId) return null;

  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/* ── Rendering ───────────────────────────────────────────────────────────── */

/**
 * 2000 characters, and **`thread: false`**.
 *
 * A webhook has no thread mechanism it can use: `thread_id` posts INTO an
 * existing thread somebody already made, and it cannot create one. So
 * over-length copy is REFUSED rather than split — splitting would invent a
 * structure the webhook does not have and post two unrelated messages numbered
 * as if they were connected, which is worse than a refusal because it looks
 * deliberate.
 */
export const DISCORD_RULES: RenderRules = {
  limit: 2_000,
  unit: "characters",
  thread: false,
  label: "Discord",
};

function payloadFor(target: DiscordTarget): RenderedPayload {
  return target.rendered ?? render(target.text, DISCORD_RULES);
}

/* ── Delivery ────────────────────────────────────────────────────────────── */

export const DISCORD_DELIVERY: DeliveryDeclaration = {
  idempotent: false,
  why:
    "The execute-webhook endpoint takes no idempotency key and no client-supplied nonce, so a repeated POST " +
    "posts a second message. An ambiguous failure is reported for a person, who can look at the channel.",
  // 400ms is 5 requests per 2 seconds, the figure everyone quotes. Discord's own
  // rate-limit documentation does NOT publish it: it says webhooks are a
  // top-level bucket and that the actual limits arrive per response in
  // X-RateLimit-* headers. So the number is OURS and is labelled ours — the
  // reference implementation called this "documented" and it is not.
  minIntervalMs: 400,
  rateSource: "self-imposed",
  citation: {
    url: "https://discord.com/developers/docs/topics/rate-limits",
    readOn: "2026-08-19",
    quote:
      "Top-level resources are currently limited to channels (channel_id), guilds (guild_id), and webhooks " +
      "(webhook_id or webhook_id + webhook_token). — the doc names the bucket and returns the real limits in " +
      "X-RateLimit-* headers; it publishes no fixed figure for this route, so 400ms is our floor.",
  },
};

/* ── The wire ────────────────────────────────────────────────────────────── */

/**
 * Discord's JSON error code off a failed response — `10015` for an unknown
 * webhook, `50027` for an invalid webhook token — or nothing. Carried as
 * `error.providerCode` (the core turns the integer into its decimal string).
 *
 * Discord documents these as the machine half of an error: *"Along with the HTTP
 * error code, our API can also return more detailed error codes through a `code`
 * key in the JSON error response. The response will also contain a `message` key
 * containing a more friendly error string."*
 * (https://docs.discord.com/developers/topics/opcodes-and-status-codes#json,
 * read 2026-09-13). The real refusal to an impossible webhook is
 * `{"message": "Unknown Webhook", "code": 10015}`.
 *
 * It is worth more here than on most providers, because a webhook's 404 IS its
 * auth answer: the status says "no such webhook or wrong token" and only the
 * code says which. **Only an integer is carried** — the documented type — so a
 * 429 body (no `code`) or an edge proxy's HTML page produces nothing rather than
 * a guess. Pure and exported so that is checkable without a network.
 */
export function discordErrorCodeFrom(response: TransportResponse): number | undefined {
  let body: unknown;

  try {
    body = JSON.parse(response.body);
  } catch {
    return undefined;
  }

  const code = (body as { code?: unknown } | null)?.code;

  return typeof code === "number" && Number.isSafeInteger(code) ? code : undefined;
}

/**
 * A descriptor per webhook, because the URL is both the host and the credential.
 *
 * `authorize` is deliberately empty and deliberately present: the token is a
 * PATH SEGMENT, so there is no header to add — and writing that down is what
 * stops someone adding a `Bearer` line that would do nothing while looking
 * correct. It also means the credential appears in any logged URL, which is why
 * a host must not log request URLs for this connector.
 */
export function discordService(parts: DiscordWebhookParts): ServiceDescriptor {
  return {
    service: "discord",
    title: "Discord",
    // A webhook has no test estate. There is no staging Discord.
    sandbox: "none",
    baseUrls: { live: parts.origin, sandbox: parts.origin },
    requires: ["webhookUrl"],
    authorize: () => {
      // Nothing. The token is in the path — see the note above.
    },
    faker: discordFaker,
    providerCodeFrom: discordErrorCodeFrom,
  };
}

/* ── Validation: everything the renderer cannot judge, and NOT length ────── */

export function validateDiscord(target: DiscordTarget): Problem[] {
  const problems: Problem[] = [];

  if (target.text.trim() === "") {
    problems.push({ severity: "block", message: "There is no copy to post." });
  }

  for (const asset of target.media ?? []) {
    if (!asset.alt) {
      problems.push({
        severity: "block",
        message: `"${asset.file}" has no alt text. Discord has readers using screen readers like anywhere else.`,
      });
    }
  }

  return problems;
}

/* ── Standing it up ──────────────────────────────────────────────────────── */

const DISCORD_VERIFY_PROVES =
  "That the token inside the URL is live and names the channel the webhook is bound to — so a URL copied from " +
  "the wrong channel is caught now rather than by a post appearing somewhere unexpected. It does NOT prove the " +
  "webhook will still exist at send time (a channel owner can delete it in two clicks, and there is no " +
  "notification), and it says nothing about engagement, because a webhook cannot read.";

export const discordProvider: ProviderAdapter = {
  id: "discord",
  label: "Discord",
  implemented: true,
  summary: "Posts to one channel through a webhook. No app, no OAuth, no review — a channel owner pastes a URL.",
  // A webhook grants exactly one thing and asks for nothing else. Stating the
  // empty list is the point: there is no consent screen and no scope creep.
  scopes: [],
  sandbox: "none",
  // Declared on the ADAPTER as well as on each VerifyResult, because a
  // surface has to be able to say what a check will and will not prove
  // BEFORE anyone runs it. A green tick that means more than it should is
  // worse than no tick, and the moment to say so is while somebody is
  // still deciding whether the setup is finished.
  proves: DISCORD_VERIFY_PROVES,
  fields: [
    {
      key: "webhookUrl",
      label: "Webhook URL",
      help:
        "The channel's Integrations → Webhooks → Copy Webhook URL. It carries a TOKEN IN ITS PATH, so treat it " +
        "exactly like a password: anyone holding it can post to that channel, and it is never shown back.",
      scope: "account",
      // Chosen per field, never inferred from the type. It is a URL and it is
      // entirely a secret; storing it as configuration is the near-miss this
      // whole field model exists to prevent.
      secret: true,
      required: true,
      placeholder: "https://discord.com/api/webhooks/…",
    },
  ],
  setup: [
    {
      title: "Make the webhook in the channel you actually want",
      detail:
        "**The trap:** creating it from Server Settings → Integrations, where every channel is in a dropdown " +
        "and the default is whichever one is first. A webhook is bound to ONE channel and cannot be " +
        "redirected — only deleted and remade. Open the channel's own settings instead, so the channel you " +
        "are looking at is the channel it posts to.",
      url: "https://support.discord.com/hc/en-us/articles/228383668",
    },
    {
      title: "Store the URL as a SECRET",
      detail:
        "**The trap:** it looks like a URL, so it lands in configuration, a log line, or a screenshot. It " +
        "carries its token in the path — anyone who reads it can post to that channel until someone notices " +
        "and deletes the webhook.",
    },
    {
      title: "Know what it cannot do",
      detail:
        "**The trap:** planning to report engagement from this channel. A webhook can post and nothing else — " +
        "no reactions, no replies, no counts. Reading needs a bot with its own token, its own permissions and " +
        "its own conversation with the server owner, which is a different integration.",
    },
  ],
  async verify(credentials): Promise<VerifyResult> {
    if (!credentials.webhookUrl) {
      return { ok: false, detail: "Needs the webhook URL.", proves: DISCORD_VERIFY_PROVES };
    }

    let parts: DiscordWebhookParts;

    try {
      parts = discordWebhookParts(credentials.webhookUrl);
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        proves: DISCORD_VERIFY_PROVES,
      };
    }

    try {
      // A GET on the webhook returns its own record. Read-only by construction:
      // there is no way for this call to post anything, which is what makes it
      // safe to run from a setup screen.
      const result = await callConnector<{ name?: string; channel_id?: string; guild_id?: string }>(
        discordService(parts),
        {
          operation: "webhook_get",
          mode: "live",
          credentials,
          request: { method: "GET", path: parts.path },
          idempotent: true,
        },
      );

      return {
        ok: true,
        detail:
          `Reached webhook "${result.data?.name ?? "(unnamed)"}" on channel ` +
          `${result.data?.channel_id ?? "(unknown)"}. It is valid and can post there.`,
        proves: DISCORD_VERIFY_PROVES,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        ok: false,
        detail:
          `${message} Discord answers 404 — not 401 — for a webhook it does not recognise, so this also means ` +
          "the webhook was deleted or the token part of the URL is wrong or truncated.",
        proves: DISCORD_VERIFY_PROVES,
      };
    }
  },
};

/* ── The connector ───────────────────────────────────────────────────────── */

export const discordConnector: Connector<DiscordTarget> = {
  id: "discord",
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
  label: "Discord",
  provider: "discord",
  // No metrics, and therefore NO metricShape below — not an empty one.
  capabilities: { call: true, metrics: false, feedback: false },
  delivery: DISCORD_DELIVERY,
  renderRules: DISCORD_RULES,
  validate: validateDiscord,

  async call(target, options): Promise<CallResult> {
    const mode: ConnectorMode = options.dryRun ? "fake" : (options.mode ?? "live");
    const dryRun = mode === "fake";
    const payload = payloadFor(target);
    const blocking = validateDiscord(target)
      .filter((problem) => problem.severity === "block")
      .map((problem) => problem.message);
    const refusals = [
      ...blocking,
      // Includes the over-2000 refusal, which is where a webhook's lack of a
      // thread mechanism becomes a content decision rather than a send failure.
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
    const text = payload.segments.map((segment) => segment.text).join("\n\n");
    // In a dry run with no credentials there is no URL to parse, and inventing
    // one is fine here precisely because nothing is sent: it only shapes the
    // faker's base URL, which the faker never reads.
    if (!credentials.webhookUrl && !dryRun) {
      throw new ConnectorConfigError(
        "Discord needs `webhookUrl`. There is deliberately no default: a webhook is bound to one channel, so a " +
          "default would post into somebody else's.",
        { service: "discord", operation: "webhook_execute" },
      );
    }

    const parts = credentials.webhookUrl
      ? discordWebhookParts(credentials.webhookUrl)
      : { origin: "https://discord.com", path: "/api/webhooks/0/fake" };

    if (!dryRun) await respectRate("discord", DISCORD_DELIVERY.minIntervalMs);

    const result = await callConnector<{ id?: string; channel_id?: string }>(discordService(parts), {
      operation: "webhook_execute",
      mode,
      credentials,
      config: { text },
      request: {
        method: "POST",
        path: parts.path,
        // NOT optional. Without it Discord answers 204 No Content, there is no
        // id, and there is no ref — see `discordRefFrom`.
        query: { wait: true },
        json: { content: text },
      },
      idempotent: DISCORD_DELIVERY.idempotent,
    });

    const message = discordRefFrom(result.data);

    return {
      ok: true,
      ref: message.id,
      dryRun,
      mode,
      detail: dryRun
        ? `Dry run — would post ${payload.segments[0]?.count ?? 0}/2000 characters to the configured channel. ` +
          "Nothing left the building."
        : `Posted to channel ${message.channelId ?? "(unknown)"}.`,
    };
  },

  // No fetchMetrics. A webhook cannot read, so there is nothing to implement and
  // an empty implementation would turn "will never" into a reported zero.
};
