/**
 * Discord's faker — a webhook's answer, with nothing real in it.
 *
 * Snowflakes are 17–19 digits, so a fake one cannot carry the word "fake". It
 * carries an all-zero prefix instead: `000000000000` + six seeded digits, which
 * is not a shape Discord ever mints and is recognisable at a glance.
 *
 * `webhook_execute` returns the shape a **`?wait=true`** call returns. Without
 * that parameter Discord answers `204 No Content` and there is no id — see the
 * connector, which treats that as a failure rather than a success nobody can
 * point at.
 */

import type { ConnectorFaker } from "@particle-academy/fancy-connector-core";

/** Not a shape Discord mints. Twelve zeros, then six seeded digits. */
function fakeSnowflake(hex: string): string {
  return `000000000000${(parseInt(hex.slice(0, 6), 16) % 1_000_000).toString().padStart(6, "0")}`;
}

export const discordFaker: ConnectorFaker = (operation, request) => {
  const { fake, config } = request;

  switch (operation) {
    case "webhook_get":
      return {
        id: fakeSnowflake(fake.hex(8)),
        type: 1,
        name: "Fake webhook (nothing was sent)",
        channel_id: fakeSnowflake(fake.hex(8)),
        guild_id: fakeSnowflake(fake.hex(8)),
      };

    case "webhook_execute":
      return {
        id: fakeSnowflake(fake.hex(8)),
        channel_id: fakeSnowflake(fake.hex(8)),
        content: String(config.text ?? ""),
        timestamp: fake.timestamp(),
        webhook_id: fakeSnowflake(fake.hex(8)),
      };

    default:
      throw new Error(
        `discord faker has no case for "${operation}". Add one when you add the call — a faker that returns ` +
          "an empty object for an unknown operation turns a typo into a provider that answered.",
      );
  }
};
