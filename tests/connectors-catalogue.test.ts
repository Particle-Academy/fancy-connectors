/**
 * The properties every connector in the catalogue owes, checked over all four at
 * once rather than four times by hand.
 *
 * The value of a table-driven suite here is the case nobody writes: a fifth
 * connector added next month inherits every assertion below without anyone
 * remembering to.
 *
 * No network, no credentials, and the transport is a bomb — anything that
 * touches it fails the test rather than silently doing something.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { registerTransport } from "../src/client.ts";
import { resetRateState } from "../src/delivery.ts";
import { capabilityProblems } from "../src/metrics.ts";
import type { Connector } from "../src/seam.ts";
import { EXEMPLAR_CATALOGUE, EXEMPLAR_CONTRACTS, EXEMPLAR_PROBES, type PostTarget } from "../connectors/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const CONNECTORS = Object.entries(EXEMPLAR_CATALOGUE.connectors);
const PROVIDERS = Object.entries(EXEMPLAR_CATALOGUE.providers);

/** A transport that fails the test if anything reaches it. */
function forbidNetwork(): () => void {
  resetRateState();
  registerTransport(async (request) => {
    throw new Error(`a dry run reached the network: ${request.method} ${request.url}`);
  });

  return () => registerTransport(null);
}

/* ── capability flags cannot outrun the code ──────────────────────────────── */

test("capabilityProblems() is empty for every connector in the catalogue", () => {
  const problems = CONNECTORS.flatMap(([id, connector]) =>
    capabilityProblems(connector as unknown as Connector<never>).map((problem) => `${id}: ${problem}`),
  );

  assert.deepEqual(problems, []);
});

test("a connector that reports nothing declares NO shape, rather than an empty one", () => {
  for (const [id, connector] of CONNECTORS) {
    if (connector.capabilities.metrics) {
      assert.ok((connector.metricShape?.length ?? 0) > 0, `${id} claims metrics and must declare a shape`);
      assert.ok(connector.fetchMetrics, `${id} claims metrics and must implement fetchMetrics`);
      continue;
    }

    assert.equal(
      "metricShape" in connector,
      false,
      `${id} reports nothing, so the key must be ABSENT — an empty array says "nothing yet" where the truth ` +
        'is "never"',
    );
    assert.equal(connector.fetchMetrics, undefined, `${id} must not implement a fetch it cannot honour`);
  }
});

test("every declared metric says what it MEANS and names its canonical act", () => {
  const canonical = new Set(["like", "share", "reply", "quote", "view", null]);

  for (const [id, connector] of CONNECTORS) {
    for (const metric of connector.metricShape ?? []) {
      assert.ok(metric.means.trim().length >= 10, `${id}.${metric.key} does not say what it means`);
      assert.ok(metric.label.trim() !== "", `${id}.${metric.key} has no label`);
      assert.ok(canonical.has(metric.canonical), `${id}.${metric.key} has an invented canonical name`);
    }
  }
});

/* ── delivery is declared AND cited ───────────────────────────────────────── */

test("every delivery declaration names a mechanism and cites a source it was read from", () => {
  for (const [id, connector] of CONNECTORS) {
    const { delivery } = connector;

    assert.ok(delivery.why.trim().length > 40, `${id} restates the flag instead of naming the mechanism`);
    assert.ok(delivery.minIntervalMs > 0, `${id} declares no rate floor`);
    assert.ok(["documented", "self-imposed"].includes(delivery.rateSource), `${id} has no rateSource`);

    // Every one of these is cited, including the self-imposed floors: the
    // citation is what shows a reader where OUR number came from, which is the
    // difference between an honest floor and a number nobody can source.
    assert.ok(delivery.citation, `${id} declares a rate floor with nothing behind it`);
    assert.match(delivery.citation!.url, /^https:\/\//, `${id}'s citation is not a URL`);
    assert.match(
      delivery.citation!.readOn,
      /^\d{4}-\d{2}-\d{2}$/,
      `${id}'s citation has no date, which makes it an assertion wearing a URL`,
    );
  }
});

/* ── the host decides liveness, and a dry run is a REAL rehearsal ─────────── */

const SHORT: PostTarget = { text: "A short, entirely ordinary message." };

test("dryRun: true produces a ref shaped like a live one AND sends nothing", async () => {
  const restore = forbidNetwork();

  try {
    for (const [id, connector] of CONNECTORS) {
      const result = await connector.call(SHORT, { dryRun: true, credentials: {} });

      assert.equal(result.ok, true, `${id} refused a perfectly ordinary message`);
      assert.equal(result.dryRun, true, `${id} must report that nothing left the building`);
      assert.equal(result.mode, "fake", `${id} must report which estate it ran against`);
      assert.ok(result.ref, `${id} produced no ref, so a host cannot exercise its joins`);
      assert.match(result.detail, /Nothing left the building/, `${id} must say so in words too`);
    }
  } finally {
    restore();
  }
});

test("a dry-run ref is shaped like the provider's own, and visibly fake", async () => {
  const restore = forbidNetwork();

  try {
    const refs = new Map<string, string>();
    for (const [id, connector] of CONNECTORS) {
      const result = await connector.call(SHORT, { dryRun: true, credentials: {} });
      refs.set(id, result.ref!);
    }

    assert.match(refs.get("bluesky")!, /^at:\/\/did:plc:fake\w*\/app\.bsky\.feed\.post\/fake\w+$/);
    assert.match(refs.get("mastodon")!, /^https:\/\/mastodon\.example\.test\/@fake\/fake\w+$/);
    // Snowflakes and message ids are digits, so a fake one cannot say "fake" —
    // it says it with a shape the provider never mints.
    assert.match(refs.get("discord")!, /^000000000000\d{6}$/);
    assert.match(refs.get("telegram")!, /^https:\/\/t\.me\/fake_example_channel\/9\d{8}$/);
  } finally {
    restore();
  }
});

test("a dry run is DETERMINISTIC — same input, same ref", async () => {
  const restore = forbidNetwork();

  try {
    for (const [id, connector] of CONNECTORS) {
      const first = await connector.call(SHORT, { dryRun: true, credentials: {} });
      const second = await connector.call(SHORT, { dryRun: true, credentials: {} });

      assert.equal(first.ref, second.ref, `${id}'s faker is not deterministic, so no fixture can assert on it`);
    }
  } finally {
    restore();
  }
});

test("a dry run still REFUSES what a live send would refuse", async () => {
  const restore = forbidNetwork();

  try {
    for (const [id, connector] of CONNECTORS) {
      const empty = await connector.call({ text: "   " }, { dryRun: true, credentials: {} });

      assert.equal(empty.ok, false, `${id} rehearsed a send of nothing`);
      assert.equal(empty.ref, null);
      assert.match(
        empty.detail,
        /Refused before anything was sent/,
        `${id} must refuse for the same reasons live would, or the rehearsal proves nothing`,
      );
    }
  } finally {
    restore();
  }
});

/* ── the shape of the seam ────────────────────────────────────────────────── */

test("every connector points at a provider that exists, and every provider is standing", () => {
  for (const [id, connector] of CONNECTORS) {
    assert.equal(connector.id, id, "the key and the id must agree or a lookup finds the wrong one");
    assert.ok(EXEMPLAR_CATALOGUE.providers[connector.provider], `${id} names a provider that is not here`);
  }

  for (const [id, provider] of PROVIDERS) {
    assert.equal(provider.id, id);
    assert.ok(provider.implemented, `${id} is listed as implemented: false and should say what it would take`);
    assert.ok(provider.verify, "a provider with no read-only verify cannot be stood up with any confidence");
    assert.ok(provider.setup.length > 0, `${id} has no setup steps`);
    assert.equal(provider.sandbox, "none", "none of these four operates a test estate, and each says so");

    for (const step of provider.setup) {
      assert.ok(step.detail.trim().length > 40, `${id}: "${step.title}" names no trap`);
    }
    for (const field of provider.fields) {
      assert.ok(field.help.trim().length > 20, `${id}.${field.key} does not say what it is`);
      assert.ok(["provider", "account"].includes(field.scope), `${id}.${field.key} has no scope`);
      assert.equal(field.placeholder?.includes("@particle") ?? false, false);
    }
  }
});

test("no length rule lives outside the renderer", () => {
  for (const [id, connector] of CONNECTORS) {
    assert.ok(connector.renderRules, `${id} declares no render rules, so its limit is hiding in code`);

    // Long copy is the renderer's problem. validate() must not have an opinion.
    const long = "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu. ".repeat(200);
    assert.deepEqual(
      connector.validate({ text: long }),
      [],
      `${id}'s validate judges length, and will eventually disagree with the renderer`,
    );
  }
});

/* ── contracts and probes are honest ──────────────────────────────────────── */

test("every contract was reviewed on a real date and declares the calls it makes", () => {
  assert.equal(EXEMPLAR_CONTRACTS.length, CONNECTORS.length);

  for (const contract of EXEMPLAR_CONTRACTS) {
    assert.ok(EXEMPLAR_CATALOGUE.connectors[contract.connector], `${contract.connector} has no connector`);
    assert.match(contract.reviewedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isFinite(Date.parse(contract.reviewedOn)));
    assert.ok(contract.operations.length > 0, `${contract.connector} declares no operations`);

    for (const operation of contract.operations) {
      assert.match(operation.path, /^\//, `${contract.connector}.${operation.operation} has no path template`);
      assert.ok(
        (operation.reads?.length ?? 0) > 0 || (operation.sends?.length ?? 0) > 0,
        `${contract.connector}.${operation.operation} declares no fields, so drift in it would be invisible`,
      );
    }
  }
});

test('a spec of "none" always says WHY — otherwise it is indistinguishable from nobody looking', () => {
  for (const contract of EXEMPLAR_CONTRACTS) {
    if (contract.spec.kind !== "none") {
      assert.match(contract.spec.url, /^https:\/\//);
      continue;
    }

    assert.ok(
      contract.spec.note.trim().length > 80,
      `${contract.connector} declares no spec and does not say why or what the fallback is`,
    );
  }
});

test("every probe declares which statuses are auth-shaped FOR THAT PROVIDER, and why", () => {
  assert.equal(EXEMPLAR_PROBES.length, CONNECTORS.length);

  for (const probe of EXEMPLAR_PROBES) {
    assert.ok(EXEMPLAR_CATALOGUE.connectors[probe.connector], `${probe.connector} has no connector`);
    assert.ok(probe.authStatuses.length > 0, `${probe.connector} accepts nothing, so it can never pass`);
    assert.ok(
      probe.why.trim().length > 60,
      `${probe.connector} does not say why those statuses, for whoever reads a failure at 3am`,
    );

    // 404 is auth-shaped on Discord and drift everywhere else. Anyone declaring
    // it has to have said so.
    if (probe.authStatuses.includes(404)) {
      assert.match(probe.why, /404/, `${probe.connector} accepts a 404 without explaining it`);
    }
  }

  // …and it is declared, not assumed: exactly one of these four does it.
  const accepting404 = EXEMPLAR_PROBES.filter((probe) => probe.authStatuses.includes(404));
  assert.deepEqual(accepting404.map((probe) => probe.connector), ["discord"]);
});

/* ── credentials are ARGUMENTS ────────────────────────────────────────────── */

/**
 * Scan the source for anything that reaches into the environment.
 *
 * Line-based and CONSERVATIVE: a line containing `process.env` passes only if
 * the whole line is inside a comment. A code line that happens to end in a
 * comment still fails, which is the direction to be wrong in — a scanner that
 * tried to be clever about strings and regex literals could strip too much and
 * hide the very thing it is looking for.
 *
 * This deliberately overlaps `core-discipline.test.ts`. Each connector directory
 * is vendored out of this repo on its own, and the guarantee has to be asserted
 * where the connectors are, not only where the core is.
 */
function environmentReadLines(source: string): number[] {
  const offenders: number[] = [];
  let inBlock = false;

  source.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    const wasInBlock = inBlock;

    if (inBlock && trimmed.includes("*/")) inBlock = false;
    else if (!inBlock && trimmed.includes("/*") && !trimmed.includes("*/")) inBlock = true;

    const isComment = wasInBlock || trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
    if (isComment) return;

    if (/process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env|\bgetenv\s*\(/.test(line)) {
      offenders.push(index + 1);
    }
  });

  return offenders;
}

function environmentReads(file: string): string[] {
  return environmentReadLines(readFileSync(file, "utf8")).map(
    (line) => `${path.relative(root, file)}:${line}`,
  );
}

function typescriptUnder(dir: string): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "vendor") continue;
    const full = path.join(dir, entry);

    if (statSync(full).isDirectory()) out.push(...typescriptUnder(full));
    else if (full.endsWith(".ts")) out.push(full);
  }

  return out;
}

test("NOTHING under connectors/ or src/ reads the environment", () => {
  const files = [...typescriptUnder(path.join(root, "connectors")), ...typescriptUnder(path.join(root, "src"))];

  assert.ok(files.length >= 20, "the scan found almost no files, which usually means it scanned the wrong place");

  assert.deepEqual(
    files.flatMap(environmentReads),
    [],
    "credentials are ARGUMENTS. A connector that read the environment would bypass whatever discipline the " +
      "host put around storing them, and no consumer could tell that it happened.",
  );
});

test("the scan is not vacuous — it catches an offender and forgives a docblock", () => {
  // A green scan proves nothing unless the scanner can go red. Both halves
  // matter: a scanner that flagged the docblock would be turned off within a
  // week, and one that missed the code line was never doing anything.
  const source = [
    "/**",
    " * A host supplies credentials from process.env — which a DOCBLOCK must be",
    " * able to say, because that is how a consumer learns to do it.",
    " */",
    "// const token = process.env.TOKEN;   // a commented-out offender is still a comment",
    "const fine = credentials.token;",
    "const bad = process.env.TOKEN;",
    "const alsoBad = import.meta.env.VITE_TOKEN;",
    "const sneaky = getenv('TOKEN');",
  ].join("\n");

  assert.deepEqual(
    environmentReadLines(source),
    [7, 8, 9],
    "the three code lines are offenders; the docblock and the commented-out line are not",
  );

  // And the real file it is pointed at genuinely exercises the comment path.
  assert.match(readFileSync(path.join(root, "connectors", "index.ts"), "utf8"), /process\.env/);
});
