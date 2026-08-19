/**
 * Drift detection, and the two answers it must never confuse.
 *
 * `clean` means *we looked and nothing moved*. `unchecked` means *we could not
 * look*. A checker that produces the same word for both is worse than no checker
 * at all, because it is evidence somebody is watching.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkAgainstOpenApi,
  checkAgainstRecordedShape,
  REVIEW_STALE_DAYS,
  shapeOf,
  unchecked,
  type ApiContract,
} from "../src/drift.ts";

const today = new Date().toISOString().slice(0, 10);

const contract: ApiContract = {
  connector: "example",
  spec: { kind: "openapi", url: "https://example.test/openapi.json" },
  reviewedOn: today,
  operations: [
    {
      operation: "thing_create",
      method: "POST",
      path: "/v1/things",
      sends: ["name", "colour"],
      reads: ["id", "created"],
    },
  ],
};

const spec = (overrides: {
  path?: string;
  method?: string;
  sends?: string[];
  reads?: string[];
}): unknown => {
  const properties = (keys: string[]): Record<string, unknown> =>
    Object.fromEntries(keys.map((key) => [key, { type: "string" }]));

  return {
    paths: {
      [overrides.path ?? "/v1/things"]: {
        [overrides.method ?? "post"]: {
          requestBody: {
            content: { "application/json": { schema: { properties: properties(overrides.sends ?? ["name", "colour"]) } } },
          },
          responses: {
            "200": {
              content: {
                "application/json": { schema: { properties: properties(overrides.reads ?? ["id", "created"]) } },
              },
            },
          },
        },
      },
    },
  };
};

test("a matching spec is clean", () => {
  const report = checkAgainstOpenApi(contract, spec({}));

  assert.equal(report.outcome, "clean");
  assert.deepEqual(report.findings, []);
  assert.equal(report.method, "openapi");
});

test("a moved path is a missing operation", () => {
  const report = checkAgainstOpenApi(contract, spec({ path: "/v2/things" }));

  assert.equal(report.outcome, "drifted");
  assert.equal(report.findings[0]?.kind, "missing-operation");
  assert.ok(report.findings[0]?.detail.includes("/v1/things"));
});

test("a method that is no longer accepted is reported separately", () => {
  const report = checkAgainstOpenApi(contract, spec({ method: "get" }));

  assert.equal(report.findings[0]?.kind, "missing-operation");
  assert.ok(report.findings[0]?.detail.includes("no longer accepts POST"));
});

test("a removed RESPONSE field is called out as the silent one", () => {
  const report = checkAgainstOpenApi(contract, spec({ reads: ["id"] }));

  assert.equal(report.outcome, "drifted");
  assert.equal(report.findings[0]?.kind, "missing-response-field");
  assert.ok(report.findings[0]?.detail.includes("silent"));
});

test("a removed REQUEST field is reported", () => {
  const report = checkAgainstOpenApi(contract, spec({ sends: ["name"] }));

  assert.equal(report.findings[0]?.kind, "missing-request-field");
  assert.ok(report.findings[0]?.detail.includes("colour"));
});

test("additive change is NOT drift — a provider adding fields is healthy", () => {
  const report = checkAgainstOpenApi(contract, spec({ reads: ["id", "created", "brand_new"] }));

  assert.equal(report.outcome, "clean", "reporting every additive release buries the line that matters");
});

test("a $ref is followed inside the document", () => {
  const document = {
    paths: {
      "/v1/things": {
        post: {
          requestBody: { $ref: "#/components/requestBodies/Thing" },
          responses: { "200": { $ref: "#/components/responses/Thing" } },
        },
      },
    },
    components: {
      requestBodies: {
        Thing: { content: { "application/json": { schema: { $ref: "#/components/schemas/ThingIn" } } } },
      },
      responses: {
        Thing: { content: { "application/json": { schema: { $ref: "#/components/schemas/ThingOut" } } } },
      },
      schemas: {
        ThingIn: { properties: { name: {}, colour: {} } },
        ThingOut: { properties: { id: {}, created: {} } },
      },
    },
  };

  assert.equal(checkAgainstOpenApi(contract, document).outcome, "clean");
});

test("an unreadable document is UNCHECKED, never clean", () => {
  const report = checkAgainstOpenApi(contract, { nonsense: true });

  assert.equal(report.outcome, "unchecked");
  assert.equal(report.findings[0]?.kind, "unreadable-spec");
  assert.notEqual(report.outcome, "clean", "a checker that cannot see is not a checker that saw nothing wrong");
});

test("a provider that publishes nothing is unchecked WITH the reason", () => {
  const report = unchecked({
    ...contract,
    spec: { kind: "none", note: "Telegram publishes no machine-readable description; the fallback is a recorded shape." },
  });

  assert.equal(report.outcome, "unchecked");
  assert.ok(report.findings[0]?.detail.includes("Telegram"));
});

test("a contract nobody has reviewed in a long time says so, without calling it drift", () => {
  const old = new Date(Date.now() - (REVIEW_STALE_DAYS + 30) * 86_400_000).toISOString().slice(0, 10);
  const report = checkAgainstOpenApi({ ...contract, reviewedOn: old }, spec({}));

  assert.equal(report.outcome, "clean", "an absence of looking is not evidence of change");
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.kind, "stale-review");
});

/* ── the no-spec fallback ─────────────────────────────────────────────────── */

test("shapeOf flattens to dotted names and collapses arrays", () => {
  assert.deepEqual(shapeOf({ id: 1, nested: { a: "x" } }), ["id", "nested.a"]);
  assert.deepEqual(
    shapeOf({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
    ["items[].id"],
    "a fixture must not depend on how much data the account had",
  );
  assert.deepEqual(shapeOf({ items: [] }), ["items[]"]);
});

test("a live response missing a field we READ is drift", () => {
  const report = checkAgainstRecordedShape(contract, "thing_create", { id: "1" });

  assert.equal(report.outcome, "drifted");
  assert.equal(report.method, "recorded-shape");
  assert.ok(report.findings[0]?.detail.includes("created"));
});

test("a live response with extra fields is clean", () => {
  const report = checkAgainstRecordedShape(contract, "thing_create", {
    id: "1",
    created: "now",
    surprise: true,
  });

  assert.equal(report.outcome, "clean");
});

test("a field we read through an array still matches", () => {
  const arrayContract: ApiContract = {
    ...contract,
    operations: [{ operation: "list", method: "GET", path: "/v1/things", reads: ["items.id"] }],
  };

  assert.equal(checkAgainstRecordedShape(arrayContract, "list", { items: [{ id: 1 }] }).outcome, "clean");
});
