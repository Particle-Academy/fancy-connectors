#!/usr/bin/env node
/**
 * Point this checkout at the sibling core repo, for local development only.
 *
 * ## Why this exists, and why it is not a `file:` dependency
 *
 * The catalogue depends on `@particle-academy/fancy-connector-core` with the
 * range a consumer will actually resolve: `>=X <2.0`. Running
 * `npm install ../fancy-connector-core` would REWRITE that line to
 * `file:../fancy-connector-core`, and a manifest that lies about its own
 * dependency is worse than an install step somebody has to remember — the lie
 * survives a commit, and the reminder does not.
 *
 * So the range in `package.json` stays honest and this script makes the module
 * resolvable, by linking the sibling checkout into `node_modules`. It is a
 * BOOTSTRAP tool: once the core is published, `npm install` does the job and
 * this becomes the way to test an unreleased core change against the catalogue
 * before shipping it — which is the case that actually recurs.
 *
 *     npm run link-core
 *
 * `npm install` will overwrite the link. Re-run this after one.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const core = path.resolve(root, "..", "fancy-connector-core");
const target = path.join(root, "node_modules", "@particle-academy", "fancy-connector-core");

if (!existsSync(core)) {
  console.error(
    `No sibling core checkout at ${core}.\n` +
      "This script is for a workspace that has both repositories side by side. If you only have this one, " +
      "install the published core instead — `npm install` resolves the range in package.json.",
  );
  process.exit(1);
}

if (!existsSync(path.join(core, "src", "index.ts"))) {
  console.error(`${core} exists but has no src/index.ts — that is not the core repository.`);
  process.exit(1);
}

mkdirSync(path.dirname(target), { recursive: true });
rmSync(target, { recursive: true, force: true });

// `junction` is the type Windows allows without elevation; it is ignored on
// POSIX, where `symlinkSync` makes a directory symlink either way.
symlinkSync(core, target, "junction");

console.log(`linked ${target}\n  -> ${core}`);
console.log("This is a LOCAL bootstrap. `npm install` overwrites it; re-run afterwards.");
