/**
 * Bluesky — the three bugs that are silent in every direction, asserted.
 *
 * No network. The transport is a fake with a queue, so what is checked is the
 * REQUEST BODIES this connector produces — which is where the chaining bug lived
 * and why it survived a green suite for weeks.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareShape,
  registerTransport,
  render,
  resetRateState,
  sliceByteRange,
  type PreparedRequest,
  type TransportResponse,
} from "@particle-academy/fancy-connector-core";

import {
  BLUESKY_RULES,
  blueskyConnector,
  blueskyFacets,
  blueskyMetricsFrom,
  blueskyProvider,
  blueskyRefFrom,
  blueskyReplyLinks,
  type BlueskyTarget,
} from "../connectors/bluesky/connector.ts";

/* ── a transport that records, and answers from a queue ───────────────────── */

function fakeTransport(): {
  calls: PreparedRequest[];
  queue: TransportResponse[];
  install: () => void;
} {
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

const CREDENTIALS = { identifier: "brand.bsky.social", appPassword: "abcd-efgh-ijkl-mnop" };

/* ── 1. the declared metric shape IS what the mapping produces ────────────── */

test("the declared metric shape equals what the pure mapping actually produces", () => {
  // A synthetic response with EVERY field populated, so anything the mapping can
  // emit appears — and no credentials, no network.
  const produced = blueskyMetricsFrom({
    likeCount: 12,
    repostCount: 3,
    replyCount: 5,
    quoteCount: 1,
  });

  assert.deepEqual(produced, { likes: 12, reposts: 3, replies: 5, quotes: 1 });
  assert.equal(
    compareShape("bluesky", blueskyConnector.metricShape, produced),
    null,
    "this is the check that caught two connectors declaring metrics: true while returning []",
  );
});

test("ABSENT STAYS ABSENT — a count the provider did not send is not a zero", () => {
  const produced = blueskyMetricsFrom({ likeCount: 0 });

  assert.deepEqual(produced, { likes: 0 }, "0 is a measurement");
  assert.equal("quotes" in produced, false, "a zero says nothing happened; an absence says we do not know");
});

/* ── 2. facets are BYTE ranges, and an emoji proves it ────────────────────── */

test("a facet on text starting with an emoji points at the URL, in BYTES", () => {
  const text = "👍 https://example.test/x is worth reading";
  const facets = blueskyFacets(text);

  assert.equal(facets.length, 1);
  const facet = facets[0]!;

  // A character-offset implementation says 2 here, passes every ASCII test, and
  // corrupts the LINK — so the post looks fine and goes somewhere wrong.
  assert.equal(facet.index.byteStart, 5, "👍 is four UTF-8 bytes plus the space");
  assert.equal(
    sliceByteRange(text, facet.index),
    "https://example.test/x",
    "the only way to catch an off-by-one that ASCII hides",
  );
  assert.equal(facet.features[0]?.$type, "app.bsky.richtext.facet#link");
  assert.equal(facet.features[0]?.uri, "https://example.test/x");
});

test("trailing punctuation is not part of the link", () => {
  const text = "See https://example.test/a, then https://example.test/b.";

  for (const facet of blueskyFacets(text)) {
    assert.equal(sliceByteRange(text, facet.index), facet.features[0]?.uri);
    assert.equal(/[.,]$/.test(facet.features[0]?.uri ?? ""), false);
  }
});

/* ── 3. a thread posts as a CHAIN ─────────────────────────────────────────── */

const SENTENCE = "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu. ";

test("THE RULE — a thread chains: root fixed at the top, parent advancing", async () => {
  const target: BlueskyTarget = { text: SENTENCE.repeat(10) };
  const payload = render(target.text, BLUESKY_RULES);

  assert.equal(payload.segments.length, 3, "the fixture has to produce three messages for this to mean anything");

  const transport = fakeTransport();
  transport.queue.push(
    json({ accessJwt: "jwt-1", did: "did:plc:realaccount", handle: "brand.bsky.social" }),
    json({ uri: "at://did:plc:realaccount/app.bsky.feed.post/one", cid: "cid-one" }),
    json({ uri: "at://did:plc:realaccount/app.bsky.feed.post/two", cid: "cid-two" }),
    json({ uri: "at://did:plc:realaccount/app.bsky.feed.post/three", cid: "cid-three" }),
  );
  transport.install();

  try {
    const result = await blueskyConnector.call(target, { dryRun: false, credentials: CREDENTIALS });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, false);
    assert.equal(result.ref, "at://did:plc:realaccount/app.bsky.feed.post/one", "the FIRST uri is the ref");

    assert.equal(transport.calls.length, 4, "one session, three records");
    const records = transport.calls.slice(1).map((call) => JSON.parse(call.body ?? "{}").record);

    assert.equal(records[0].reply, undefined, "the first message is top-level");

    assert.deepEqual(
      records[1].reply,
      {
        root: { uri: "at://did:plc:realaccount/app.bsky.feed.post/one", cid: "cid-one" },
        parent: { uri: "at://did:plc:realaccount/app.bsky.feed.post/one", cid: "cid-one" },
      },
      "the second replies to the first",
    );

    assert.deepEqual(
      records[2].reply,
      {
        root: { uri: "at://did:plc:realaccount/app.bsky.feed.post/one", cid: "cid-one" },
        parent: { uri: "at://did:plc:realaccount/app.bsky.feed.post/two", cid: "cid-two" },
      },
      "the third replies to the SECOND while the root never moves — reverse these and it is a fan, not a thread",
    );
  } finally {
    registerTransport(null);
  }
});

test("answering somebody else keeps THEIR root", () => {
  const links = blueskyReplyLinks({
    provider: "bluesky",
    context: { rootUri: "at://theirs/1", rootCid: "t1", parentUri: "at://theirs/9", parentCid: "t9" },
  });

  assert.deepEqual(links, {
    root: { uri: "at://theirs/1", cid: "t1" },
    parent: { uri: "at://theirs/9", cid: "t9" },
  });
});

test("a reply to a TOP-LEVEL post uses the parent as its own root", () => {
  const links = blueskyReplyLinks({
    provider: "bluesky",
    context: { parentUri: "at://theirs/9", parentCid: "t9" },
  });

  assert.deepEqual(links?.root, { uri: "at://theirs/9", cid: "t9" });
});

test("another provider's replyTo is not ours", () => {
  assert.equal(blueskyReplyLinks({ provider: "mastodon", context: { statusId: "1" } }), undefined);
});

/* ── partial threads, and the fact that matters most ──────────────────────── */

test("a chain that fails part-way returns what IS public rather than throwing it away", async () => {
  const target: BlueskyTarget = { text: SENTENCE.repeat(10) };
  const transport = fakeTransport();
  transport.queue.push(
    json({ accessJwt: "jwt-1", did: "did:plc:realaccount", handle: "brand.bsky.social" }),
    json({ uri: "at://did:plc:realaccount/app.bsky.feed.post/one", cid: "cid-one" }),
    json({ error: "InvalidRequest", message: "nope" }, 400),
  );
  transport.install();

  try {
    const result = await blueskyConnector.call(target, { dryRun: false, credentials: CREDENTIALS });

    assert.equal(result.ok, false, "it did not do what was asked");
    assert.equal(result.ref, "at://did:plc:realaccount/app.bsky.feed.post/one", "and here is what DID go out");
    assert.match(result.detail, /Posted 1 of 3/);
    assert.match(result.detail, /NOT\s+unwound/);
  } finally {
    registerTransport(null);
  }
});

/* ── refusals happen before the network ───────────────────────────────────── */

test("a blocking validate problem refuses before anything is attempted", async () => {
  const transport = fakeTransport();
  transport.install();

  try {
    const result = await blueskyConnector.call(
      { text: "something", media: [{ file: "photo.jpg", alt: null }] },
      { dryRun: false, credentials: CREDENTIALS },
    );

    assert.equal(result.ok, false);
    assert.equal(result.ref, null);
    assert.match(result.detail, /no alt text/);
    assert.equal(transport.calls.length, 0, "nothing was attempted, so there is nothing to classify");
  } finally {
    registerTransport(null);
  }
});

test("length is the RENDERER's business, never validate's", () => {
  const problems = blueskyConnector.validate({ text: "x".repeat(5_000) });

  assert.deepEqual(problems, [], "a validator that judged length would refuse posts the renderer had solved");
  assert.equal(render("x".repeat(5_000), BLUESKY_RULES).problems.length > 0, true, "the renderer reports it");
});

/* ── a 2xx with no ref is a failure ───────────────────────────────────────── */

test("a createRecord answer missing the cid is a failure, not a success", () => {
  assert.throws(
    () => blueskyRefFrom({ uri: "at://x/y/z" }),
    // Ambiguous, not rejected: the post probably exists, so a retry duplicates
    // it — and createRecord has no idempotency key.
    (error: Error) => error.name === "ConnectorAmbiguous" && /go and look/.test(error.message),
  );
});

/* ── the adapter ──────────────────────────────────────────────────────────── */

test("the app password is a secret and the handle is not", () => {
  const fields = Object.fromEntries(blueskyProvider.fields.map((field) => [field.key, field]));

  assert.equal(fields.appPassword?.secret, true);
  assert.equal(fields.identifier?.secret, false);
  assert.equal(fields.identifier?.scope, "account", "credentials are per account, never per installation");
  assert.deepEqual(blueskyProvider.scopes, [], "an app password has no scopes to ask for, and saying so is the point");
  assert.equal(blueskyProvider.sandbox, "none");
});
