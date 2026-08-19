/**
 * Telegram's faker — the Bot API envelope, with nothing real in it.
 *
 * **The envelope is part of the shape.** Every Bot API response is
 * `{ ok, result }`, and a faker that returned the bare `result` would let a
 * connector forget the envelope exists — which is exactly the bug the live path
 * has to guard against, because a `200 OK` with `{"ok": false}` is a real
 * failure. So the faker returns what the provider returns.
 *
 * Message ids are small integers, so a fake one cannot carry the word "fake".
 * They start at 900000000 instead — an implausible message number in a young
 * chat and recognisable next to a real one.
 */

import type { ConnectorFaker } from "@particle-academy/fancy-connector-core";

export const FAKE_BOT_USERNAME = "fake_example_bot";

export const telegramFaker: ConnectorFaker = (operation, request) => {
  const { fake, config } = request;

  switch (operation) {
    case "get_me":
      return {
        ok: true,
        result: {
          id: 900_000_000 + fake.int(0, 999_999),
          is_bot: true,
          first_name: "Fake bot (nothing was sent)",
          username: FAKE_BOT_USERNAME,
          can_join_groups: true,
        },
      };

    case "send_message": {
      const chat = typeof config.chat === "string" ? config.chat : "@fake_example_channel";

      return {
        ok: true,
        result: {
          message_id: 900_000_000 + fake.int(0, 999_999),
          date: Math.floor(Date.parse(fake.timestamp()) / 1000),
          text: String(config.text ?? ""),
          chat: {
            // A public chat keeps its @name; a numeric one keeps a numeric id,
            // because which of the two it is decides whether a public link
            // exists at all — and the faker must not make that question go away.
            id: chat.startsWith("@") ? chat : Number(chat) || -1_001_900_000_000,
            type: chat.startsWith("@") ? "channel" : "supergroup",
          },
        },
      };
    }

    default:
      throw new Error(
        `telegram faker has no case for "${operation}". Add one when you add the call — a faker that returns ` +
          "an empty object for an unknown operation turns a typo into a provider that answered.",
      );
  }
};
