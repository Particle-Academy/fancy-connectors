#!/usr/bin/env node
/**
 * Check every connector's declared contract against what its provider publishes.
 *
 * **Out of band, and it changes nothing.** This is a report. A connector that
 * reshaped itself around a changed API could not be reviewed, and a check that
 * failed a working call because a *document* changed would be a self-inflicted
 * outage. See `src/drift.ts` for the argument.
 *
 * The FETCH lives here rather than in the package, deliberately: `src/drift.ts`
 * takes a document that has already been retrieved, so nothing in the published
 * package contacts a URL, and a host that schedules this chooses its own client,
 * cache and proxy.
 *
 *     npm run drift
 *
 * Exits non-zero on `drifted`. **`unchecked` does not fail the run** — it is
 * reported loudly and separately, because "we could not look" is a different
 * claim from "we looked and something moved", and conflating them is how a
 * report stops being read.
 */

import { EXEMPLAR_CONTRACTS } from "../connectors/index.ts";
import { checkAgainstOpenApi, unchecked, type ApiContract, type DriftReport } from "../src/drift.ts";

async function fetchSpec(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;

    return await response.json();
  } catch {
    return null;
  }
}

async function check(contract: ApiContract): Promise<DriftReport> {
  if (contract.spec.kind !== "openapi") return unchecked(contract);

  const document = await fetchSpec(contract.spec.url);

  return document === null ? unchecked(contract) : checkAgainstOpenApi(contract, document);
}

const reports: DriftReport[] = [];
for (const contract of EXEMPLAR_CONTRACTS) reports.push(await check(contract));

let drifted = 0;

for (const report of reports) {
  const label = report.outcome.toUpperCase().padEnd(9);
  console.log(`${label} ${report.connector}  (${report.method})`);

  for (const finding of report.findings) {
    console.log(`          ${finding.kind}${finding.operation ? ` [${finding.operation}]` : ""} — ${finding.detail}`);
  }

  if (report.outcome === "drifted") drifted += 1;
}

const uncheckedCount = reports.filter((report) => report.outcome === "unchecked").length;

console.log(
  `\n${reports.length} contracts — ${reports.length - drifted - uncheckedCount} clean, ` +
    `${drifted} drifted, ${uncheckedCount} unchecked.`,
);

if (uncheckedCount > 0) {
  console.log(
    "`unchecked` is not a pass. Each one is a provider we cannot see, and the fallback for those is a recorded " +
      "shape compared against a live response — which needs a credential and therefore a person.",
  );
}

process.exit(drifted > 0 ? 1 : 0);
