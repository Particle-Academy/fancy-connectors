/**
 * What this connector depends on, and the probe that proves the transport.
 */

import {
  ConnectorError,
  callConnector,
  type ApiContract,
  type ProbeSpec,
} from "@particle-academy/fancy-connector-core";

import { TELEGRAM_API, TELEGRAM_SERVICE, telegramPath } from "./connector.ts";

/**
 * Telegram publishes NOTHING machine-readable, and the fallback is honest about
 * why rather than about nothing.
 *
 * Checked 2026-08-19:
 *
 * - `core.telegram.org/bots/api` is HTML prose. It is versioned and has a
 *   changelog, and it is the only authoritative description that exists. There
 *   is no JSON, no OpenAPI, no schema at any Telegram URL.
 * - The best-known generated spec, `ark0f/tg-bot-api`
 *   (`ark0f.github.io/tg-bot-api/openapi.json`), still serves 200 — but its
 *   `Last-Modified` is **2025-02-14** and its `gh-pages` branch has not moved
 *   since. Checking against an 18-month-old generated document would report
 *   CLEAN about a spec nobody is regenerating, which is strictly worse than
 *   reporting unchecked: a clean report is evidence somebody is watching.
 *
 * So `kind: "none"` with the reason and the fallback named. A `none` with no
 * reason is indistinguishable from nobody having looked, which is the whole
 * point of the field being required on that variant.
 *
 * The fallback is `checkAgainstRecordedShape()` against the `reads` below —
 * field NAMES from a live response, never values, because a recorded response
 * from a real account is a data leak wearing a test fixture's clothes.
 */
export const TELEGRAM_CONTRACT: ApiContract = {
  connector: "telegram",
  baseUrl: TELEGRAM_API,
  spec: {
    kind: "none",
    note:
      "Telegram publishes the Bot API as HTML only (core.telegram.org/bots/api) — no OpenAPI, no JSON, no " +
      "schema at any Telegram URL (checked 2026-08-19). The best-known generated spec, ark0f/tg-bot-api, was " +
      "last regenerated 2025-02-14, so checking against it would report CLEAN about a document nobody is " +
      "maintaining — worse than unchecked, because a clean report reads as evidence somebody is watching. " +
      "Fallback: checkAgainstRecordedShape() against the `reads` declared here, plus a human reading the " +
      "changelog at the top of the HTML docs.",
  },
  operations: [
    {
      operation: "get_me",
      // The Bot API accepts GET or POST on every method. GET, because verify is
      // a read and the method should say so.
      method: "GET",
      path: "/bot{token}/getMe",
      // Dotted paths, for the recorded-shape checker. `ok` is declared
      // deliberately: the envelope is not decoration here, it is where a real
      // failure arrives, and a response that stopped carrying it would break the
      // one check that separates a send from a silent non-send.
      reads: ["ok", "result.id", "result.username", "result.is_bot"],
    },
    {
      operation: "send_message",
      method: "POST",
      path: "/bot{token}/sendMessage",
      sends: ["chat_id", "text", "reply_to_message_id"],
      reads: ["ok", "description", "result.message_id", "result.chat.id"],
    },
  ],
  reviewedOn: "2026-08-19",
};

/**
 * A token that cannot be valid, in the right SHAPE.
 *
 * `<digits>:<35 chars>` is what a real one looks like. Shape matters: a token
 * that is obviously malformed could plausibly get a 404 on the path rather than
 * a 401 on the credential, and then the probe would be testing the wrong thing.
 */
const IMPOSSIBLE_TOKEN = "0000000000:FancyConnectorsProbeInvalidToken0000";

export const TELEGRAM_PROBE: ProbeSpec = {
  connector: "telegram",
  request: async () => {
    try {
      await callConnector(TELEGRAM_SERVICE, {
        operation: "get_me",
        mode: "live",
        credentials: { botToken: IMPOSSIBLE_TOKEN, chat: "@unset" },
        request: { method: "GET", path: telegramPath(IMPOSSIBLE_TOKEN, "getMe") },
        attempts: 1,
      });

      return { status: 200, body: "Telegram ACCEPTED a bot token that cannot be valid." };
    } catch (error) {
      if (error instanceof ConnectorError && error.status !== undefined) {
        return { status: error.status, body: error.message };
      }

      throw error;
    }
  },
  authStatuses: [401],
  why:
    "Telegram answers 401 Unauthorized for a bot token it does not accept, even though the token is in the " +
    "PATH — unlike Discord, which answers 404 for the same shape of mistake. That difference is exactly why " +
    "authStatuses is declared per provider instead of assumed: here a 404 would mean the method name is wrong " +
    "or the API moved, which is drift, and accepting it would let real drift read as a pass.",
};
