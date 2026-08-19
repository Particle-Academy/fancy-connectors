#!/usr/bin/env node
/**
 * Dry-verify every connector against its real provider, with a credential that
 * cannot work.
 *
 * **Nothing is sent.** Every probe is a read, and every credential is a string
 * that cannot be valid. An auth-shaped refusal is the proof: the host resolved,
 * the path exists, the method was accepted, and a failure was recognised as a
 * failure — none of which a fake server can prove, because a fake server agrees
 * with whatever the code does.
 *
 *     npm run probe
 *
 * Not part of `npm test`: this needs a network, and a suite that needs a network
 * is a suite that is flaky in CI and skipped on a laptop. Offline is reported as
 * SKIPPED here rather than failed, for the same reason — a check that goes red
 * on a train gets ignored, and is then worth nothing when it goes red for real.
 */

import { EXEMPLAR_PROBES } from "../connectors/index.ts";
import { runProbes } from "../src/probe.ts";

const report = await runProbes(EXEMPLAR_PROBES);

for (const result of report.results) {
  console.log(`${result.outcome.toUpperCase().padEnd(5)} ${result.connector} — ${result.detail}`);
}

console.log(`\n${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped.`);

if (report.skipped > 0 && report.passed === 0) {
  console.log("Every probe was skipped, which usually means there is no network. That is not a pass.");
}

process.exit(report.ok ? 0 : 1);
