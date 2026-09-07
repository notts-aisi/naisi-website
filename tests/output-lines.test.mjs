/**
 * The output guard, proved: `tests/lib/outputGuard.mjs`.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## What is worth executing here
 *
 *  1. **The wiring.** The guard only runs because the `test` script in
 *     package.json loads it with `--import`. A script edited to drop the flag
 *     would pass every suite and quietly put the runner stall back, so the
 *     flag is pinned here, on the script the CI job actually runs.
 *  2. **The guard, by execution.** A test file whose only test passes and
 *     prints a 25 KB line is run under the guard in a child process and must
 *     come back failed, naming the line. A source pin ("the file exists")
 *     would prove nothing about whether the runner honours the exit code the
 *     guard sets, which is the one mechanism the whole thing rests on.
 *  3. **The negative control.** A file printing a 19 KB line, and an
 *     ordinary Error with its stack, passes. A guard that failed those would
 *     be a guard people learn to work around.
 *  4. **The measurement.** `longestLineOf` reads the FORMATTED output, so an
 *     Error whose stack carries a long frame is measured as it would print,
 *     not as the length of its message.
 *  5. **The backstop stays.** `.github/workflows/checks.yml` still pipes the
 *     suite through `cut`. The guard makes the cut a formality; the cut makes
 *     a guard that missed something a slow job rather than a stalled one.
 *
 * ## The surface the guard covers, pinned
 *
 * The guard wraps `console` and not the streams (its header says why), which
 * is complete only while nothing under `src` writes to `process.stdout` or
 * `process.stderr` directly. That is true today and is asserted here, so the
 * day it stops being true the guard's coverage question is asked out loud.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_LINE_CHARS, longestLineOf } from "./lib/outputGuard.mjs";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TESTS_DIR, "..");
const GUARD = join(TESTS_DIR, "lib", "outputGuard.mjs");
const FIXTURES = join(TESTS_DIR, "fixtures", "output-lines");

/**
 * `node --test` over one fixture file, with the guard loaded, as npm test would.
 *
 * This test itself runs inside a test-runner child, which carries
 * `NODE_TEST_CONTEXT` in its environment. A nested `node --test` that inherits
 * that variable takes itself for a child too, reports in the runner's internal
 * format and exits 0 whatever happened, so the loud fixture "passed" the first
 * time this was run. The variable is dropped so the nested runner is a real
 * top-level run, which is the thing being proved.
 */
function runUnderGuard(fixture) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--test", "--import", GUARD, join(FIXTURES, fixture)],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1 << 26, env },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function tsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("the output guard is loaded into every test process", () => {
  test("the npm test script carries the --import flag", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    const script = pkg.scripts?.test ?? "";
    assert.match(
      script,
      /^node --test --import \.\/tests\/lib\/outputGuard\.mjs tests\/$/,
      `the test script is ${JSON.stringify(script)}. It has to load the output guard ` +
        "into every test child, or a suite can print the 440 KB lines that stall " +
        "GitHub's runner and nothing fails.",
    );
  });

  test("the CI job keeps the cut as a backstop", () => {
    const workflow = readFileSync(
      join(REPO_ROOT, ".github", "workflows", "checks.yml"),
      "utf8",
    );
    assert.match(
      workflow,
      /npm test 2>&1 \| cut -c 1-\d+/,
      "checks.yml must still pipe npm test through cut: the guard stops the lines " +
        "being produced, and the cut is what keeps a line the guard did not see from " +
        "stalling the job for half an hour",
    );
    assert.match(workflow, /set -o pipefail/, "pipefail keeps the tests' exit status rather than cut's");
  });
});

describe("the guard fails a file that prints a line over the ceiling", () => {
  test("a passing test that prints a 25 KB line fails the file, and says why", () => {
    const { status, output } = runUnderGuard("loud.mjs");
    assert.notEqual(status, 0, "the run passed: the guard did not fail the file");
    assert.match(output, /\[output guard\]/, "the failure must come from the guard");
    assert.match(output, /console\.error: a 25000-character line/);
    assert.match(
      output,
      /t\.mock\.method\(console, "error", \(\) => \{\}\)/,
      "the message must say what the fix is",
    );
    // The test itself passed; the FILE failed on the exit code. Both facts are
    // in the output, and the second is the mechanism this guard depends on.
    assert.match(output, /^ok 1 - passes, and prints a line the runner would stall on/m);
    assert.match(output, /exitCode: 1/);
  });

  test("a 19 KB line and an ordinary Error's stack both pass", () => {
    const { status, output } = runUnderGuard("quiet.mjs");
    assert.equal(status, 0, `the negative control failed:\n${output.slice(0, 2000)}`);
    assert.ok(!output.includes("[output guard]"), "the guard fired on a line under the ceiling");
  });
});

describe("the measurement reads what the terminal would receive", () => {
  test("the ceiling is the one the runner stall was measured against", () => {
    // 20 KB: the stalling lines were 440 KB, an assertion diff on a big
    // object is a few KB, and the cut in CI chops at 4 KB. Anything between
    // is room to move without inviting the stall back.
    assert.equal(MAX_LINE_CHARS, 20_000);
  });

  test("an Error is measured by its longest printed frame, not its message", () => {
    const err = new Error("short");
    err.stack = `Error: short\n    at f (data:text/javascript;base64,${"A".repeat(30_000)}:1:1)`;
    assert.ok(longestLineOf("[x] failed:", err) > MAX_LINE_CHARS);
    assert.ok(longestLineOf("[x] failed:", new Error("short")) < MAX_LINE_CHARS);
  });

  test("format arguments are joined the way console joins them", () => {
    assert.equal(longestLineOf("a", "b"), "a b".length);
    assert.equal(longestLineOf("one\ntwo three"), "two three".length);
    assert.equal(longestLineOf("%s!", "hi"), "hi!".length);
  });

  test("nothing under src writes to a stream directly, so console is the whole surface", () => {
    const offenders = [];
    for (const file of tsFilesUnder(join(REPO_ROOT, "src"))) {
      const code = readFileSync(file, "utf8");
      if (/process\.(stdout|stderr)\.write\(/.test(code)) offenders.push(file);
    }
    assert.deepEqual(
      offenders,
      [],
      "these files write to a stream the output guard does not wrap. Either route " +
        "the write through console, or extend tests/lib/outputGuard.mjs to the " +
        "streams and say in its header how the reporter's frames are told apart.",
    );
  });
});
