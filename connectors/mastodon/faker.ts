/**
 * Mastodon's faker — the shape an instance returns, on a host nobody owns.
 *
 * `mastodon.example.test` throughout, so a faked status URL cannot be mistaken
 * for one on a real instance. The account is a constant for the same reason the
 * Bluesky DID is: `fakeRequest` seeds per operation, and a derived account would
 * mean the faked status did not belong to the faked account.
 */

import type { ConnectorFaker } from "../../src/faker.ts";

export const FAKE_INSTANCE = "https://mastodon.example.test";

export const FAKE_ACCT = "fake";

export const mastodonFaker: ConnectorFaker = (operation, request) => {
  const { fake, config } = request;
  const instance = typeof config.instance === "string" && config.instance !== "" ? config.instance : FAKE_INSTANCE;

  switch (operation) {
    case "account_verify":
      return {
        id: `fake${fake.hex(12)}`,
        username: FAKE_ACCT,
        acct: FAKE_ACCT,
        url: `${instance}/@${FAKE_ACCT}`,
        display_name: "Fake account (example.test)",
      };

    case "status_create": {
      // Seeded from the segment text and its position, so each status of a
      // thread gets its own id and a chain built against the faker is a chain.
      const id = `fake${fake.hex(14)}`;

      return {
        id,
        url: `${instance}/@${FAKE_ACCT}/${id}`,
        uri: `${instance}/users/${FAKE_ACCT}/statuses/${id}`,
        created_at: fake.timestamp(),
        visibility: "public",
        content: `<p>${String(config.text ?? "")}</p>`,
      };
    }

    case "status_get": {
      const id = typeof config.statusId === "string" ? config.statusId : `fake${fake.hex(14)}`;

      return {
        id,
        url: `${instance}/@${FAKE_ACCT}/${id}`,
        favourites_count: fake.int(0, 40),
        reblogs_count: fake.int(0, 12),
        replies_count: fake.int(0, 8),
      };
    }

    default:
      throw new Error(
        `mastodon faker has no case for "${operation}". Add one when you add the call — a faker that returns ` +
          "an empty object for an unknown operation turns a typo into a provider that answered.",
      );
  }
};
