/**
 * Telegram — a `200 OK` that means no, a token in the path, and a link that must
 * not be invented.
 *
 * No network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { registerTransport, type PreparedRequest, type TransportResponse } from "../src/client.ts";
import { resetRateState, shouldRetry } from "../src/delivery.ts";
import { capabilityProblems } from "../src/metrics.ts";
import type { Connector } from "../src/seam.ts";
import {
  TELEGRAM_RULES,
  classificationOf,
  telegramConnector,
  telegramMessageUrl,
  telegramPath,
  telegramProvider,
  telegramReplyId,
  telegramResultFrom,
  telegramSentFrom,
} from "../connectors/telegram/connector.ts";

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

const CREDENTIALS = { botToken: "1234567890:AAbbCCddEEffGGhh", chat: "@yourchannel" };

/* ── A 200 OK IS NOT A SUCCESS ────────────────────────────────────────────── */

test("A 200 OK WITH ok:false IS A FAILURE, not a success", async () => {
  const transport = fakeTransport();
  transport.queue.push({
    // Exactly what the Bot API sends when the bot is not in the chat: HTTP 200,
    // and a refusal in the envelope.
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }),
  });
  transport.install();

  try {
    await assert.rejects(
      telegramConnector.call({ text: "Hello, channel." }, { dryRun: false, credentials: CREDENTIALS }),
      (error: Error) => {
        // Telegram's OWN words — more useful than anything paraphrased.
        assert.match(error.message, /Bad Request: chat not found/);
        assert.match(error.message, /200 OK with an ok:false envelope/);

        const classified = classificationOf(error);
        assert.equal(
          classified?.kind,
          "rejected",
          "the causes are configuration — not in the chat, no permission, wrong id — and none improves on a retry",
        );
        assert.equal(shouldRetry(classified!.kind, { idempotent: false }), false);

        return true;
      },
    );
  } finally {
    registerTransport(null);
  }
});

test("the envelope check is a pure function, so the rule is testable on its own", () => {
  assert.deepEqual(telegramResultFrom({ ok: true, result: { message_id: 7 } }, "sendMessage"), { message_id: 7 });

  assert.throws(
    () => telegramResultFrom({ ok: false, description: "Forbidden: bot is not a member" }, "sendMessage"),
    (error: Error) => {
      assert.match(error.message, /Forbidden: bot is not a member/);
      assert.equal(classificationOf(error)?.kind, "rejected");

      return true;
    },
  );

  assert.throws(
    () => telegramResultFrom({ ok: false }, "sendMessage"),
    /no reason given/,
    "a refusal with no description still has to say a refusal happened",
  );
});

test("ok:true with no result is a failure too — there would be nothing to record", () => {
  assert.throws(
    () => telegramResultFrom({ ok: true }, "sendMessage"),
    (error: Error) => error.name === "ConnectorAmbiguous",
  );
});

test("a successful send reports the id and reaches the right path", async () => {
  const transport = fakeTransport();
  transport.queue.push({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, result: { message_id: 4412, chat: { id: -1_001_234_567_890 } } }),
  });
  transport.install();

  try {
    const result = await telegramConnector.call({ text: "Hello, channel." }, {
      dryRun: false,
      credentials: CREDENTIALS,
    });

    assert.equal(result.ok, true);
    assert.equal(result.ref, "https://t.me/yourchannel/4412");
    assert.match(transport.calls[0]!.url, /\/bot1234567890%3AAAbbCCddEEffGGhh\/sendMessage$/);
    assert.equal(
      transport.calls[0]!.headers.Authorization,
      undefined,
      "the token is a PATH segment; adding a header would do nothing while looking correct",
    );
  } finally {
    registerTransport(null);
  }
});

/* ── the token is in the PATH ─────────────────────────────────────────────── */

test("the token is URL-encoded, because it is a path segment", () => {
  assert.equal(telegramPath("123:AB/cd", "getMe"), "bot123%3AAB%2Fcd/getMe");
});

/* ── a public link exists only for @public channels ───────────────────────── */

test("a numeric private chat has NO public link, and one is never invented", () => {
  assert.equal(telegramMessageUrl("@yourchannel", 4412), "https://t.me/yourchannel/4412");
  assert.equal(
    telegramMessageUrl("-1001234567890", 4412),
    null,
    "a fabricated t.me/c/… link works for members and 404s for everyone else — worse than none, because it looks checkable",
  );
});

test("with no public link the ref is the message id, and the detail says why", async () => {
  const transport = fakeTransport();
  transport.queue.push({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, result: { message_id: 4412, chat: { id: -1_001_234_567_890 } } }),
  });
  transport.install();

  try {
    const result = await telegramConnector.call({ text: "Hello." }, {
      dryRun: false,
      credentials: { botToken: "1:AA", chat: "-1001234567890" },
    });

    assert.equal(result.ref, "4412");
    assert.match(result.detail, /no public link/);
  } finally {
    registerTransport(null);
  }
});

test("a message id is required — a 2xx without one is a failure", () => {
  assert.throws(
    () => telegramSentFrom({ chat: { id: 1 } }, "@c"),
    (error: Error) => error.name === "ConnectorAmbiguous" && /nothing to record it as/.test(error.message),
  );
  assert.deepEqual(telegramSentFrom({ message_id: 9, chat: { id: 1 } }, "@c"), { messageId: 9, chatId: 1 });
});

/* ── verify says exactly what it does not prove ───────────────────────────── */

test("verify's `proves` says it validates the TOKEN and nothing about the chat", async () => {
  const transport = fakeTransport();
  transport.queue.push({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, result: { id: 7, is_bot: true, username: "yourbot" } }),
  });
  transport.install();

  try {
    const result = await telegramProvider.verify!({ botToken: "1:AA", chat: "@yourchannel" });

    assert.equal(result.ok, true);
    assert.match(result.detail, /@yourbot/);
    assert.match(result.proves ?? "", /says NOTHING about whether the bot has been added/);
    assert.match(result.proves ?? "", /permission to post/);
  } finally {
    registerTransport(null);
  }
});

test("a failed verify carries the same `proves`, so a red tick is not read as more either", async () => {
  const transport = fakeTransport();
  transport.queue.push({ status: 401, headers: {}, body: '{"ok":false,"description":"Unauthorized"}' });
  transport.install();

  try {
    const result = await telegramProvider.verify!({ botToken: "bad" });

    assert.equal(result.ok, false);
    assert.match(result.proves ?? "", /says NOTHING about whether the bot has been added/);
  } finally {
    registerTransport(null);
  }
});

/* ── replies, rendering, capabilities, delivery ───────────────────────────── */

test("replyTo is read only when it is ours, and only when it is a real id", () => {
  assert.equal(telegramReplyId({ provider: "telegram", context: { messageId: "17" } }), 17);
  assert.equal(telegramReplyId({ provider: "bluesky", context: { messageId: "17" } }), undefined);
  assert.equal(telegramReplyId({ provider: "telegram", context: { messageId: "nope" } }), undefined);
  assert.equal(telegramReplyId(undefined), undefined);
});

test("4096 characters, and thread: false", () => {
  assert.equal(TELEGRAM_RULES.limit, 4_096);
  assert.equal(TELEGRAM_RULES.thread, false);
  assert.equal(TELEGRAM_RULES.unit, "characters");
});

test("NO metricShape at all — the Bot API gives a bot no dependable view", () => {
  assert.equal(telegramConnector.capabilities.metrics, false);
  assert.equal("metricShape" in telegramConnector, false);
  assert.equal(telegramConnector.fetchMetrics, undefined);
  assert.deepEqual(capabilityProblems(telegramConnector as unknown as Connector<never>), []);
});

test("the rate figure is TELEGRAM'S — a documented minimum gap, not a budget", () => {
  assert.equal(telegramConnector.delivery.rateSource, "documented");
  assert.equal(telegramConnector.delivery.minIntervalMs, 1_000);
  assert.match(
    telegramConnector.delivery.citation?.quote ?? "",
    /avoid sending more than one message per second/,
  );
  assert.equal(telegramConnector.delivery.citation?.readOn, "2026-08-19");
});

test("the chat id is not a secret, and the bot token is", () => {
  const fields = Object.fromEntries(telegramProvider.fields.map((field) => [field.key, field]));

  assert.equal(fields.botToken?.secret, true);
  assert.equal(fields.chat?.secret, false);
  assert.match(fields.chat?.help ?? "", /must ALREADY be a member/);
});
