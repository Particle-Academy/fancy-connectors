/**
 * The four promises this package makes to a host that takes gates seriously.
 *
 * Each is asserted rather than documented, because the reference consumer cannot
 * adopt the package if any of them is merely intended:
 *
 * 1. nothing here reads the environment for a credential;
 * 2. nothing here contacts a URL a caller did not name;
 * 3. an ambiguous failure is never retried without a declaration (see
 *    `delivery.test.ts` — the regression lives there);
 * 4. a capability flag cannot outrun the code.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { capabilityProblems, compareShape, reported } from "../src/metrics.ts";
import { probe, runProbes } from "../src/probe.ts";
import { resolveConnection, registerConnectionHost } from "../src/connection.ts";
import { ConnectorConfigError } from "../src/errors.ts";
import type { Connector } from "../src/seam.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/** Every `.ts` under a directory, ignoring build output and dependencies. */
function sources(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];

  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "vendor") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (full.endsWith(".ts")) out.push(full);
  }

  return out;
}

/**
 * Strip comments before scanning, so a docblock may TALK about `process.env` —
 * which it must, to show a host how to supply credentials — while no code
 * reaches for it.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no source in this package reads the environment", () => {
  const offenders: string[] = [];

  for (const file of [...sources(path.join(root, "src")), ...sources(path.join(root, "connectors"))]) {
    const body = code(file);
    if (/process\.env|getenv\s*\(|import\.meta\.env/.test(body)) {
      offenders.push(path.relative(root, file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "credentials are ARGUMENTS. A package that reads the environment bypasses whatever discipline the host " +
      "put around storing them, and no consumer can tell that it happened.",
  );
});

test("no source contacts a URL of its own", () => {
  // A connector names its provider's host; the CORE must name nothing. The drift
  // checker in particular does not fetch — the caller fetches and passes the
  // document in — precisely so a scheduled check cannot become an outbound
  // connection nobody asked for.
  const offenders: string[] = [];

  for (const file of sources(path.join(root, "src"))) {
    const body = code(file);
    for (const match of body.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
      offenders.push(`${path.relative(root, file)} → ${match[0]}`);
    }
  }

  assert.deepEqual(offenders, [], "no telemetry, no phone-home, and no default endpoint");
});

/* ── capability honesty ───────────────────────────────────────────────────── */

const base: Connector<never> = {
  id: "x",
  label: "X",
  provider: "x",
  capabilities: { call: true, metrics: false, feedback: false },
  delivery: { idempotent: false, why: "no idempotency key on this endpoint", minIntervalMs: 0, rateSource: "self-imposed" },
  validate: () => [],
  call: async () => ({ ok: true, ref: "1", dryRun: true, detail: "" }),
};

test("claiming metrics without a shape is a finding", () => {
  const problems = capabilityProblems({ ...base, capabilities: { ...base.capabilities, metrics: true } });

  assert.ok(problems.some((problem) => problem.includes("no metricShape")));
  assert.ok(
    problems.some((problem) => problem.includes("nobody engaged")),
    "the message has to name what the flag turns an unimplemented feature INTO",
  );
});

test("declaring a shape while denying the capability is also a finding", () => {
  const problems = capabilityProblems({
    ...base,
    metricShape: [{ key: "likes", label: "Likes", canonical: "like", means: "someone liked it" }],
  });

  assert.ok(problems.some((problem) => problem.includes("capabilities.metrics is false")));
});

test("idempotent: true with no reason is refused", () => {
  const problems = capabilityProblems({
    ...base,
    delivery: { idempotent: true, why: "", minIntervalMs: 0, rateSource: "self-imposed" },
  });

  assert.ok(problems.some((problem) => problem.includes("public duplicate")));
});

test("a documented rate limit with no citation is a finding", () => {
  const problems = capabilityProblems({
    ...base,
    delivery: { idempotent: false, why: "no key on this endpoint", minIntervalMs: 400, rateSource: "documented" },
  });

  assert.ok(problems.some((problem) => problem.includes("cites nothing")));
});

test("a clean connector has no problems", () => {
  assert.deepEqual(capabilityProblems(base), []);
});

test("the declared shape is compared against what the mapping produces", () => {
  const declared = [
    { key: "likes", label: "Likes", canonical: "like" as const, means: "someone liked it" },
    { key: "quotes", label: "Quotes", canonical: "quote" as const, means: "someone quoted it" },
  ];

  assert.equal(compareShape("x", declared, { likes: 1, quotes: 2 }), null);
  assert.deepEqual(compareShape("x", declared, { likes: 1 }), {
    connector: "x",
    undeclared: [],
    unproduced: ["quotes"],
  });
  assert.deepEqual(compareShape("x", declared, { likes: 1, quotes: 2, boosts: 3 }), {
    connector: "x",
    undeclared: ["boosts"],
    unproduced: [],
  });
});

test("ABSENT STAYS ABSENT — a count the provider did not send is not a zero", () => {
  const metrics = reported({ likes: 0, reposts: undefined, replies: null, quotes: "3" });

  assert.deepEqual(metrics, { likes: 0 }, "0 is a measurement; the others are not measurements at all");
  assert.equal("reposts" in metrics, false);
});

/* ── probes ───────────────────────────────────────────────────────────────── */

const spec = (request: () => Promise<{ status: number; body: string }>) => ({
  connector: "x",
  request,
  authStatuses: [401],
  why: "X answers 401 for a bad token.",
});

test("an auth refusal PASSES — it proves host, path, method and error handling", async () => {
  const result = await probe(spec(async () => ({ status: 401, body: "bad token" })));

  assert.equal(result.outcome, "pass");
});

test("a 2xx with an invalid credential FAILS", async () => {
  const result = await probe(spec(async () => ({ status: 200, body: "{}" })));

  assert.equal(result.outcome, "fail");
  assert.ok(result.detail.includes("ACCEPTED a deliberately invalid credential"));
});

test("an undeclared 404 FAILS, because on most providers it means the endpoint moved", async () => {
  const result = await probe(spec(async () => ({ status: 404, body: "not found" })));

  assert.equal(result.outcome, "fail");
});

test("but a provider that DECLARES 404 as its auth answer passes on one", async () => {
  const result = await probe({
    ...spec(async () => ({ status: 404, body: "unknown webhook" })),
    authStatuses: [401, 404],
    why: "A Discord webhook answers 404 for an unknown id, so a 404 here IS the auth answer.",
  });

  assert.equal(result.outcome, "pass");
});

test("offline is SKIPPED, not failed", async () => {
  const offline = Object.assign(new Error("getaddrinfo ENOTFOUND api.example.test"), { code: "ENOTFOUND" });
  const result = await probe(
    spec(async () => {
      throw offline;
    }),
  );

  assert.equal(result.outcome, "skip", "a check that goes red on a train gets ignored");
});

test("a report is ok when nothing failed, even with skips", async () => {
  const report = await runProbes([
    spec(async () => ({ status: 401, body: "" })),
    spec(async () => {
      throw Object.assign(new Error("offline"), { code: "ENOTFOUND" });
    }),
  ]);

  assert.equal(report.ok, true);
  assert.equal(report.passed, 1);
  assert.equal(report.skipped, 1);
});

/* ── credentials as arguments ─────────────────────────────────────────────── */

test("explicit credentials need no registered host at all", () => {
  const resolved = resolveConnection({
    service: "x",
    operation: "o",
    credentials: { token: "t" },
    sandbox: "none",
    requires: ["token"],
    baseUrls: { live: "https://api.example.test" },
  });

  assert.equal(resolved.mode, "live", "supplying credentials IS the statement that a real call is intended");
  assert.deepEqual(resolved.credentials, { token: "t" });
});

test("an explicit `fake` still wins, and carries nothing secret", () => {
  const resolved = resolveConnection({
    service: "x",
    operation: "o",
    requested: "fake",
    credentials: { token: "t" },
    sandbox: "none",
    requires: ["token"],
  });

  assert.equal(resolved.mode, "fake");
  assert.deepEqual(resolved.credentials, {});
});

test("an INCOMPLETE explicit credential set is loud, never a fall-through", () => {
  const unregister = registerConnectionHost({
    environment: { production: false },
    connections: { x: { service: "x", live: { token: "somebody-elses" } } },
  });

  try {
    assert.throws(
      () =>
        resolveConnection({
          service: "x",
          operation: "o",
          credentials: { token: "" },
          sandbox: "none",
          requires: ["token"],
        }),
      ConnectorConfigError,
      "falling back to a registered connection here is how the wrong account gets written to",
    );
  } finally {
    unregister();
  }
});

test("with no host and no credentials, a REMOTE mode fails rather than faking", () => {
  assert.throws(
    () => resolveConnection({ service: "x", operation: "o", requested: "live", sandbox: "none", requires: ["token"] }),
    ConnectorConfigError,
  );
});

test("with no host and nothing asked for, it resolves to fake so a fresh install runs", () => {
  const resolved = resolveConnection({ service: "x", operation: "o", sandbox: "none", requires: ["token"] });

  assert.equal(resolved.mode, "fake");
});
