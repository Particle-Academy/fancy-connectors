/**
 * Two repositories, two release clocks — and the three things that keep that
 * safe rather than merely convenient.
 *
 * The core and this catalogue ship separately on purpose: a provider changing
 * its API is a connector fix, and it must not wait on a core release. The price
 * is that the two can drift, and the drift is worse here than for an ordinary
 * package pair because **a connector is VENDORED** — a consumer copies a
 * directory into their project, and that copy has no manifest of its own to
 * carry a version range.
 *
 * So three properties, each asserted rather than remembered.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { SUPPORTED_CONNECTOR_API } from "@particle-academy/fancy-connector-core";

import { EXEMPLAR_CATALOGUE } from "../connectors/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const CORE = "@particle-academy/fancy-connector-core";

/**
 * 1. THE RANGE.
 *
 * A first-party sibling gets `>=X <2.0` and **never a caret on a `0.x`**. A
 * caret there locks the MINOR, so it pins the sibling at whatever it was the day
 * the line was written — and every later core release then reads to the resolver
 * as a *conflict* rather than an upgrade. Nothing reports that: a resolver
 * quietly choosing an older version, or installing a second copy of a shared
 * core, looks exactly like success.
 *
 * This is a suite-wide rule that has already been broken across several repos,
 * which is why it is a test here rather than a line in a document.
 */
test("the core is depended on with an open range, never a caret on a 0.x", () => {
  const range = manifest.dependencies?.[CORE];

  assert.ok(range, `${CORE} must be a runtime dependency — a connector's imports resolve to it`);
  assert.match(
    range,
    /^>=\d+\.\d+\.\d+ <2\.0\.0$/,
    `the core range is "${range}". It must read ">=X.Y.Z <2.0.0": a caret on a 0.x locks the minor and turns ` +
      "every later core release into a resolver conflict, and widening is safe by construction because it only " +
      "adds candidates.",
  );
});

test("and it is a runtime dependency, not a dev one", () => {
  // A connector's vendored source imports it at run time. Declaring it only in
  // devDependencies would typecheck here and fail in the consumer's project,
  // which is the worst place to find out.
  assert.equal(manifest.devDependencies?.[CORE], undefined);
});

/**
 * 2. THE FROZEN NUMBER.
 *
 * `connectorApi` must be a LITERAL in every connector, never the imported
 * `CONNECTOR_API_VERSION`. That distinction is the entire mechanism: this source
 * is copied into a consumer's project and frozen there, so if it read the
 * constant, upgrading the core would change what the copy claims to have been
 * written against and the check would agree with itself forever while the
 * surface moved underneath.
 */
test("every connector declares connectorApi as a LITERAL, never the imported constant", () => {
  const offenders: string[] = [];

  for (const id of Object.keys(EXEMPLAR_CATALOGUE.connectors)) {
    const source = readFileSync(path.join(root, "connectors", id, "connector.ts"), "utf8");
    const declaration = source.match(/^\s*connectorApi:\s*(.+?),\s*$/m);

    assert.ok(declaration, `${id} does not declare connectorApi`);
    if (!/^\d+$/.test(declaration[1]!.trim())) {
      offenders.push(`${id} -> connectorApi: ${declaration[1]}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "a vendored copy that reads the core's own constant can never detect that it is out of date",
  );
});

test("and the number every connector declares is one this core still runs", () => {
  for (const [id, connector] of Object.entries(EXEMPLAR_CATALOGUE.connectors)) {
    assert.ok(
      SUPPORTED_CONNECTOR_API.includes(connector.connectorApi),
      `${id} declares connector API ${connector.connectorApi}, which this core does not run (${SUPPORTED_CONNECTOR_API.join(", ")})`,
    );
  }
});

/**
 * 3. NO PATH BACK INTO THE CORE'S SOURCE.
 *
 * The catalogue reaches the core through its published entry point and nothing
 * else. A relative import into a sibling checkout typechecks in this workspace
 * and is a dangling module the moment the directory is vendored — which is
 * exactly the class of breakage that reached a consumer when the flow nodes
 * first shipped.
 */
test("nothing imports the core by path", () => {
  const offenders: string[] = [];

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (full.endsWith(".ts")) out.push(full);
    }

    return out;
  };

  for (const file of [...walk(path.join(root, "connectors")), ...walk(path.join(root, "scripts"))]) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/from "((?:\.\.\/)+(?:src|php)\/[^"]*)"/g)) {
      offenders.push(`${path.relative(root, file)} -> ${match[1]}`);
    }
  }

  assert.deepEqual(offenders, [], `import the core as "${CORE}"; a path reaches a checkout a consumer will not have`);
});
