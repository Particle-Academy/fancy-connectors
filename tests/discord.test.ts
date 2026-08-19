/**
 * Discord — a URL that is a secret, `?wait=true`, and a 2xx with no id.
 *
 * No network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  capabilityProblems,
  registerTransport,
  render,
  resetRateState,
  type Connector,
  type PreparedRequest,
  type TransportResponse,
} from "@particle-academy/fancy-connector-core";

import {
  DISCORD_RULES,
  discordConnector,
  discordMessageUrl,
  discordProvider,
  discordRefFrom,
  discordWebhookParts,
} from "../connectors/discord/connector.ts";

function fakeTransport(): { calls: PreparedRequest[]; queue: TransportResponse[]; install: () => void } {
  const calls: PreparedRequest[] = [];
  const queue: TransportResponse[] = [];

  return {
    calls,
    queue,
    install: () => {
      resetRateState();
      registerTransport(async (request) => {
        calls.push(request);
        const next = queue.shift();
        if (!next) throw new Error(`no queued response for ${request.method} ${request.url}`);

        return next;
      });
    },
  };
}

const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/some-secret-token-value";
const CREDENTIALS = { webhookUrl: WEBHOOK };

/* ── the URL is a SECRET ──────────────────────────────────────────────────── */

test("the webhook URL is declared secret — it looks like configuration and is a password", () => {
  const field = discordProvider.fields.find((entry) => entry.key === "webhookUrl");

  assert.equal(field?.secret, true, "it carries its token in the path; anyone holding it can post");
  assert.equal(field?.required, true);
  assert.equal(discordProvider.fields.length, 1, "a webhook is the whole credential");
  assert.deepEqual(discordProvider.scopes, [], "no consent screen and no scope creep");
});

test("a channel link or an invite is rejected before anything is sent", () => {
  assert.throws(() => discordWebhookParts("https://discord.com/channels/1/2"), /not a Discord webhook URL/);
  assert.throws(() => discordWebhookParts("not-a-url"), /not a URL/);
  assert.throws(() => discordWebhookParts("http://discord.com/api/webhooks/1/2"), /not a Discord webhook URL/);
});

test("both path shapes Discord's copy button has emitted are accepted", () => {
  assert.deepEqual(discordWebhookParts(WEBHOOK), {
    origin: "https://discord.com",
    path: "/api/webhooks/123456789012345678/some-secret-token-value",
  });
  assert.equal(
    discordWebhookParts("https://discord.com/api/v10/webhooks/1/tok").path,
    "/api/v10/webhooks/1/tok",
  );
});

/* ── ?wait=true is not optional, and a 2xx with no id is a FAILURE ────────── */

test("`?wait=true` is on the wire, because without it there is no id", async () => {
  const transport = fakeTransport();
  transport.queue.push({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "999888777666555444", channel_id: "111222333444555666" }),
  });
  transport.install();

  try {
    const result = await discordConnector.call({ text: "Hello, channel." }, {
      dryRun: false,
      credentials: CREDENTIALS,
    });

    assert.equal(result.ok, true);
    assert.equal(result.ref, "999888777666555444");
    assert.match(transport.calls[0]!.url, /[?&]wait=true/);
    assert.equal(JSON.parse(transport.calls[0]!.body ?? "{}").content, "Hello, channel.");
  } finally {
    registerTransport(null);
  }
});

test("A 204 WITH NO ID IS A FAILURE — a send you cannot point at is barely a send", async () => {
  const transport = fakeTransport();
  // Exactly what Discord answers when `?wait=true` is missing: success, no body.
  transport.queue.push({ status: 204, headers: {}, body: "" });
  transport.install();

  try {
    await assert.rejects(
      discordConnector.call({ text: "Hello, channel." }, { dryRun: false, credentials: CREDENTIALS }),
      (error: Error) => {
        assert.equal(error.name, "ConnectorAmbiguous", "the message probably exists, so a retry would duplicate it");
        assert.match(error.message, /204 No Content/);
        assert.match(error.message, /wait=true/);

        return true;
      },
    );
  } finally {
    registerTransport(null);
  }
});

test("a 2xx body with no id is the same failure, however it arrives", () => {
  assert.throws(
    () => discordRefFrom({ channel_id: "1" }),
    (error: Error) => error.name === "ConnectorAmbiguous" && /every later join is broken/.test(error.message),
  );
  assert.deepEqual(discordRefFrom({ id: "7", channel_id: "1" }), { id: "7", channelId: "1" });
});

/* ── no thread mechanism, so over-length is REFUSED ───────────────────────── */

test("2000 characters, and thread: false — over-length is refused, never split", async () => {
  assert.equal(DISCORD_RULES.limit, 2_000);
  assert.equal(DISCORD_RULES.thread, false);

  const long = "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu. ".repeat(40);
  const payload = render(long, DISCORD_RULES);

  assert.equal(payload.segments.length, 1, "nothing was invented");
  assert.match(payload.problems[0] ?? "", /no thread mechanism/);

  const transport = fakeTransport();
  transport.install();

  try {
    const result = await discordConnector.call({ text: long }, { dryRun: false, credentials: CREDENTIALS });

    assert.equal(result.ok, false);
    assert.equal(result.ref, null);
    assert.equal(transport.calls.length, 0, "the refusal happens before the network");
  } finally {
    registerTransport(null);
  }
});

/* ── a webhook cannot read, and the declaration says so exactly ───────────── */

test("NO metricShape at all — not an empty one", () => {
  assert.equal(discordConnector.capabilities.metrics, false);
  assert.equal(
    "metricShape" in discordConnector,
    false,
    'an empty shape says "reports nothing yet" where the truth is "will never"',
  );
  assert.equal(discordConnector.fetchMetrics, undefined);
  assert.deepEqual(capabilityProblems(discordConnector as unknown as Connector<never>), []);
});

/* ── links are honest or absent ───────────────────────────────────────────── */

test("a message link needs the guild, and a guessed one would 404 for whoever clicked it", () => {
  assert.equal(discordMessageUrl(null, "222", "333"), null);
  assert.equal(discordMessageUrl("111", null, "333"), null);
  assert.equal(discordMessageUrl("111", "222", "333"), "https://discord.com/channels/111/222/333");
});

/* ── delivery ─────────────────────────────────────────────────────────────── */

test("the rate figure is OURS — Discord's docs publish no number for this route", () => {
  assert.equal(discordConnector.delivery.minIntervalMs, 400);
  assert.equal(
    discordConnector.delivery.rateSource,
    "self-imposed",
    'the reference implementation called 400ms "documented"; the rate-limit page publishes only the bucket',
  );
  assert.match(discordConnector.delivery.citation?.quote ?? "", /X-RateLimit/);
  assert.equal(discordConnector.delivery.citation?.readOn, "2026-08-19");
});

test("idempotent: false, with the mechanism named rather than the flag restated", () => {
  assert.equal(discordConnector.delivery.idempotent, false);
  assert.match(discordConnector.delivery.why, /no idempotency key/);
  assert.match(discordConnector.delivery.why, /posts a second message/);
});
