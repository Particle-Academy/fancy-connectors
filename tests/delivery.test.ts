/**
 * The failure classification, and the one case the previous runtime got wrong.
 *
 * `retry-is-safe` is decided in exactly one place, so this is the file that
 * decides whether this package can ever produce a duplicate write.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AMBIGUOUS_REFUSAL,
  classifyError,
  classifyStatus,
  deliver,
  isUnconditionallyRetryable,
  resetRateState,
  respectRate,
  shouldRetry,
  type RetryPolicy,
} from "../src/delivery.ts";
import { callConnector, type ServiceDescriptor } from "../src/client.ts";
import { ConnectorAmbiguous, ConnectorTransient, ConnectorUnreachable, httpFailure } from "../src/errors.ts";

const coded = (code: string, name = "Error"): Error => {
  const error = new Error(`synthetic ${code}`);
  error.name = name;
  (error as Error & { code?: string }).code = code;

  return error;
};

const IDEMPOTENT: RetryPolicy = { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000, idempotent: true };
const NOT_IDEMPOTENT: RetryPolicy = { ...IDEMPOTENT, idempotent: false };

test("a request that never left is unreachable", () => {
  assert.equal(classifyError(coded("ECONNREFUSED")).kind, "unreachable");
  assert.equal(classifyError(coded("ENOTFOUND")).kind, "unreachable");
  assert.equal(classifyError(coded("ECONNRESET")).kind, "unreachable");
});

test("a timeout is AMBIGUOUS, not transient", () => {
  assert.equal(classifyError(coded("ETIMEDOUT")).kind, "ambiguous");
  assert.equal(classifyError(coded("", "AbortError")).kind, "ambiguous");
  assert.equal(classifyError(coded("UND_ERR_HEADERS_TIMEOUT")).kind, "ambiguous");
});

test("an unrecognised error falls to ambiguous, never to safe", () => {
  assert.equal(classifyError(new Error("something odd")).kind, "ambiguous");
  assert.equal(classifyError("a string").kind, "ambiguous");
  assert.equal(classifyError(null).kind, "ambiguous");
});

test("429 and 5xx are explicit refusals; other 4xx are real noes", () => {
  assert.equal(classifyStatus(429, "slow down").kind, "refused-explicitly");
  assert.equal(classifyStatus(503, "maintenance").kind, "refused-explicitly");
  assert.equal(classifyStatus(500, "").kind, "refused-explicitly");
  assert.equal(classifyStatus(401, "bad token").kind, "rejected");
  assert.equal(classifyStatus(422, "too long").kind, "rejected");
  assert.equal(classifyStatus(404, "gone").kind, "rejected");
});

test("Retry-After is carried through", () => {
  assert.equal(classifyStatus(429, "", "30").retryAfter, 30);
  assert.equal(classifyStatus(429, "", "not-a-number").retryAfter, undefined);
  assert.equal(classifyStatus(429, "").retryAfter, undefined);
});

test("THE RULE — ambiguity is retryable only where the provider makes it safe", () => {
  assert.equal(shouldRetry("ambiguous", NOT_IDEMPOTENT), false);
  assert.equal(shouldRetry("ambiguous", IDEMPOTENT), true);
  assert.equal(shouldRetry("unreachable", NOT_IDEMPOTENT), true);
  assert.equal(shouldRetry("refused-explicitly", NOT_IDEMPOTENT), true);
  assert.equal(shouldRetry("rejected", IDEMPOTENT), false);
});

test("`retryable` on an error answers only the unconditional half", () => {
  // The narrow question, deliberately: an old caller reading `.retryable`
  // becomes conservative rather than wrong.
  assert.equal(new ConnectorAmbiguous("x", { service: "s", operation: "o" }).retryable, false);
  assert.equal(new ConnectorTransient("x", { service: "s", operation: "o" }).retryable, true);
  assert.equal(new ConnectorUnreachable("x", { service: "s", operation: "o" }).retryable, true);
  assert.equal(isUnconditionallyRetryable("ambiguous"), false);
});

test("a timeout on a non-idempotent connector is NOT retried, and says go and look", async () => {
  let calls = 0;
  const outcome = await deliver(
    async () => {
      calls += 1;
      throw coded("ETIMEDOUT");
    },
    NOT_IDEMPOTENT,
    async () => {},
  );

  assert.equal(calls, 1, "one attempt only");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "ambiguous");
  assert.ok(outcome.gaveUp?.includes(AMBIGUOUS_REFUSAL.slice(0, 40)));
});

test("the same timeout on an idempotent connector IS retried", async () => {
  let calls = 0;
  const outcome = await deliver(
    async () => {
      calls += 1;
      if (calls === 1) throw coded("ETIMEDOUT");

      return "sent";
    },
    IDEMPOTENT,
    async () => {},
  );

  assert.equal(calls, 2);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value, "sent");
  assert.equal(outcome.attempts.length, 1, "the failed attempt stays on the record");
});

test("backoff doubles then caps, and Retry-After beats our own number", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    waits.push(ms);
  };

  await deliver(
    async () => {
      throw coded("ECONNREFUSED");
    },
    { attempts: 4, baseDelayMs: 100, maxDelayMs: 250, idempotent: false },
    sleep,
  );
  assert.deepEqual(waits, [100, 200, 250]);

  waits.length = 0;
  await deliver(
    async () => {
      throw httpFailure(429, "slow down", "5");
    },
    { attempts: 2, baseDelayMs: 100, maxDelayMs: 1000, idempotent: false },
    sleep,
  );
  assert.deepEqual(waits, [5000], "the provider's number wins");
});

test("a real no stops immediately even on an idempotent connector", async () => {
  let calls = 0;
  const outcome = await deliver(
    async () => {
      calls += 1;
      throw httpFailure(401, "bad token");
    },
    IDEMPOTENT,
    async () => {},
  );

  assert.equal(calls, 1);
  assert.ok(outcome.gaveUp?.includes("401"));
});

/**
 * REGRESSION — this is the test that fails against the previous runtime.
 *
 * `resources/flow-nodes/_connector/js/client.ts` caught a thrown transport,
 * built a `ConnectorTransient` (`retryable = true`) and retried it with a budget
 * of 2 extra attempts. A timeout is a thrown transport, so a connector with no
 * idempotency key was retried up to three times on a failure that may already
 * have succeeded — a silent double write.
 *
 * Run against that code, `attempts` below is 3.
 */
test("REGRESSION: callConnector makes ONE attempt on a timeout when idempotency is not declared", async () => {
  let attempts = 0;

  const service: ServiceDescriptor = {
    service: "example",
    title: "Example",
    sandbox: "none",
    baseUrls: { live: "https://api.example.test" },
    requires: ["token"],
    authorize: (credentials, request) => {
      request.headers.Authorization = `Bearer ${credentials.token}`;
    },
    faker: () => ({}),
  };

  await assert.rejects(
    callConnector(service, {
      operation: "thing_create",
      credentials: { token: "t" },
      mode: "live",
      request: { method: "POST", path: "/things" },
      transport: async () => {
        attempts += 1;
        throw coded("ETIMEDOUT");
      },
    }),
  );

  assert.equal(attempts, 1, "a timeout on a non-idempotent connector must not be repeated");
});

test("and DOES retry the same timeout once the connector declares idempotency", async () => {
  let attempts = 0;

  const service: ServiceDescriptor = {
    service: "example",
    title: "Example",
    sandbox: "none",
    baseUrls: { live: "https://api.example.test" },
    requires: ["token"],
    authorize: () => {},
    faker: () => ({}),
    idempotencyHeader: "Idempotency-Key",
  };

  const result = await callConnector(service, {
    operation: "thing_create",
    credentials: { token: "t" },
    mode: "live",
    idempotent: true,
    idempotencyKey: "run:step",
    request: { method: "POST", path: "/things" },
    transport: async () => {
      attempts += 1;
      if (attempts === 1) throw coded("ETIMEDOUT");

      return { status: 200, headers: {}, body: '{"id":"1"}' };
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result.data, { id: "1" });
});

test("a 5xx is retried even without idempotency — the provider said it did nothing", async () => {
  let attempts = 0;

  const service: ServiceDescriptor = {
    service: "example",
    title: "Example",
    sandbox: "none",
    baseUrls: { live: "https://api.example.test" },
    requires: [],
    authorize: () => {},
    faker: () => ({}),
  };

  const result = await callConnector(service, {
    operation: "thing_create",
    credentials: { token: "t" },
    mode: "live",
    request: { method: "POST", path: "/things" },
    transport: async () => {
      attempts += 1;
      if (attempts === 1) return { status: 503, headers: {}, body: "maintenance" };

      return { status: 200, headers: {}, body: '{"ok":true}' };
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result.data, { ok: true });
});

test("the rate floor spaces calls and forgets an old one", async () => {
  resetRateState();
  let clock = 1_000_000;
  const sleep = async (ms: number): Promise<void> => {
    clock += ms;
  };

  assert.equal((await respectRate("z", 1000, () => clock, sleep)).waitedMs, 0);
  assert.equal((await respectRate("z", 1000, () => clock, sleep)).waitedMs, 1000);
  clock += 5000;
  assert.equal((await respectRate("z", 1000, () => clock, sleep)).waitedMs, 0);
  resetRateState();
});
