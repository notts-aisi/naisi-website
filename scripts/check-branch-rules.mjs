#!/usr/bin/env node
/**
 * Branch rule guard: do `main` and `dev` on GitHub require what this file says
 * they require?
 *
 * WHY THIS EXISTS. What a branch requires before a merge is a setting on
 * GitHub, not a file in the repository, so nothing reviews a change to it and
 * nothing notices one. The checks themselves are guarded line by line; the
 * rule that makes them count was held by memory. This is the same drift class
 * as an API key's restrictions or a project's sign-in providers, so it gets
 * the same treatment: the expectation is written down HERE, and the live
 * setting is compared with it.
 *
 * TWO LAYERS.
 *
 *  1. This file against the workflows. `tests/branch-rules.test.mjs` (offline,
 *     in `npm test`) requires every check named below to be a job that exists
 *     in `.github/workflows`, by its exact name. A required check whose job
 *     was renamed never reports, and every pull request then waits for ever.
 *  2. This file against GitHub. That is what running this script does. A
 *     public repository's rulesets are readable by anybody, so it needs no
 *     token and runs daily from `.github/workflows/config-drift.yml`.
 *
 * CHANGING A RULE is therefore a pull request: edit BRANCH_RULES, merge, then
 * apply it with an admin token so the setting matches the file again:
 *
 *   GH_TOKEN=$(gh auth token) node scripts/check-branch-rules.mjs --apply dev
 *
 * `--apply` rewrites exactly two things on the branch's ruleset, the list of
 * required checks and the code scanning rule, and leaves every other rule as
 * it finds it.
 *
 * USAGE
 *   node scripts/check-branch-rules.mjs                  # compare both branches
 *   node scripts/check-branch-rules.mjs --apply main     # write, needs an admin token
 */

import { pathToFileURL } from "node:url";

/** The GitHub Actions app. A required check names the app that must report it. */
const GITHUB_ACTIONS_APP = 15368;

export const REPOSITORY = "notts-aisi/naisi-website";

/**
 * What each long-lived branch requires, with the reason for each line.
 *
 * `later` holds checks that are meant to be required and are not yet, each
 * with what it is waiting for. It is written down so that "not required" is a
 * decision with a date on it and not an omission, and the guard holds that a
 * check is in one list or the other, never both.
 */
export const BRANCH_RULES = {
  main: {
    refs: ["~DEFAULT_BRANCH", "refs/heads/main"],
    deploysTo: "production (naisi.uk), on every merge",
    requiredChecks: {
      "Typecheck, lint, tests, build": "checks.yml. The build is the only place Next enforces the client and server boundary.",
      "Firestore and Storage rules": "checks.yml. The rules suite on the emulator.",
      "Analyze (actions)": "codeql.yml. The analysis has to have run for its results to mean anything.",
      "Analyze (javascript-typescript)": "codeql.yml. Likewise, for the application code.",
    },
    later: {
      "End-to-end result":
        "Required on dev now. Becomes required here once the end-to-end workflow's test identity " +
        "has moved to the new dev project, so that a change to the identity cannot leave " +
        "production unable to take a merge. Until then the check still runs and still reports.",
    },
    // A merge must be tested against the branch it lands on.
    upToDateBeforeMerge: true,
    pullRequest: { mergeMethods: ["merge"] },
    codeScanning: { tool: "CodeQL", securityAlerts: "high_or_higher", alerts: "errors" },
    // Nobody skips a rule on the production branch.
    bypass: [],
  },
  dev: {
    refs: ["refs/heads/dev"],
    deploysTo: "the dev backend (dev.naisi.uk), on every push",
    requiredChecks: {
      "Typecheck, lint, tests, build": "checks.yml.",
      "Firestore and Storage rules": "checks.yml.",
      "Analyze (actions)": "codeql.yml.",
      "Analyze (javascript-typescript)": "codeql.yml.",
      "End-to-end result":
        "e2e.yml. The suite's verdict, read by scripts/ci/e2e-result.mjs so that a skipped suite " +
        "is not mistaken for a passed one.",
    },
    later: {},
    upToDateBeforeMerge: false,
    // dev takes a fast-forward from main after each promotion, so it does not
    // require a pull request.
    pullRequest: null,
    codeScanning: { tool: "CodeQL", securityAlerts: "high_or_higher", alerts: "errors" },
    // Repository admins. Two uses, both logged under the ruleset's insights:
    // fast-forwarding dev to main's merge commit after a promotion (that
    // commit never had a pull request, so it carries no end-to-end result),
    // and merging while the test identity is being replaced.
    bypass: [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }],
  },
};

const sorted = (list) => [...list].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** The ruleset that covers a branch, out of the repository's rulesets. */
export function rulesetFor(branch, rulesets) {
  const { refs } = BRANCH_RULES[branch];
  return (rulesets ?? []).find((rs) =>
    (rs?.conditions?.ref_name?.include ?? []).some((ref) => refs.includes(ref)),
  );
}

/** Compare one live ruleset with what this file declares. Both directions. */
export function compare(branch, ruleset) {
  const want = BRANCH_RULES[branch];
  const failures = [];
  const lines = [];
  const notes = [];
  const say = (ok, text) => (ok ? lines.push(`PASS  ${branch}: ${text}`) : failures.push(`${branch}: ${text}`));

  if (!ruleset) {
    return { failures: [`${branch}: no ruleset covers this branch at all`], lines, notes };
  }
  say(ruleset.enforcement === "active", `the ruleset "${ruleset.name}" is ${ruleset.enforcement === "active" ? "enforced" : `NOT enforced (${ruleset.enforcement})`}`);

  const rule = (type) => (ruleset.rules ?? []).find((r) => r.type === type);
  say(Boolean(rule("deletion")), rule("deletion") ? "the branch cannot be deleted" : "the branch CAN be deleted");
  say(Boolean(rule("non_fast_forward")), rule("non_fast_forward") ? "force pushes are refused" : "force pushes are ALLOWED");

  const checks = rule("required_status_checks");
  const live = (checks?.parameters?.required_status_checks ?? []).map((c) => c.context);
  const declared = Object.keys(want.requiredChecks);
  const missing = declared.filter((c) => !live.includes(c));
  const extra = live.filter((c) => !declared.includes(c));
  if (missing.length === 0 && extra.length === 0) {
    lines.push(`PASS  ${branch}: requires exactly ${declared.length} checks`);
  }
  for (const c of missing) failures.push(`${branch}: "${c}" is declared required and GitHub does not require it`);
  for (const c of extra) {
    failures.push(
      `${branch}: GitHub requires "${c}" and this file does not declare it. Add it to BRANCH_RULES ` +
        `with its reason, or remove it from the ruleset.`,
    );
  }
  const strict = checks?.parameters?.strict_required_status_checks_policy === true;
  say(
    strict === want.upToDateBeforeMerge,
    want.upToDateBeforeMerge
      ? `a branch ${strict ? "must" : "need NOT"} be up to date before it merges`
      : `a branch ${strict ? "MUST" : "need not"} be up to date before it merges`,
  );

  const pr = rule("pull_request");
  if (want.pullRequest) {
    say(Boolean(pr), pr ? "changes arrive by pull request" : "a pull request is NOT required");
    const methods = pr?.parameters?.allowed_merge_methods ?? [];
    say(same(methods, want.pullRequest.mergeMethods), `merge methods allowed: ${methods.join(", ") || "none"}`);
  } else {
    say(!pr, pr ? "a pull request is required, and this file says it is not" : "a pull request is not required");
  }

  const scanning = rule("code_scanning");
  const tool = (scanning?.parameters?.code_scanning_tools ?? []).find((t) => t.tool === want.codeScanning.tool);
  say(
    Boolean(tool)
      && tool.security_alerts_threshold === want.codeScanning.securityAlerts
      && tool.alerts_threshold === want.codeScanning.alerts,
    tool
      ? `${want.codeScanning.tool} results are required (security: ${tool.security_alerts_threshold}, alerts: ${tool.alerts_threshold})`
      : `${want.codeScanning.tool} results are NOT required`,
  );

  // The bypass list is only shown to a token that could use it.
  if (Array.isArray(ruleset.bypass_actors)) {
    const shape = (a) => `${a.actor_type}:${a.actor_id}:${a.bypass_mode}`;
    say(
      same(ruleset.bypass_actors.map(shape), want.bypass.map(shape)),
      ruleset.bypass_actors.length === 0
        ? "nobody may bypass the rules"
        : `may bypass: ${ruleset.bypass_actors.map(shape).join(", ")}`,
    );
  } else {
    notes.push(`${branch}: the bypass list is not visible to this token, so it was not compared. Run with an admin token to compare it.`);
  }

  for (const [check, why] of Object.entries(want.later)) {
    notes.push(`${branch}: "${check}" is not required yet. ${why}`);
  }
  return { failures, lines, notes };
}

/** The ruleset as `--apply` would write it: two rules replaced, the rest kept. */
export function applied(branch, ruleset) {
  const want = BRANCH_RULES[branch];
  const kept = (ruleset.rules ?? []).filter((r) => r.type !== "required_status_checks" && r.type !== "code_scanning");
  const existing = (ruleset.rules ?? []).find((r) => r.type === "required_status_checks");
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    conditions: ruleset.conditions,
    bypass_actors: ruleset.bypass_actors ?? [],
    rules: [
      ...kept,
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: existing?.parameters?.do_not_enforce_on_create ?? false,
          strict_required_status_checks_policy: want.upToDateBeforeMerge,
          required_status_checks: Object.keys(want.requiredChecks).map((context) => ({
            context,
            integration_id: GITHUB_ACTIONS_APP,
          })),
        },
      },
      {
        type: "code_scanning",
        parameters: {
          code_scanning_tools: [
            {
              tool: want.codeScanning.tool,
              security_alerts_threshold: want.codeScanning.securityAlerts,
              alerts_threshold: want.codeScanning.alerts,
            },
          ],
        },
      },
    ],
  };
}

async function github(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
  return res.json();
}

async function liveRulesets(token) {
  const list = await github("/rulesets?per_page=100", { token });
  // The list carries names and ids only; the rules are on each ruleset.
  return Promise.all(list.map((rs) => github(`/rulesets/${rs.id}`, { token })));
}

async function main() {
  const argv = process.argv.slice(2);
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";

  if (argv[0] === "--apply") {
    const branch = argv[1];
    if (!(branch in BRANCH_RULES)) throw new Error(`--apply needs a branch: ${Object.keys(BRANCH_RULES).join(" or ")}`);
    if (!token) throw new Error("--apply needs an admin token in GH_TOKEN");
    const ruleset = rulesetFor(branch, await liveRulesets(token));
    if (!ruleset) throw new Error(`no ruleset covers ${branch}`);
    if (!Array.isArray(ruleset.bypass_actors)) {
      throw new Error("this token cannot see the ruleset's bypass list, so writing it back would empty it. Use an admin token.");
    }
    await github(`/rulesets/${ruleset.id}`, { method: "PUT", body: applied(branch, ruleset), token });
    console.log(`Applied the declared rules to "${ruleset.name}". Comparing:`);
  } else if (argv.length > 0) {
    throw new Error(`Unknown argument "${argv[0]}".`);
  }

  const rulesets = await liveRulesets(token);
  const failures = [];
  for (const branch of Object.keys(BRANCH_RULES)) {
    const result = compare(branch, rulesetFor(branch, rulesets));
    for (const line of result.lines) console.log(line);
    for (const note of result.notes) console.log(`note  ${note}`);
    failures.push(...result.failures);
  }
  if (failures.length) {
    console.error(`\nBranch rule guard: ${failures.length} difference(s) between GitHub and scripts/check-branch-rules.mjs\n`);
    for (const f of failures) console.error(`FAIL  ${f}`);
    console.error(
      "\nIf the file is right, apply it: GH_TOKEN=$(gh auth token) node scripts/check-branch-rules.mjs --apply <branch>\n" +
        "If GitHub is right, change BRANCH_RULES in a pull request and say why.",
    );
    process.exit(1);
  }
  console.log(`\nBranch rules OK: ${Object.keys(BRANCH_RULES).join(" and ")} require what this file declares.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // A failed look is a failure, never a pass.
    console.error(`FAIL  could not compare the branch rules: ${err.message}`);
    process.exit(2);
  });
}
