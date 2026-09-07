#!/usr/bin/env node
/**
 * Runs every tests/*.test.js.
 *
 * WHY THIS REPLACED A HARDCODED CHAIN
 * `npm test` used to be a 2222-character `&&` chain naming 49 files by hand
 * while 52 existed. The three it had drifted past were tests/cc-dispatcher,
 * tests/cc-results and tests/shell-exec-spawn-limits: 116 passing assertions
 * covering the Claude Code dispatcher, the CC results write-back, and
 * shell-exec spawn limits, the last of which is a security control. They were
 * not excluded for being broken. Adding a test file required a second,
 * unprompted edit in a different file, and nothing complained when it was
 * missed, so the chain drifted silently every time coverage was added.
 *
 * Two properties the chain lacked, both taken from the python-test job in
 * ci.yml, which already fixed exactly these problems for the Python suite:
 *
 *   1. An explicit zero-match failure. A glob that matches nothing must be
 *      loud, or "all tests passed" becomes "no tests ran".
 *   2. Per-file accumulation instead of `&&` fail-fast, so one red file no
 *      longer hides the state of every file after it.
 *
 * Files are run sequentially and in sorted order, matching how the chain ran
 * them, because some tests touch shared on-disk state.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(repoRoot, "tests");

const files = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

if (files.length === 0) {
  console.error(
    `No tests/*.test.js found under ${testDir}. ` +
      `Refusing to report success on a run that executed nothing.`,
  );
  process.exit(1);
}

const failed = [];
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(testDir, file)], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  if (result.status !== 0) {
    failed.push(
      `${file} (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`})`,
    );
  }
}

console.log(`\n${files.length - failed.length}/${files.length} test files passed`);

if (failed.length > 0) {
  console.error(`\n${failed.length} test file(s) failed:`);
  for (const f of failed) console.error(`  ${f}`);
  process.exit(1);
}
