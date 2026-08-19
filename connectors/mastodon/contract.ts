/**
 * What this connector depends on, and the probe that proves the transport.
 */

import { callConnector } from "../../src/client.ts";
import type { ApiContract } from "../../src/drift.ts";
import { ConnectorError } from "../../src/errors.ts";
import type { ProbeSpec } from "../../src/probe.ts";
import { mastodonService, normaliseInstance } from "./connector.ts";

/**
 * Mastodon publishes NO machine-readable spec of its own.
 *
 * `docs.joinmastodon.org` is prose, and there is no `mastodon/mastodon-openapi`
 * repository (checked 2026-08-19: 404). The document cited below is
 * **community-maintained** — `abraham/mastodon-openapi`, generated from those
 * same docs, last regenerated 2026-08-19, describing API version 4.7.0, and the
 * raw URL returned 200 on that date.
 *
 * It is declared as `openapi` rather than `none` because it is genuinely
 * checkable and genuinely maintained, and a `none` here would throw away a
 * usable signal. The `note` carries the caveat that a clean result means *the
 * docs still say this*, one step removed from the server — which is a weaker
 * claim than a first-party spec makes, and the difference is exactly what a
 * drift report exists to be honest about.
 *
 * Field names were checked against that document on 2026-08-19: `Status` carries
 * `id`, `url`, `favourites_count`, `reblogs_count` and `replies_count`;
 * `verify_credentials` returns `id`, `username`, `acct` and `url`;
 * `Idempotency-Key` is a documented header parameter on `POST /api/v1/statuses`.
 *
 * One known soft spot: that document describes the create-status body as form
 * parameters rather than a JSON schema, so `propertiesOf` reads an empty request
 * schema and the checker skips the `sends` comparison rather than reporting
 * three false findings. The fields are declared anyway, because they are what
 * this connector really sends and the next generator may express them.
 */
export const MASTODON_CONTRACT: ApiContract = {
  connector: "mastodon",
  // Per instance — there is no single host, which is the whole character of this
  // provider. `{instance}` is a placeholder, not a URL.
  baseUrl: "https://{instance}",
  spec: {
    kind: "openapi",
    url: "https://raw.githubusercontent.com/abraham/mastodon-openapi/main/dist/schema.json",
    note:
      "COMMUNITY-maintained, not Mastodon's. Mastodon publishes prose docs only and no OpenAPI document at any " +
      "URL (mastodon/mastodon-openapi does not exist — checked 2026-08-19). This one is generated from those " +
      "docs (abraham/mastodon-openapi, regenerated 2026-08-19, API 4.7.0). A clean result therefore means 'the " +
      "docs still say this', which is one step removed from the server — and instances run different versions " +
      "of Mastodon anyway, so treat it as a signal rather than a guarantee.",
  },
  operations: [
    {
      operation: "account_verify",
      method: "GET",
      path: "/api/v1/accounts/verify_credentials",
      reads: ["id", "username", "acct", "url"],
    },
    {
      operation: "status_create",
      method: "POST",
      path: "/api/v1/statuses",
      sends: ["status", "visibility", "in_reply_to_id"],
      reads: ["id", "url"],
    },
    {
      operation: "status_get",
      method: "GET",
      path: "/api/v1/statuses/{id}",
      reads: ["id", "url", "favourites_count", "reblogs_count", "replies_count"],
    },
  ],
  reviewedOn: "2026-08-19",
};

/** A token that cannot be valid, obviously synthetic. */
const IMPOSSIBLE_TOKEN = "fancy-connectors-probe-invalid-token";

/**
 * Probe one instance.
 *
 * A factory rather than a constant, because "which server" is the question this
 * provider always asks. The default is the largest public instance, chosen
 * because a probe must hit a host that certainly exists — the whole point is
 * distinguishing "this credential is refused" from "this host is not there".
 *
 * Routed through the connector's own service descriptor so the probe exercises
 * THIS connector's URL and auth placement rather than a second copy of them.
 */
export function mastodonProbe(instanceInput = "mastodon.social"): ProbeSpec {
  const instance = normaliseInstance(instanceInput) ?? "https://mastodon.social";

  return {
    connector: "mastodon",
    request: async () => {
      try {
        await callConnector(mastodonService(instance), {
          operation: "account_verify",
          mode: "live",
          credentials: { instance, accessToken: IMPOSSIBLE_TOKEN },
          request: { method: "GET", path: "/api/v1/accounts/verify_credentials" },
          attempts: 1,
        });

        return {
          status: 200,
          body: `${instance} ACCEPTED a token that cannot be valid.`,
        };
      } catch (error) {
        if (error instanceof ConnectorError && error.status !== undefined) {
          return { status: error.status, body: error.message };
        }

        throw error;
      }
    },
    authStatuses: [401],
    why:
      `A Mastodon instance answers 401 for a token it does not accept. A 404 is NOT an auth-shaped refusal ` +
      `here and is deliberately excluded: it means ${instance} has no Mastodon API at that address, which is ` +
      "the wrong-hostname failure that otherwise looks exactly like an outage.",
  };
}

export const MASTODON_PROBE: ProbeSpec = mastodonProbe();
