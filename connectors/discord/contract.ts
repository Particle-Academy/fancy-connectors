/**
 * What this connector depends on, and the probe that proves the transport.
 */

import { callConnector } from "../../src/client.ts";
import type { ApiContract } from "../../src/drift.ts";
import { ConnectorError } from "../../src/errors.ts";
import type { ProbeSpec } from "../../src/probe.ts";
import { discordService, discordWebhookParts } from "./connector.ts";

/**
 * Discord publishes a first-party OpenAPI document, and it covers this route.
 *
 * Verified on 2026-08-19: the URL below returned 200 (about 1.1 MB, 150 paths),
 * `/webhooks/{webhook_id}/{webhook_token}` carries both `get` and `post`, the
 * POST request body lists `content`, and the 2xx response lists `id` and
 * `channel_id`. So the fields declared here check clean against the provider's
 * own spec rather than against somebody's reading of the docs.
 *
 * Note what is NOT in `sends`: **`wait`**. It is a query parameter, and
 * `checkAgainstOpenApi` compares `sends` against the request BODY schema — so
 * listing it there would produce a permanent false finding. Its absence from
 * this list is not an oversight; `?wait=true` is load-bearing and lives in the
 * request, with the reason written where it is set.
 */
export const DISCORD_CONTRACT: ApiContract = {
  connector: "discord",
  baseUrl: "https://discord.com/api",
  spec: {
    kind: "openapi",
    url: "https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json",
    note:
      "First-party — Discord's own, published from discord/discord-api-spec. Checked 2026-08-19: 200, and it " +
      "carries /webhooks/{webhook_id}/{webhook_token} for GET and POST with the fields declared here.",
  },
  operations: [
    {
      operation: "webhook_get",
      method: "GET",
      path: "/webhooks/{webhook_id}/{webhook_token}",
      // What verify reads. `guild_id` is optional in practice — a webhook
      // response does not always carry one, which is why discordMessageUrl
      // returns null rather than guessing a link that would 404.
      reads: ["id", "name", "channel_id", "guild_id"],
    },
    {
      operation: "webhook_execute",
      method: "POST",
      path: "/webhooks/{webhook_id}/{webhook_token}",
      sends: ["content"],
      reads: ["id", "channel_id"],
    },
  ],
  reviewedOn: "2026-08-19",
};

/**
 * A webhook that cannot exist: an all-zero snowflake and a token that is words.
 *
 * Discord answers **404** for it, which is the whole reason this connector's
 * probe declares 404 as auth-shaped.
 */
const IMPOSSIBLE_WEBHOOK =
  "https://discord.com/api/webhooks/000000000000000000/fancy-connectors-probe-invalid-token";

export const DISCORD_PROBE: ProbeSpec = {
  connector: "discord",
  request: async () => {
    const parts = discordWebhookParts(IMPOSSIBLE_WEBHOOK);

    try {
      await callConnector(discordService(parts), {
        operation: "webhook_get",
        mode: "live",
        credentials: { webhookUrl: IMPOSSIBLE_WEBHOOK },
        request: { method: "GET", path: parts.path },
        attempts: 1,
      });

      return { status: 200, body: "Discord ACCEPTED a webhook token that cannot be valid." };
    } catch (error) {
      if (error instanceof ConnectorError && error.status !== undefined) {
        return { status: error.status, body: error.message };
      }

      throw error;
    }
  },
  // 404 IS an auth-shaped refusal here, and this is the case the whole
  // `authStatuses` field exists for.
  authStatuses: [401, 404],
  why:
    "Discord answers 404 for a webhook id or token it does not recognise — the credential is IN THE PATH, so " +
    "an unknown credential and an unknown resource are literally the same request to it. On a provider that " +
    "does not do this, a 404 would mean the endpoint moved, which is the one outcome a probe exists to catch — " +
    "so it is declared per provider rather than assumed. 401 stays in the list because Discord returns it for " +
    "a malformed Authorization header on other routes and a future change here should not read as a pass.",
};
