/**
 * The provider's own error code is carried where the provider documents a
 * stable one — and NOWHERE else.
 *
 * Core 0.5.0 added `ServiceDescriptor.providerCodeFrom` and the catalogue never
 * declared it, so `error.providerCode` was empty on every call from every
 * connector here. A field that exists and is never filled reads as "this
 * provider has no code", which was false for two of the four.
 *
 * Each case replays the provider's REAL refusal (see `real-refusals.ts` for
 * where it was recorded) through the SAME service descriptor the connector
 * calls with, and reads `providerCode` off what `callConnector` throws.
 *
 * | provider | declared? | what its documentation says |
 * |---|---|---|
 * | bluesky | yes — `error` | XRPC: "type name of the error (generic ASCII constant, no whitespace)" |
 * | discord | yes — `code` | "more detailed error codes through a `code` key in the JSON error response" |
 * | mastodon | **no** | Error entity: `error` is "The error message." — a sentence, not a code |
 * | telegram | **no** | "An Integer 'error_code' field is also returned, but its contents are subject to change in the future." |
 *
 * The two "no" rows are tests too. Both bodies carry a field that LOOKS like a
 * code — Mastodon's is even called `error`, the same name as Bluesky's — and a
 * well-meaning edit that "completes the set" would publish a sentence, or a
 * number Telegram says it may change, as something a host can route on.
 *
 * No network.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  ConnectorError,
  callConnector,
  registerTransport,
  resetRateState,
  type ServiceDescriptor,
} from "@particle-academy/fancy-connector-core";

import { BLUESKY_SERVICE } from "../connectors/bluesky/connector.ts";
import { discordService, discordWebhookParts } from "../connectors/discord/connector.ts";
import { EXEMPLAR_PROBES } from "../connectors/index.ts";
import { mastodonService } from "../connectors/mastodon/connector.ts";
import { TELEGRAM_SERVICE } from "../connectors/telegram/connector.ts";
import { REAL_REFUSALS } from "./real-refusals.ts";

const SERVICES: Record<string, ServiceDescriptor> = {
  bluesky: BLUESKY_SERVICE,
  mastodon: mastodonService("https://mastodon.example.test"),
  discord: discordService(discordWebhookParts("https://discord.com/api/webhooks/1/not-a-token")),
  telegram: TELEGRAM_SERVICE,
};

/** `undefined` is a DECISION here, not a gap — see the table above. */
const EXPECTED_CODE: Record<string, string | undefined> = {
  bluesky: "AuthenticationRequired",
  discord: "10015",
  mastodon: undefined,
  telegram: undefined,
};

afterEach(() => registerTransport(null));

/** Run one live call through `service` against a canned answer; return what it threw. */
async function refusal(service: ServiceDescriptor, status: number, body: string): Promise<ConnectorError> {
  resetRateState();
  registerTransport(async () => ({ status, headers: {}, body }));

  try {
    await callConnector(service, {
      operation: "probe",
      mode: "live",
      credentials: { identifier: "x", appPassword: "x", instance: "x", accessToken: "x", webhookUrl: "x", botToken: "x", chat: "x" },
      request: { method: "GET", path: "/probe" },
      attempts: 1,
    });
  } catch (error) {
    assert.ok(error instanceof ConnectorError, `expected a ConnectorError, got ${String(error)}`);

    return error;
  }

  assert.fail(`${service.service}: a ${status} was expected to fail the call`);
}

test("every probed provider has a decision recorded here, and nothing stale", () => {
  const probed = EXEMPLAR_PROBES.map((spec) => spec.connector).sort();

  assert.deepEqual(Object.keys(SERVICES).sort(), probed);
  assert.deepEqual(Object.keys(EXPECTED_CODE).sort(), probed);
});

for (const [provider, service] of Object.entries(SERVICES)) {
  const { status, body } = REAL_REFUSALS[provider]!;
  const expected = EXPECTED_CODE[provider];

  test(
    expected === undefined
      ? `${provider}: its real refusal carries NO provider code — the field that looks like one is not`
      : `${provider}: its real refusal carries the provider code "${expected}"`,
    async () => {
      const error = await refusal(service, status, body);

      assert.equal(error.status, status, "the status must survive whatever the code does");
      assert.equal(error.providerCode, expected);
      // Declared exactly where a code is expected, so absence is a decision
      // rather than an omission nobody noticed.
      assert.equal(typeof service.providerCodeFrom === "function", expected !== undefined);
    },
  );
}

/* ── the readers refuse what is not a code ───────────────────────────────── */

test("bluesky: an `error` that is not an XRPC error name is not carried", async () => {
  // The spec says the name is an ASCII constant with no whitespace. A proxy or
  // a misbehaving PDS answering `{"error": "Bad Gateway"}` would otherwise have
  // its sentence published as a code — the Mastodon mistake, one hop away.
  for (const body of ['{"error":"Bad Gateway"}', '{"error":""}', '{"error":42}', "<html>502</html>"]) {
    const error = await refusal(BLUESKY_SERVICE, 502, body);

    assert.equal(error.providerCode, undefined, body);
    assert.equal(error.status, 502, body);
  }
});

test("discord: a body with no integer `code` carries no code", async () => {
  // A 429 body has `message` and `retry_after` and no `code`; an edge proxy
  // answers with HTML. Neither may produce a code, and neither may cost the status.
  const service = SERVICES.discord!;

  for (const [status, body] of [
    [429, '{"message": "You are being rate limited.", "retry_after": 0.5, "global": false}'],
    [404, '{"message": "Unknown Webhook", "code": "10015"}'],
    [502, "<html>bad gateway</html>"],
  ] as const) {
    const error = await refusal(service, status, body);

    assert.equal(error.providerCode, undefined, body);
    assert.equal(error.status, status, body);
  }
});
