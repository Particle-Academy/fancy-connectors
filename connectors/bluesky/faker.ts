/**
 * Bluesky's faker — the shape AT Protocol returns, with nothing real in it.
 *
 * Every value is obviously synthetic: the DID is a fixed `did:plc:fake…`, the
 * rkeys and cids carry a `fake` prefix, the handle is on `example.test`. Nobody
 * should ever read a faked ref and wonder whether it is a real post.
 *
 * The DID is a CONSTANT rather than a derived value, deliberately. `fakeRequest`
 * seeds from (service, operation, config), so a derived DID would differ between
 * `session_create` and `post_create` and the faked uri would not belong to the
 * faked session — a join that works in production and breaks against the faker
 * is exactly the kind of difference this whole layer exists to avoid.
 */

import type { ConnectorFaker } from "../../src/faker.ts";

/** 24 characters after `did:plc:`, matching the real format, visibly fake. */
export const FAKE_DID = "did:plc:fake0000000000000000000";

export const FAKE_HANDLE = "fake.example.test";

export const blueskyFaker: ConnectorFaker = (operation, request) => {
  const { fake, config } = request;

  switch (operation) {
    case "session_create":
      return {
        accessJwt: `fake.${fake.hex(24)}.jwt`,
        refreshJwt: `fake.${fake.hex(24)}.refresh`,
        did: FAKE_DID,
        handle: FAKE_HANDLE,
        active: true,
      };

    case "post_create":
      // Seeded from the segment text and its position, so each message of a
      // thread gets its own ref and a chain built against the faker is a chain.
      return {
        uri: `at://${FAKE_DID}/app.bsky.feed.post/fake${fake.hex(9)}`,
        cid: `bafyfake${fake.hex(20)}`,
        validationStatus: "valid",
      };

    case "posts_get": {
      const uris = Array.isArray(config.uris) ? (config.uris as string[]) : [];

      return {
        posts: uris.map((uri) => ({
          uri,
          cid: `bafyfake${fake.hex(20)}`,
          author: { did: FAKE_DID, handle: FAKE_HANDLE },
          likeCount: fake.int(0, 40),
          repostCount: fake.int(0, 12),
          replyCount: fake.int(0, 8),
          quoteCount: fake.int(0, 4),
          indexedAt: fake.timestamp(),
        })),
      };
    }

    default:
      // A faker that quietly returned `{}` for an unknown operation would let a
      // typo in an operation name look like an API that returns nothing.
      throw new Error(
        `bluesky faker has no case for "${operation}". Add one when you add the call — a faker that ` +
          "returns an empty object for an unknown operation turns a typo into a provider that answered.",
      );
  }
};
