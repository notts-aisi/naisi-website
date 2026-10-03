#!/usr/bin/env node
/**
 * "End-to-end result": the one check the branch rules require from the
 * end-to-end workflow, and the reasoning behind its answer.
 *
 * WHY A SEPARATE CHECK. A branch rule requires a check by NAME, and GitHub
 * counts a job that was skipped by its own `if:` as a success. The suite's job
 * skips in three situations, and they are not the same situation:
 *
 *  - the run was started by Dependabot, or comes from a fork, so it is given
 *    none of the repository's secrets and the suite could not sign in;
 *  - the repository has no test identity configured at all;
 *  - something else nobody has thought of yet.
 *
 * Requiring the suite's own job would let all three through as "passed". This
 * check reads WHY the job has the result it has and answers for it:
 *
 *   ran and passed                          pass
 *   failed, or was cancelled                fail
 *   skipped: no test identity               fail. A suite that cannot run has
 *                                           not passed, and a quiet skip is how
 *                                           a broken setup goes unnoticed.
 *   skipped: Dependabot or a fork
 *     into a branch that deploys to
 *     production (MUST_RUN_BASES)           fail, as a HOLD: a maintainer runs
 *                                           the suite by pushing a commit to
 *                                           the branch, which makes the next
 *                                           run theirs.
 *     into any other branch                 pass, with a notice. The nightly
 *                                           run against the deployed dev site
 *                                           and the promotion pull request
 *                                           both run the suite before the
 *                                           change can reach production.
 *   skipped for any other reason            fail
 *
 * WHY A HOLD RATHER THAN SECRETS FOR DEPENDABOT. GitHub withholds secrets from
 * a Dependabot run because the code under test is a dependency nobody has read
 * yet. Handing that run the suite's credentials would undo the point. A
 * maintainer's push is the act that says somebody has looked.
 *
 * The decision is a pure function so `tests/ci-e2e-result.test.mjs` can hold
 * the table above line by line.
 */

import { pathToFileURL } from "node:url";

/** Branches where a change deploys to production the moment it merges. */
export const MUST_RUN_BASES = ["main"];

const DEPENDABOT = "dependabot[bot]";

const RUN_IT =
  "To run it, a maintainer pushes a commit to this branch (an empty one is enough): " +
  '`git commit --allow-empty -m "ci: run the end-to-end suite" && git push`. ' +
  "That makes the next run theirs, with the access the suite needs.";

/**
 * @param {{ localResult: string, baseRef: string, actor: string, headRepo: string,
 *           repo: string, identityConfigured: boolean }} run
 * @returns {{ ok: boolean, message: string }}
 */
export function decide(run) {
  const { localResult, baseRef, actor, headRepo, repo, identityConfigured } = run;

  if (localResult === "success") {
    return { ok: true, message: "The end-to-end suite ran against this pull request and passed." };
  }
  if (localResult === "failure") {
    return {
      ok: false,
      message: "The end-to-end suite failed. The step that failed is in the 'Local mode' job of this run.",
    };
  }
  if (localResult === "cancelled") {
    return {
      ok: false,
      message:
        "The end-to-end run was cancelled before it finished, so there is no result. Re-run the workflow.",
    };
  }
  if (localResult !== "skipped") {
    return { ok: false, message: `The end-to-end job reported "${localResult}", which this check does not know how to read.` };
  }

  // Skipped. Which kind?
  if (!identityConfigured) {
    return {
      ok: false,
      message:
        "The end-to-end suite could not run: the repository has no test identity configured " +
        "(the GCP_WORKLOAD_IDENTITY_PROVIDER variable is empty). A suite that cannot run has not " +
        "passed. See scripts/e2e/README.md, 'In CI'.",
    };
  }

  const fromFork = headRepo !== repo;
  const byDependabot = actor === DEPENDABOT;
  if (!fromFork && !byDependabot) {
    return {
      ok: false,
      message:
        "The end-to-end job was skipped, and not for a reason this check recognises " +
        "(not Dependabot, not a fork, and the test identity is configured). Read the job's `if:`.",
    };
  }

  const who = byDependabot ? "a run started by Dependabot" : "a run from a fork";
  if (MUST_RUN_BASES.includes(baseRef)) {
    return {
      ok: false,
      message:
        `The end-to-end suite has not run on this pull request: ${who} is not given the ` +
        `repository's secrets. Nothing merges into ${baseRef} on the other checks alone. ${RUN_IT}`,
    };
  }
  return {
    ok: true,
    message:
      `The end-to-end suite did not run here: ${who} is not given the repository's secrets. ` +
      `It is not held for ${baseRef || "this branch"}: the nightly run against the deployed dev site and ` +
      `the promotion pull request both run the suite before the change can reach production. ${RUN_IT}`,
  };
}

function main() {
  const env = process.env;
  const verdict = decide({
    localResult: env.LOCAL_RESULT ?? "",
    baseRef: env.BASE_REF ?? "",
    actor: env.ACTOR ?? "",
    headRepo: env.HEAD_REPO ?? "",
    repo: env.REPO ?? "",
    identityConfigured: env.IDENTITY_CONFIGURED === "true",
  });
  // Shown on the pull request itself, not only in the log.
  console.log(`::${verdict.ok ? "notice" : "error"} title=End-to-end result::${verdict.message}`);
  process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
