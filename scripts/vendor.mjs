#!/usr/bin/env node
/**
 * Generate the flow-node marketplace's `_connector/` shared directory from this
 * package's source.
 *
 * ## Why this script exists rather than a second copy of the code
 *
 * A flow node is **vendored source, never a package** — adding one must cost a
 * consumer no new dependency, which is the whole point of the marketplace. This
 * package is a package, because a host like a Laravel app or a Node service
 * installs things.
 *
 * Both are correct, and the naive reconciliation — maintain two copies — is the
 * exact failure this suite keeps finding. A fix to the retry ladder applied by
 * hand in two places is a fix applied in one place, and nothing reports the copy
 * that was missed.
 *
 * So: **one source, two distribution channels.** The vendored copy is generated,
 * and a test in the sandbox fails the build when the generated output differs
 * from what is committed. That test is the part that makes the duplication safe;
 * this script on its own would just be a faster way to drift.
 *
 * ## What is NOT copied
 *
 * `_connector/ui/connector.ts` — the authoring surface — stays in the sandbox. It
 * imports `@particle-academy/fancy-flow/engine` to build a node's config schema,
 * which is a fancy-flow concern and has no business in a general connector
 * package. The runtime is shared; the flow-specific authoring layer is not.
 *
 * `php/src/Socialite/` is not copied either: only the top level of `php/src` is
 * read, and the Socialite bridge is Laravel-specific glue for a host that
 * installs the package. A vendored flow node has no Socialite and no Laravel
 * container to reach it through.
 *
 * ## Usage
 *
 *     node scripts/vendor.mjs --target ../px-ui-sandbox/resources/flow-nodes/_connector
 *     node scripts/vendor.mjs --target <path> --check      # exit 1 on any difference
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/** PHP namespace in the package, and what it becomes when vendored. */
const PHP_NAMESPACE = "ParticleAcademy\\Connectors";
const VENDORED_PHP_NAMESPACE = "FancyFlow\\Nodes\\Connector";

/**
 * The banner every generated file carries.
 *
 * Named on purpose: someone will eventually open one of these to fix a bug, and
 * the fix has to land upstream or it is gone at the next build.
 */
const banner = (source) =>
  `// GENERATED from @particle-academy/fancy-connectors — ${source}\n` +
  `// Do not edit here. Fix it in the package and re-run \`php artisan flow:build\`;\n` +
  `// a test fails the build when this copy and the package disagree.\n`;

const phpBanner = (source) =>
  `// GENERATED from particle-academy/fancy-connectors — ${source}\n` +
  `// Do not edit here. Fix it in the package and re-run \`php artisan flow:build\`;\n` +
  `// a test fails the build when this copy and the package disagree.\n`;

function tsFiles(dir) {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".ts"))
    .sort();
}

function phpFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith(".php"))
      .sort();
  } catch {
    return [];
  }
}

/** The full set of generated files, as `relative path → contents`. */
export function vendoredFiles() {
  const files = new Map();

  for (const name of tsFiles(path.join(root, "src"))) {
    const body = readFileSync(path.join(root, "src", name), "utf8");
    files.set(path.posix.join("js", name), `${banner(`src/${name}`)}\n${body}`);
  }

  for (const name of phpFiles(path.join(root, "php", "src"))) {
    const body = readFileSync(path.join(root, "php", "src", name), "utf8")
      .split(PHP_NAMESPACE)
      .join(VENDORED_PHP_NAMESPACE);
    // The banner goes after the opening tag, not before it — a `<?php` that is
    // not the first thing in the file emits whitespace before every response.
    const withBanner = body.replace(
      /^<\?php\s*\n/,
      (match) => `${match}\n${phpBanner(`php/src/${name}`)}`,
    );
    files.set(path.posix.join("php", name), withBanner);
  }

  return files;
}

function main() {
  const args = process.argv.slice(2);
  const targetIndex = args.indexOf("--target");
  const check = args.includes("--check");

  if (targetIndex === -1 || !args[targetIndex + 1]) {
    console.error("usage: node scripts/vendor.mjs --target <path-to-_connector> [--check]");
    process.exit(2);
  }

  const target = path.resolve(args[targetIndex + 1]);
  const files = vendoredFiles();

  if (check) {
    const differences = [];

    for (const [relative, contents] of files) {
      const full = path.join(target, relative);
      let existing;

      try {
        existing = readFileSync(full, "utf8");
      } catch {
        differences.push(`${relative} — missing from the vendored copy`);
        continue;
      }

      if (existing !== contents) differences.push(`${relative} — differs from the package source`);
    }

    if (differences.length > 0) {
      console.error("The vendored _connector is out of date:\n");
      for (const line of differences) console.error(`  ${line}`);
      console.error("\nRe-run: node scripts/vendor.mjs --target <path>");
      process.exit(1);
    }

    console.log(`vendored copy matches the package — ${files.size} files`);

    return;
  }

  // Remove the generated parts only. `ui/`, the README and anything a node
  // author added beside them are not ours to delete.
  //
  // And only the parts we are actually about to write: if the package has no
  // PHP source yet, deleting the target's `php/` would silently remove a working
  // backend and report success. A generator that can empty a directory it cannot
  // refill is a generator that eventually does.
  for (const part of ["js", "php"]) {
    const writing = [...files.keys()].some((relative) => relative.startsWith(`${part}/`));
    if (writing) rmSync(path.join(target, part), { recursive: true, force: true });
  }

  for (const [relative, contents] of files) {
    const full = path.join(target, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }

  console.log(`vendored ${files.size} files into ${target}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("vendor.mjs")) {
  main();
}
