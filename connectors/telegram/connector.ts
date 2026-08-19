/**
 * Telegram — a bot posting to a channel or a group.
 *
 * Vendored source. It imports from `*`; a consumer who copies this
 * directory rewrites those to `@particle-academy/fancy-connector-core`.
 *
 * ## Three facts that shape every line below
 *
 * 1. **A `200 OK` is not a success.** The Bot API answers `200` with
 *    `{"ok": false, "description": "…"}` for real failures — the bot is not in
 *    the chat, the chat id does not exist, a permission is missing. A caller
 *    that trusted the HTTP status would record a successful send for a message
 *    that was never delivered. So the ENVELOPE is checked, the provider's own
 *    `description` is what gets reported, and the failure is classified as a
 *    REJECTION: every cause is configuration and none of them improves on a
 *    retry.
 * 2. **The token is in the URL PATH**, not a header. It must be URL-encoded, and
 *    it appears in any logged request URL — so a host must not log request URLs
 *    for this connector.
 * 3. **A public link exists only for `@public` channels.** For a numeric private
 *    chat the URL is `null`, never invented. A fabricated `t.me/c/…` works for
 *    members and 404s for everyone else, which is worse than no link because it
 *    looks checkable.
 *
 * ## How `call` reports
 *
 * `ok: false` + `ref: null` when it refused before touching the network; a throw
 * carrying a classified failure otherwise; never `ok: true` with a null `ref`.
 * There is no partial case — a message is one request.
 */

import {
  ConnectorAmbiguous,
  ConnectorConfigError,
  callConnector,
  httpFailure,
  isEmptyPayload,
  render,
  respectRate,
  type CallResult,
  type Classified,
  type Connector,
  type ConnectorMode,
  type DeliveryDeclaration,
  type Problem,
  type ProviderAdapter,
  type RenderRules,
  type RenderedPayload,
  type ServiceDescriptor,
  type VerifyResult,
} from "@particle-academy/fancy-connector-core";

import { telegramFaker } from "./faker.ts";

/* ── The host's content, as this connector needs it ──────────────────────── */

export type TelegramTarget = {
  /** The copy, exactly as approved. */
  text: string;
  /** What Telegram will ACTUALLY receive, already rendered and approved. */
  rendered?: RenderedPayload;
  /** Assets and their alt text. The renderer cannot judge either. */
  media?: Array<{ file: string; alt: string | null }>;
  /** What this answers, when it is a reply. Telegram needs one message id. */
  replyTo?: { provider: string; context: Record<string, string> };
};

/* ── The envelope, which is the whole point ──────────────────────────────── */

export type TelegramEnvelope<T> = {
  ok?: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

/**
 * Unwrap a Bot API envelope, or raise the provider's own words as a failure.
 *
 * **A `200 OK` with `{"ok": false}` is a real failure**, and this is the one
 * place that knows it. `httpFailure(400, …)` classifies it as a REJECTION rather
 * than something to retry: the causes are configuration — the bot is not in the
 * chat, no permission to post, a wrong chat id — and none of them improves by
 * trying again. `errors.ts` documents this exact case as the reason
 * `httpFailure` exists.
 *
 * The thrown error carries `.classified` (a `Classified`), which is the shape
 * `deliver()` reads and a host can route on.
 */
export function telegramResultFrom<T>(body: TelegramEnvelope<T> | null | undefined, operation: string): T {
  if (!body?.ok) {
    throw httpFailure(
      400,
      `Telegram refused ${operation} — ${body?.description ?? "no reason given"}. ` +
        "That arrived as a 200 OK with an ok:false envelope, which is how the Bot API reports a bot that is " +
        "not in the chat, a missing 'Post Messages' permission, or a chat id that does not exist. None of " +
        "those improves on a retry.",
    );
  }

  if (body.result === undefined || body.result === null) {
    throw new ConnectorAmbiguous(
      `Telegram answered ok:true for ${operation} but sent no result, so there is nothing to record it as.`,
      { service: "telegram", operation },
    );
  }

  return body.result;
}

/** True when a thrown error is the classified kind this connector raises. */
export function classificationOf(error: unknown): Classified | undefined {
  return (error as { classified?: Classified } | null)?.classified;
}

/* ── Refs ────────────────────────────────────────────────────────────────── */

export type TelegramSent = { messageId: number; chatId: number | string };

export function telegramSentFrom(result: {
  message_id?: number;
  chat?: { id?: number | string };
}, chat: string): TelegramSent {
  if (typeof result.message_id !== "number") {
    throw new ConnectorAmbiguous(
      "Telegram accepted the message but returned no message_id, so there is nothing to record it as. It has " +
        "probably been sent — go and look at the chat rather than re-running, because sendMessage takes no " +
        "idempotency key.",
      { service: "telegram", operation: "send_message" },
    );
  }

  return { messageId: result.message_id, chatId: result.chat?.id ?? chat };
}

/**
 * The public link to a message, where one exists.
 *
 * **Only public channels (`@name`) have one.** A numeric private chat has no web
 * URL, and inventing `t.me/c/<internal>/<id>` for it produces a link that works
 * for members and 404s for everyone else — worse than no link, because it looks
 * checkable. `null` is the honest answer and the caller stores the message id
 * instead.
 */
export function telegramMessageUrl(chat: string, messageId: number): string | null {
  return chat.startsWith("@") ? `https://t.me/${chat.slice(1)}/${messageId}` : null;
}

/* ── Rendering ───────────────────────────────────────────────────────────── */

/**
 * 4096 characters, and **`thread: false`** — which is a judgement, flagged.
 *
 * `reply_to_message_id` exists, so a chain is technically possible. In a channel
 * it renders as a run of quoted replies rather than as a thread a reader follows,
 * and at 4096 characters copy that needs splitting is nearly always copy that
 * needs rewriting. So over-length content is REFUSED rather than split into
 * fragments that arrive looking deliberate.
 *
 * A host that disagrees changes `thread` to `true` and gets numbered segments;
 * this connector still passes `reply_to_message_id` when the target names a
 * message it is answering, because answering somebody is a different act from
 * threading.
 */
export const TELEGRAM_RULES: RenderRules = {
  limit: 4_096,
  unit: "characters",
  thread: false,
  label: "Telegram",
};

function payloadFor(target: TelegramTarget): RenderedPayload {
  return target.rendered ?? render(target.text, TELEGRAM_RULES);
}

/* ── Delivery ────────────────────────────────────────────────────────────── */

export const TELEGRAM_DELIVERY: DeliveryDeclaration = {
  idempotent: false,
  why:
    "sendMessage takes no idempotency key and no client-supplied nonce, so a repeated call sends a second " +
    "message. An ambiguous failure is reported for a person, who can look at the chat.",
  // Telegram's own words, and a genuine MINIMUM GAP rather than a budget — which
  // is why this one is "documented" where Bluesky's and Mastodon's are not.
  minIntervalMs: 1_000,
  rateSource: "documented",
  citation: {
    url: "https://core.telegram.org/bots/faq",
    readOn: "2026-08-19",
    quote:
      "In a single chat, avoid sending more than one message per second. We may allow short bursts that go " +
      "over this limit, but eventually you'll begin receiving 429 errors.",
  },
};

/* ── The wire ────────────────────────────────────────────────────────────── */

export const TELEGRAM_API = "https://api.telegram.org";

/**
 * The service descriptor.
 *
 * `authorize` is deliberately empty and deliberately present: **the token is a
 * PATH SEGMENT**, so there is no header to add. Writing that down is what stops
 * someone adding a `Bearer` line that would do nothing while looking correct —
 * and it is where the consequence belongs, which is that the credential is in
 * every request URL and a host must not log them.
 */
export const TELEGRAM_SERVICE: ServiceDescriptor = {
  service: "telegram",
  title: "Telegram",
  // BotFather issues one kind of token and there is no test estate behind it.
  sandbox: "none",
  baseUrls: { live: TELEGRAM_API, sandbox: TELEGRAM_API },
  requires: ["botToken", "chat"],
  authorize: () => {
    // Nothing. See the note above.
  },
  faker: telegramFaker,
};

/** `bot<token>/<method>` — the token is URL-encoded because it is a path segment. */
export function telegramPath(token: string, method: string): string {
  return `bot${encodeURIComponent(token)}/${method}`;
}

/* ── Validation: everything the renderer cannot judge, and NOT length ────── */

export function validateTelegram(target: TelegramTarget): Problem[] {
  const problems: Problem[] = [];

  if (target.text.trim() === "") {
    problems.push({ severity: "block", message: "There is no copy to send." });
  }

  for (const asset of target.media ?? []) {
    if (!asset.alt) {
      problems.push({
        severity: "block",
        message: `"${asset.file}" has no alt text. Same rule as every other channel.`,
      });
    }
  }

  return problems;
}

/* ── Standing it up ──────────────────────────────────────────────────────── */

/**
 * The `proves` line that matters most in this catalogue.
 *
 * `getMe` validates the token and says NOTHING about whether the bot was added
 * to the target chat — which is the step everyone actually gets stuck on. A
 * green tick that means more than it should is worse than no tick.
 */
const TELEGRAM_VERIFY_PROVES =
  "That the bot TOKEN is valid and names the bot it belongs to. It says NOTHING about whether the bot has " +
  "been added to your channel or group, or given permission to post there — which is the step everyone " +
  "actually gets stuck on, and the one this check cannot reach. A valid token that reaches nothing looks " +
  "identical to a valid token that reaches everything until the first send, so a green tick here is not " +
  "evidence that a dispatch will land; the first dry run against the real chat is what proves that end.";

export const telegramProvider: ProviderAdapter = {
  id: "telegram",
  label: "Telegram",
  implemented: true,
  summary: "A bot posts to a channel or group. A token from BotFather, and the chat it is allowed to post in.",
  // BotFather issues a token; there is no consent screen and nothing to scope.
  scopes: [],
  sandbox: "none",
  fields: [
    {
      key: "botToken",
      label: "Bot token",
      help:
        "From @BotFather when you create the bot. One token per bot, revocable there with /revoke. It travels " +
        "in the URL PATH rather than a header, so it appears in any logged request URL — do not log them.",
      scope: "account",
      secret: true,
      required: true,
      placeholder: "1234567890:AA…",
    },
    {
      key: "chat",
      label: "Channel or chat id",
      help:
        "A public channel can use @its_name. A private channel or group needs its numeric id, which starts " +
        "with -100. The bot must ALREADY be a member with permission to post — a valid token alone reaches " +
        "nothing. Only an @name gets a public t.me link; a numeric chat has none, and this connector will not " +
        "invent one.",
      scope: "account",
      secret: false,
      required: true,
      placeholder: "@yourchannel",
    },
  ],
  setup: [
    {
      title: "Create the bot",
      detail:
        "Message @BotFather, send /newbot, keep the token. No review, no app registration. **The trap:** the " +
        "token is shown once in a chat message that scrolls away — and /revoke is the only recovery, which " +
        "invalidates the one you lost along with the one you are using.",
      url: "https://core.telegram.org/bots#how-do-i-create-a-bot",
    },
    {
      title: "Add the bot to the chat AND give it permission to post",
      detail:
        "**This is the step that catches people.** Being a member is not enough: in a channel the bot must be " +
        "an administrator with 'Post Messages'. A token that verifies perfectly will still be refused at send " +
        "time without it — and the refusal arrives as a 200 OK with ok:false, so anything trusting the HTTP " +
        "status records a send that never happened.",
    },
    {
      title: "Get the chat id right",
      detail:
        "Public channel: @its_name. Private channel or group: the numeric id, beginning -100. **The trap:** " +
        "assuming the @name always works — it does not exist for a private chat, and the numeric id is not " +
        "discoverable from the Telegram app without forwarding a message to a lookup bot or reading " +
        "getUpdates.",
    },
  ],
  async verify(credentials): Promise<VerifyResult> {
    if (!credentials.botToken) {
      return { ok: false, detail: "Needs the bot token.", proves: TELEGRAM_VERIFY_PROVES };
    }

    try {
      const result = await callConnector<TelegramEnvelope<{ username?: string; first_name?: string }>>(
        TELEGRAM_SERVICE,
        {
          operation: "get_me",
          mode: "live",
          // `chat` is in `requires` for a send and is irrelevant to getMe, so a
          // placeholder keeps the descriptor honest without asking an operator
          // for a chat before they have a token that works.
          credentials: { ...credentials, chat: credentials.chat || "@unset" },
          request: { method: "GET", path: telegramPath(credentials.botToken, "getMe") },
          idempotent: true,
        },
      );

      const me = telegramResultFrom(result.data, "getMe");

      return {
        ok: true,
        detail: `The token is valid and belongs to @${me.username ?? "(unknown)"}.`,
        proves: TELEGRAM_VERIFY_PROVES,
      };
    } catch (error) {
      return {
        ok: false,
        detail:
          (error instanceof Error ? error.message : String(error)) +
          " Telegram answers 401 for a token it does not accept — it may have been revoked in BotFather, or " +
          "copied with a character missing.",
        proves: TELEGRAM_VERIFY_PROVES,
      };
    }
  },
};

/* ── The connector ───────────────────────────────────────────────────────── */

export const telegramConnector: Connector<TelegramTarget> = {
  id: "telegram",
  // The core surface this was written against — a LITERAL, never the
  // imported CONNECTOR_API_VERSION.
  //
  // That distinction is the whole mechanism. This file is VENDORED: it is
  // copied into a consumer's project and frozen there. If it read the
  // constant, then upgrading the core would change what this copy claims
  // to have been written against, and the check would agree with itself
  // forever while the surface moved underneath. A literal is the only
  // value that still means something a year after it was copied.
  connectorApi: 1,
  label: "Telegram",
  provider: "telegram",
  // The Bot API gives a bot no dependable view of a channel post's views or
  // reactions, so this reports nothing — and there is NO metricShape below,
  // rather than an empty one.
  capabilities: { call: true, metrics: false, feedback: false },
  delivery: TELEGRAM_DELIVERY,
  renderRules: TELEGRAM_RULES,
  validate: validateTelegram,

  async call(target, options): Promise<CallResult> {
    const mode: ConnectorMode = options.dryRun ? "fake" : (options.mode ?? "live");
    const dryRun = mode === "fake";
    const payload = payloadFor(target);
    const blocking = validateTelegram(target)
      .filter((problem) => problem.severity === "block")
      .map((problem) => problem.message);
    const refusals = [
      ...blocking,
      ...payload.problems,
      ...(isEmptyPayload(payload)
        ? ["The rendered payload is empty. The sha of the empty string is a valid sha, so this has to be refused here."]
        : []),
    ];

    if (refusals.length > 0) {
      return {
        ok: false,
        ref: null,
        dryRun,
        mode,
        detail: `Refused before anything was sent — ${refusals.join(" ")}`,
      };
    }

    const credentials = options.credentials ?? {};
    const chat = credentials.chat || (dryRun ? "@fake_example_channel" : "");
    const token = credentials.botToken ?? "";

    if (!dryRun && (token === "" || chat === "")) {
      throw new ConnectorConfigError(
        "Telegram needs both `botToken` and `chat`. Nothing is inferred from an incomplete credential set — a " +
          "bot with no chat reaches nobody, and a chat with no bot cannot be written to.",
        { service: "telegram", operation: "send_message" },
      );
    }

    const text = payload.segments.map((segment) => segment.text).join("\n\n");
    const replyToMessageId = telegramReplyId(target.replyTo);

    if (!dryRun) await respectRate("telegram", TELEGRAM_DELIVERY.minIntervalMs);

    const response = await callConnector<
      TelegramEnvelope<{ message_id?: number; chat?: { id?: number | string } }>
    >(TELEGRAM_SERVICE, {
      operation: "send_message",
      mode,
      credentials: { ...credentials, botToken: token, chat },
      config: { chat, text },
      request: {
        method: "POST",
        // The token is a path segment. See TELEGRAM_SERVICE.authorize.
        path: telegramPath(token, "sendMessage"),
        json: {
          chat_id: chat,
          text,
          // Plain text, deliberately. Telegram's markdown parsers reject
          // unbalanced characters — an underscore in a name is enough — and a
          // send that fails on punctuation fails at the worst moment. The copy
          // was approved as text; it goes as text.
          ...(replyToMessageId === undefined ? {} : { reply_to_message_id: replyToMessageId }),
        },
      },
      idempotent: TELEGRAM_DELIVERY.idempotent,
    });

    // A 200 is not enough. The envelope decides.
    const sent = telegramSentFrom(telegramResultFrom(response.data, "sendMessage"), chat);
    const url = telegramMessageUrl(chat, sent.messageId);

    return {
      ok: true,
      // The web URL where there is one, the message id otherwise. Never an
      // invented link.
      ref: url ?? String(sent.messageId),
      dryRun,
      mode,
      detail: dryRun
        ? `Dry run — would send ${payload.segments[0]?.count ?? 0}/4096 characters to ${chat}. ` +
          "Nothing left the building."
        : `Sent to ${chat}${url ? ` — ${url}` : " (a private chat, so there is no public link)"}.`,
    };
  },

  // No fetchMetrics. The Bot API gives a bot no dependable view of a channel
  // post's views or reactions, and an empty implementation would turn "not
  // available" into a reported zero.
};

/** What `target.replyTo` means here, or nothing if it is not ours. */
export function telegramReplyId(replyTo: TelegramTarget["replyTo"]): number | undefined {
  if (replyTo?.provider !== "telegram") return undefined;

  const raw = Number(replyTo.context.messageId ?? "");

  return Number.isInteger(raw) && raw > 0 ? raw : undefined;
}
