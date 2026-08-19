/**
 * Mastodon — the per-instance host, the limit that is passed IN, and the one
 * `idempotent: true` in the catalogue, which has to earn it.
 *
 * No network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareShape,
  registerTransport,
  resetRateState,
  type PreparedRequest,
  type TransportResponse,
} from "@particle-academy/fancy-connector-core";

import {
  MASTODON_DEFAULT_MAX_CHARACTERS,
  mastodonConnector,
  mastodonIdempotencyKey,
  mastodonMetricsFrom,
  mastodonProvider,
  mastodonRefFrom,
  mastodonStatusId,
  mastodonStoredRef,
  normaliseInstance,
  renderMastodon,
  type MastodonTarget,
} from "../connectors/mastodon/connector.ts";

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

const json = (body: unknown, status = 200): TransportResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const CREDENTIALS = { instance: "https://mastodon.example", accessToken: "tok-abc" };

/* ── the declared shape IS what the mapping produces ──────────────────────── */

test("the declared metric shape equals what the pure mapping actually produces", () => {
  const produced = mastodonMetricsFrom({
    favourites_count: 9,
    reblogs_count: 4,
    replies_count: 2,
  });

  assert.deepEqual(produced, { favourites: 9, reblogs: 4, replies: 2 });
  assert.equal(compareShape("mastodon", mastodonConnector.metricShape, produced), null);
});

test("there is no quote entry, and the shape says so by simply not having one", () => {
  const keys = (mastodonConnector.metricShape ?? []).map((metric) => metric.key);

  assert.deepEqual(keys, ["favourites", "reblogs", "replies"]);
  assert.equal(
    keys.includes("quotes"),
    false,
    "an empty column labelled quotes would read as nobody having quoted us",
  );

  const canonical = Object.fromEntries((mastodonConnector.metricShape ?? []).map((m) => [m.key, m.canonical]));
  assert.equal(canonical.favourites, "like", "a favourite and a like are the same act");
  assert.equal(canonical.reblogs, "share", "a boost and a repost are the same act");
});

test("the key is the API's word and the label is the interface's", () => {
  const reblogs = (mastodonConnector.metricShape ?? []).find((metric) => metric.key === "reblogs");

  assert.equal(reblogs?.key, "reblogs", "reblogs_count is what the wire says");
  assert.equal(reblogs?.label, "Boosts", "Boost is what the screen says");
});

test("ABSENT STAYS ABSENT", () => {
  const produced = mastodonMetricsFrom({ favourites_count: 0 });

  assert.deepEqual(produced, { favourites: 0 });
  assert.equal("reblogs" in produced, false);
});

/* ── the idempotency key is the approved BYTES ────────────────────────────── */

test("the same bytes produce the same Idempotency-Key, always", async () => {
  const first = await mastodonIdempotencyKey("Something worth saying.");
  const second = await mastodonIdempotencyKey("Something worth saying.");

  assert.equal(first, second, "a retry after a process restart has to carry the same key");
  assert.match(first, /^[0-9a-f]{64}$/, "sha-256, hex");
});

test("different bytes produce a different key", async () => {
  const first = await mastodonIdempotencyKey("Something worth saying.");
  const second = await mastodonIdempotencyKey("Something worth saying!");

  assert.notEqual(first, second, "one character of difference is a different post");
});

test("the key on the wire is the digest of the SEGMENT, not of the whole piece", async () => {
  const target: MastodonTarget = { text: "A short status." };
  const transport = fakeTransport();
  transport.queue.push(json({ id: "109", url: "https://mastodon.example/@brand/109" }));
  transport.install();

  try {
    await mastodonConnector.call(target, { dryRun: false, credentials: CREDENTIALS });

    assert.equal(
      transport.calls[0]?.headers["Idempotency-Key"],
      await mastodonIdempotencyKey("A short status."),
    );
  } finally {
    registerTransport(null);
  }
});

test("each segment of a thread carries its OWN key", async () => {
  const sentence = "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho. ";
  const target: MastodonTarget = { text: sentence.repeat(12) };
  const payload = renderMastodon(target);

  assert.ok(payload.segments.length > 1, "the fixture has to thread for this to mean anything");

  const transport = fakeTransport();
  for (let index = 0; index < payload.segments.length; index++) {
    transport.queue.push(json({ id: `10${index}`, url: `https://mastodon.example/@brand/10${index}` }));
  }
  transport.install();

  try {
    await mastodonConnector.call(target, { dryRun: false, credentials: CREDENTIALS });

    const keys = transport.calls.map((call) => call.headers["Idempotency-Key"]);
    assert.equal(new Set(keys).size, keys.length, "a retry of message 2 must not be able to duplicate message 1");
    assert.equal(keys[0], await mastodonIdempotencyKey(payload.segments[0]!.text));
  } finally {
    registerTransport(null);
  }
});

test("the declaration names the mechanism rather than restating the flag", () => {
  assert.equal(mastodonConnector.delivery.idempotent, true);
  assert.match(mastodonConnector.delivery.why, /Idempotency-Key/);
  assert.match(mastodonConnector.delivery.why, /approved bytes/);
  assert.match(mastodonConnector.delivery.why, /one hour/, "the window is part of the claim, not a footnote");
});

/* ── the instance is a credential, and the limit is passed IN ─────────────── */

test("an instance is whatever a person would actually paste", () => {
  assert.equal(normaliseInstance("mastodon.social"), "https://mastodon.social");
  assert.equal(normaliseInstance("https://mastodon.social/"), "https://mastodon.social");
  assert.equal(normaliseInstance("  https://mastodon.social  "), "https://mastodon.social");
  assert.equal(normaliseInstance(""), null);
});

test("the instance is a per-ACCOUNT field, not a per-installation one", () => {
  const instance = mastodonProvider.fields.find((field) => field.key === "instance");

  assert.equal(instance?.scope, "account", "two accounts are two servers as often as not");
  assert.equal(instance?.secret, false, "a hostname is not a secret; the token is");
  assert.equal(mastodonProvider.fields.find((field) => field.key === "accessToken")?.secret, true);
});

test("the instance's limit is a RULE passed in, not something resolved later", () => {
  // Real prose, not a 700-character token: a single unsplittable word is a
  // reported PROBLEM rather than a thread, which is a different test.
  const target: MastodonTarget = {
    text: "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho. ".repeat(8),
  };

  const atDefault = renderMastodon(target);
  assert.equal(atDefault.limit, MASTODON_DEFAULT_MAX_CHARACTERS);
  assert.equal(atDefault.segments.length > 1, true, "~700 characters threads at the 500 default");

  const atInstanceLimit = mastodonConnector.render!(target, { maxCharacters: 1_000 });
  assert.equal(atInstanceLimit.limit, 1_000);
  assert.equal(atInstanceLimit.segments.length, 1, "an instance that allows it accepts it whole");
});

test("render is pure — the same rules give the same payload, with no clock", () => {
  const target: MastodonTarget = { text: "A sentence. Another sentence. A third one here." };

  assert.deepEqual(
    mastodonConnector.render!(target, { maxCharacters: 40 }),
    mastodonConnector.render!(target, { maxCharacters: 40 }),
  );
});

/* ── refs: the id you post with is not the id you store ───────────────────── */

test("the stored ref is the URL when there is one, and the id when there is not", () => {
  assert.equal(mastodonStoredRef({ id: "109", url: "https://mastodon.example/@brand/109" }), "https://mastodon.example/@brand/109");
  assert.equal(mastodonStoredRef({ id: "109", url: "" }), "109");
});

test("the instance's id comes back out of either", () => {
  assert.equal(mastodonStatusId("https://mastodon.example/@brand/109"), "109");
  assert.equal(mastodonStatusId("109"), "109");
});

test("a status answer with no id is a failure, not a success", () => {
  assert.throws(
    () => mastodonRefFrom({ url: "https://mastodon.example/@brand/109" }),
    (error: Error) => error.name === "ConnectorAmbiguous" && /nothing to record it as/.test(error.message),
  );
});

/* ── the rate figure is ours, and says so ─────────────────────────────────── */

test("the rate floor is labelled self-imposed, because Mastodon publishes a BUDGET", () => {
  assert.equal(mastodonConnector.delivery.rateSource, "self-imposed");
  assert.match(mastodonConnector.delivery.citation?.quote ?? "", /300 times within 5 minutes/);
  assert.equal(mastodonConnector.delivery.citation?.readOn, "2026-08-19");
});
