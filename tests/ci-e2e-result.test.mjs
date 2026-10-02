/**
 * "End-to-end result": what the required check answers, line by line.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * The branch rules require this check by name, so its answer is what decides
 * whether a pull request may merge. The danger it exists for is a SKIP READ AS
 * A PASS: GitHub counts a job skipped by its own `if:` as successful, and the
 * end-to-end job skips for three unrelated reasons. Each row of the table in
 * `scripts/ci/e2e-result.mjs` is held here, and so is the workflow that feeds
 * it, because a decision that is right and never consulted protects nothing.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { decide, MUST_RUN_BASES } from "../scripts/ci/e2e-result.mjs";
import { BRANCH_RULES } from "../scripts/check-branch-rules.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "notts-aisi/naisi-website";

/** A pull request from a branch of this repository, by a person, identity configured. */
const run = (overrides = {}) => ({
  localResult: "success",
  baseRef: "dev",
  actor: "a-maintainer",
  headRepo: REPO,
  repo: REPO,
  identityConfigured: true,
  ...overrides,
});

describe("what the required check answers", () => {
  test("the suite ran and passed: pass", () => {
    for (const baseRef of ["dev", "main", "some-staging-branch"]) {
      assert.equal(decide(run({ baseRef })).ok, true, baseRef);
    }
  });

  test("the suite failed or was cancelled: fail, on every branch", () => {
    for (const localResult of ["failure", "cancelled"]) {
      for (const baseRef of ["dev", "main"]) {
        assert.equal(decide(run({ localResult, baseRef })).ok, false, `${localResult} into ${baseRef}`);
      }
    }
  });

  test("a result nobody has seen before is a fail, never a pass", () => {
    for (const localResult of ["", "neutral", "timed_out", "SUCCESS", undefined]) {
      assert.equal(decide(run({ localResult })).ok, false, String(localResult));
    }
  });

  test("skipped because there is no test identity: fail, whoever opened it", () => {
    for (const baseRef of ["dev", "main"]) {
      for (const actor of ["a-maintainer", "dependabot[bot]"]) {
        const verdict = decide(run({ localResult: "skipped", identityConfigured: false, baseRef, actor }));
        assert.equal(verdict.ok, false, `${actor} into ${baseRef}`);
        assert.match(verdict.message, /no test identity/);
      }
    }
  });

  test("skipped for Dependabot, into dev: pass, and the message says the suite did not run", () => {
    const verdict = decide(run({ localResult: "skipped", actor: "dependabot[bot]", baseRef: "dev" }));
    assert.equal(verdict.ok, true);
    assert.match(verdict.message, /did not run/);
  });

  test("skipped for Dependabot, into a branch that deploys to production: held", () => {
    for (const baseRef of MUST_RUN_BASES) {
      const verdict = decide(run({ localResult: "skipped", actor: "dependabot[bot]", baseRef }));
      assert.equal(verdict.ok, false, baseRef);
      assert.match(verdict.message, /has not run/);
      assert.match(verdict.message, /git commit --allow-empty/, "a hold has to say how it is lifted");
    }
  });

  test("a fork is treated as Dependabot is", () => {
    const fork = { localResult: "skipped", headRepo: "a-stranger/naisi-website" };
    assert.equal(decide(run({ ...fork, baseRef: "dev" })).ok, true);
    assert.equal(decide(run({ ...fork, baseRef: "main" })).ok, false);
  });

  test("skipped with no reason this check knows: fail", () => {
    // A person's own branch, identity configured, and the job still skipped:
    // somebody has changed the job's condition, and this must not pass quietly.
    const verdict = decide(run({ localResult: "skipped" }));
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /not for a reason this check recognises/);
  });

  test("the production branch is one of the branches that must run the suite", () => {
    assert.ok(MUST_RUN_BASES.includes("main"));
    // dev is not: the nightly and the promotion pull request cover it, and the
    // message a Dependabot pull request gets there says so.
    assert.ok(!MUST_RUN_BASES.includes("dev"));
  });
});

describe("the script, run the way the workflow runs it", () => {
  const cli = (env) =>
    spawnSync(process.execPath, [join(REPO_ROOT, "scripts/ci/e2e-result.mjs")], {
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
    });

  test("a pass exits 0 with a notice, a fail exits 1 with an error", () => {
    const base = { BASE_REF: "dev", ACTOR: "a-maintainer", HEAD_REPO: REPO, REPO, IDENTITY_CONFIGURED: "true" };
    const pass = cli({ ...base, LOCAL_RESULT: "success" });
    assert.equal(pass.status, 0);
    assert.match(pass.stdout, /^::notice title=End-to-end result::/);
    const fail = cli({ ...base, LOCAL_RESULT: "failure" });
    assert.equal(fail.status, 1);
    assert.match(fail.stdout, /^::error title=End-to-end result::/);
  });

  test("with nothing in the environment it fails", () => {
    // A renamed variable in the workflow must not turn into a pass.
    assert.equal(cli({}).status, 1);
  });
});

describe("the workflow consults it", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/e2e.yml"), "utf8");

  /** One job's block out of the workflow, with its comment lines taken out. */
  function job(id) {
    const start = workflow.indexOf(`\n  ${id}:\n`);
    assert.ok(start >= 0, `e2e.yml has no "${id}" job`);
    const rest = workflow.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
    const block = next < 0 ? rest : rest.slice(0, next + 1);
    // What a job DOES is in its keys. A comment explaining that it holds no
    // id-token must not read as holding one.
    return block.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n") + "\n";
  }

  test("the check has the name the branch rules require", () => {
    const required = Object.entries(BRANCH_RULES).filter(([, rules]) => "End-to-end result" in rules.requiredChecks);
    assert.ok(required.length > 0, "no branch requires the end-to-end result any more: this guard has nothing to hold");
    assert.match(job("result"), /\n {4}name: End-to-end result\n/);
  });

  test("it runs whatever became of the suite, and only on a pull request", () => {
    const block = job("result");
    assert.match(block, /\n {4}needs: \[local\]\n/);
    assert.match(block, /\n {4}if: always\(\) && github\.event_name == 'pull_request'\n/);
  });

  test("every fact the decision needs is passed in", () => {
    const block = job("result");
    for (const [name, value] of Object.entries({
      LOCAL_RESULT: "${{ needs.local.result }}",
      BASE_REF: "${{ github.base_ref }}",
      ACTOR: "${{ github.actor }}",
      HEAD_REPO: "${{ github.event.pull_request.head.repo.full_name }}",
      REPO: "${{ github.repository }}",
      IDENTITY_CONFIGURED: "${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER != '' }}",
    })) {
      assert.ok(block.includes(`          ${name}: ${value}\n`), `the result job does not pass ${name} as ${value}`);
    }
    assert.match(block, /run: node scripts\/ci\/e2e-result\.mjs/);
  });

  test("the suite skips for exactly the reasons the decision knows how to read", () => {
    const condition = job("local").match(/\n {4}if: >-\n((?: {6}.*\n)+)/);
    assert.ok(condition, "the local job's condition could not be read");
    const clauses = condition[1].split("\n").map((l) => l.trim().replace(/^&& /, "")).filter(Boolean);
    assert.deepEqual(clauses, [
      "github.event_name == 'pull_request'",
      "vars.GCP_WORKLOAD_IDENTITY_PROVIDER != ''",
      "github.event.pull_request.head.repo.full_name == github.repository",
      "github.actor != 'dependabot[bot]'",
    ]);
  });

  test("neither of the two jobs that drive nothing is given the cloud identity", () => {
    for (const id of ["result", "nightly-alert"]) {
      const block = job(id);
      assert.match(block, /\n {4}permissions:\n/, `${id} inherits the workflow's permissions, id-token included`);
      assert.doesNotMatch(block, /id-token/, `${id} asks for an id-token`);
      assert.doesNotMatch(block, /google-github-actions\/auth/, `${id} authenticates to Google Cloud`);
    }
  });

  test("the two jobs that drive the dev project wait in one queue, and are never cancelled", () => {
    for (const id of ["local", "dev"]) {
      const block = job(id);
      assert.match(
        block,
        /\n {4}concurrency:\n {6}group: e2e-\$\{\{ github\.workflow \}\}\n {6}cancel-in-progress: false\n {6}queue: max\n/,
        `${id} is not in the shared queue`,
      );
    }
    assert.doesNotMatch(workflow, /\nconcurrency:/, "a workflow-level group would queue the runs whose suite is skipped");
    for (const id of ["result", "nightly-alert"]) {
      assert.doesNotMatch(job(id), /\n {4}concurrency:/, `${id} must answer at once, not wait in the queue`);
    }
  });

  test("the nightly is reported whatever became of it, and only on the schedule", () => {
    const block = job("nightly-alert");
    assert.match(block, /\n {4}needs: \[dev\]\n/);
    assert.match(block, /\n {4}if: always\(\) && github\.event_name == 'schedule'\n/);
    assert.ok(block.includes("          ALERT_RESULT: ${{ needs.dev.result }}\n"));
    assert.match(block, /\n {6}issues: write\n/);
    assert.match(block, /run: node scripts\/ci\/alert-issue\.mjs/);
  });
});
