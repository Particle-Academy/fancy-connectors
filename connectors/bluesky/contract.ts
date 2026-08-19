/**
 * What this connector depends on, declared so drift is REPORTED rather than
 * discovered — plus the probe that proves the transport with a credential that
 * cannot work.
 */

import { ConnectorError } from "../../src/errors.ts";
import { callConnector } from "../../src/client.ts";
import type { ApiContract } from "../../src/drift.ts";
import type { ProbeSpec } from "../../src/probe.ts";
import { BLUESKY_PDS, BLUESKY_SERVICE } from "./connector.ts";

/**
 * AT Protocol publishes **lexicons**, not OpenAPI.
 *
 * `kind` matters: a checker that assumed OpenAPI would report every AT Protocol
 * connector as unspecified, which is a different and much worse answer than
 * "specified, in another format". The lexicons are first-party, live in the
 * protocol repo, and are the definition rather than a description of it — the
 * server is generated from them.
 *
 * Field names below were read out of those files on 2026-08-19:
 * `com.atproto.server.createSession` outputs `accessJwt`, `did`, `handle`;
 * `com.atproto.repo.createRecord` outputs `uri` and `cid`;
 * `app.bsky.feed.defs#postView` carries `likeCount`, `repostCount`,
 * `replyCount` and `quoteCount`.
 */
export const BLUESKY_CONTRACT: ApiContract = {
  connector: "bluesky",
  baseUrl: BLUESKY_PDS,
  spec: {
    kind: "lexicon",
    url: "https://github.com/bluesky-social/atproto/tree/main/lexicons",
    note:
      "First-party and authoritative — the server is generated from these files, so a lexicon change IS an API " +
      "change. There is no OpenAPI document; a checker that wanted one would report this connector as " +
      "unspecified, which is false. Until a lexicon checker exists, use checkAgainstRecordedShape() against the " +
      "`reads` below.",
  },
  operations: [
    {
      operation: "session_create",
      method: "POST",
      path: "/xrpc/com.atproto.server.createSession",
      sends: ["identifier", "password"],
      reads: ["accessJwt", "did", "handle"],
    },
    {
      operation: "post_create",
      method: "POST",
      path: "/xrpc/com.atproto.repo.createRecord",
      sends: ["repo", "collection", "record"],
      // Both. A reply needs the cid and it is not derivable from the uri, so
      // losing it would silently reduce this connector to top-level posts.
      reads: ["uri", "cid"],
    },
    {
      operation: "posts_get",
      method: "GET",
      path: "/xrpc/app.bsky.feed.getPosts",
      // Dotted, for the recorded-shape checker: it matches `posts.likeCount`
      // against a live `posts[].likeCount`.
      reads: [
        "posts.uri",
        "posts.likeCount",
        "posts.repostCount",
        "posts.replyCount",
        "posts.quoteCount",
      ],
    },
  ],
  reviewedOn: "2026-08-19",
};

/**
 * A credential that cannot be valid, in the shape a real one takes.
 *
 * Obviously synthetic on purpose: nobody reading a probe failure should have to
 * wonder whether a real account was touched.
 */
const IMPOSSIBLE = {
  identifier: "fancy-connectors-probe.invalid",
  appPassword: "0000-0000-0000-0000",
};

/**
 * The probe request, built through the connector's own service descriptor.
 *
 * That is the point of routing it this way rather than writing a second fetch:
 * the probe exercises THIS connector's URL, method and auth placement. A second
 * copy would pass while the connector was wrong.
 *
 * A 4xx arrives as a `ConnectorError` carrying its status. Anything else — a DNS
 * failure, a timeout — is re-thrown so `probe()` can classify it and report
 * offline as SKIPPED rather than failed.
 */
async function probeRequest(): Promise<{ status: number; body: string }> {
  try {
    await callConnector(BLUESKY_SERVICE, {
      operation: "session_create",
      mode: "live",
      credentials: IMPOSSIBLE,
      request: {
        method: "POST",
        path: "/xrpc/com.atproto.server.createSession",
        json: { identifier: IMPOSSIBLE.identifier, password: IMPOSSIBLE.appPassword },
      },
      // One attempt. A probe is a question, not a workload, and retrying a
      // refusal just spends someone's rate limit on the same answer.
      attempts: 1,
    });

    return {
      status: 200,
      body: "createSession ACCEPTED a credential that cannot be valid.",
    };
  } catch (error) {
    if (error instanceof ConnectorError && error.status !== undefined) {
      return { status: error.status, body: error.message };
    }

    throw error;
  }
}

export const BLUESKY_PROBE: ProbeSpec = {
  connector: "bluesky",
  request: probeRequest,
  authStatuses: [401],
  why:
    "Bluesky answers 401 for a handle or app password it does not accept. A 400 here would mean the request " +
    "SHAPE is wrong rather than the credential, and a 404 would mean the XRPC method moved — both are drift " +
    "this probe exists to catch, and neither is visible to a test with a fake server.",
};
