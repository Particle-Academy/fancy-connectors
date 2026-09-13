/**
 * Every probe reads the refusal it asked for.
 *
 * The scheduled Drift workflow failed on all 25 runs from the day it was added.
 * Bluesky, Mastodon and Telegram answered `401` and Discord `404` — exactly the
 * refusals each probe declares — and every probe reported *"the request failed
 * before any status arrived"*, because core up to 0.4.0 threw a failed call's
 * error with no `status`, and each `contract.ts` reads `error.status` to hand the
 * refusal to `probe()`.
 *
 * Nothing in `npm test` exercised that path: the probes need a network, so they
 * were only ever run where nobody was looking. This replays each provider's
 * answer through the probe's REAL request builder — the connector's own service
 * descriptor, URL and auth placement — with a registered transport instead of a
 * network. Against core 0.4.0 all eight per-probe cases fail; the first case is
 * an inventory guard and passes either way.
 *
 * No network.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { probe, registerTransport, resetRateState, type PreparedRequest } from "@particle-academy/fancy-connector-core";

import { EXEMPLAR_PROBES } from "../connectors/index.ts";
import { REAL_REFUSALS } from "./real-refusals.ts";

function answerWith(status: number, body: string): PreparedRequest[] {
  const seen: PreparedRequest[] = [];
  resetRateState();
  registerTransport(async (request) => {
    seen.push(request);

    return { status, headers: {}, body };
  });

  return seen;
}

afterEach(() => registerTransport(null));

test("the catalogue has a recorded refusal for every probe, and no stale ones", () => {
  assert.deepEqual(
    EXEMPLAR_PROBES.map((spec) => spec.connector).sort(),
    Object.keys(REAL_REFUSALS).sort(),
  );
});

for (const spec of EXEMPLAR_PROBES) {
  const refusal = REAL_REFUSALS[spec.connector]!;

  test(`${spec.connector}: the provider's real refusal (${refusal.status}) is a PASS`, async () => {
    const seen = answerWith(refusal.status, refusal.body);
    const result = await probe(spec);

    assert.equal(result.outcome, "pass", result.detail);
    assert.equal(result.status, refusal.status);
    assert.equal(seen.length, 1, "a probe is one question — a refusal must not be retried");
    assert.match(seen[0]!.url, /^https:\/\//, "the probe must be built from the connector's live descriptor");
  });

  test(`${spec.connector}: an unexpected status is a FAIL that names the status, not a missing one`, async () => {
    // 410 is in no probe's authStatuses. The point is the DETAIL: a status that
    // arrived must be reported as that status — "failed before any status
    // arrived" is the sentence that hid a working probe for 25 runs.
    answerWith(410, "gone");
    const result = await probe(spec);

    assert.equal(result.outcome, "fail");
    assert.equal(result.status, 410);
    assert.doesNotMatch(result.detail, /before any status arrived/);
  });
}
