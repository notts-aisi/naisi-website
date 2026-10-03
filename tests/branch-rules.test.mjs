/**
 * What `main` and `dev` require before a merge is written down, and every
 * check it names exists.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * A branch rule lives on GitHub, not in the repository, so nothing reviewed a
 * change to one and nothing noticed. `scripts/check-branch-rules.mjs` declares
 * the rules and compares GitHub with them daily. This is the seam on the other
 * side, the declaration against the workflows:
 *
 *  - A REQUIRED CHECK IS A NAME. If the job that reports it is renamed, the
 *    check never arrives and every pull request waits for ever on a check no
 *    run will produce. So every name declared here must be the exact name of a
 *    job in `.github/workflows`.
 *  - The comparison itself is held too: a difference in either direction is a
 *    failure, a setting the token cannot see is said out loud rather than
 *    passed, and `--apply` rewrites the two rules it owns and nothing else.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRANCH_RULES, compare, applied, rulesetFor } from "../scripts/check-branch-rules.mjs";
import { MUST_RUN_BASES } from "../scripts/ci/e2e-result.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(REPO_ROOT, ".github/workflows");

/** Every job name the workflows can report, with a matrix name written out per entry. */
function jobNames() {
  const names = new Map();
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const text = readFileSync(join(WORKFLOWS, file), "utf8");
    for (const [, name] of text.matchAll(/\n {4}name: (.+)\n/g)) {
      const template = name.match(/\$\{\{ matrix\.([a-z-]+) \}\}/);
      if (!template) {
        names.set(name, file);
        continue;
      }
      const values = [...text.matchAll(new RegExp(`\\n\\s+- ${template[1]}: (\\S+)\\n`, "g"))].map((m) => m[1]);
      assert.ok(values.length > 0, `${file}: "${name}" takes its name from a matrix this reader could not expand`);
      for (const value of values) names.set(name.replace(template[0], value), file);
    }
  }
  return names;
}

describe("the declaration against the workflows", () => {
  const names = jobNames();

  test("the reader finds the jobs", () => {
    assert.ok(names.size >= 6, `only ${names.size} job names were read`);
    assert.ok(names.has("Analyze (javascript-typescript)"), "the matrix job was not written out");
  });

  test("every check a branch requires, now or later, is a job that exists by that exact name", () => {
    const missing = [];
    for (const [branch, rules] of Object.entries(BRANCH_RULES)) {
      for (const check of [...Object.keys(rules.requiredChecks), ...Object.keys(rules.later)]) {
        if (!names.has(check)) missing.push(`${branch}: "${check}"`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      "A required check with no job behind it never reports, and every pull request then waits on it " +
        "for ever. Rename the job back, or change BRANCH_RULES in scripts/check-branch-rules.mjs and " +
        "apply it BEFORE the rename merges.",
    );
  });

  test("a check is required or waiting to be, never both", () => {
    for (const [branch, rules] of Object.entries(BRANCH_RULES)) {
      const both = Object.keys(rules.later).filter((check) => check in rules.requiredChecks);
      assert.deepEqual(both, [], branch);
    }
  });

  test("every line carries its reason, and a waiting check says what it waits for", () => {
    for (const [branch, rules] of Object.entries(BRANCH_RULES)) {
      for (const [check, why] of Object.entries(rules.requiredChecks)) {
        assert.ok(typeof why === "string" && why.length > 8, `${branch}: "${check}" has no reason`);
      }
      for (const [check, why] of Object.entries(rules.later)) {
        assert.match(why, /once|until|after|when/i, `${branch}: "${check}" does not say what it is waiting for`);
      }
    }
  });

  test("the suite's verdict is required, or waiting to be, on every branch that holds for it", () => {
    // scripts/ci/e2e-result.mjs HOLDS a pull request into these branches when
    // the suite could not run. The hold only blocks a merge where the check is
    // required, so a branch on that list must name the check here.
    for (const branch of MUST_RUN_BASES) {
      const rules = BRANCH_RULES[branch];
      assert.ok(rules, `${branch} holds for the suite and has no declared rules`);
      assert.ok(
        "End-to-end result" in rules.requiredChecks || "End-to-end result" in rules.later,
        `${branch} holds for the suite and neither requires its verdict nor says when it will`,
      );
    }
    assert.ok("End-to-end result" in BRANCH_RULES.dev.requiredChecks, "dev no longer requires the suite's verdict");
  });

  test("production is never the looser of the two", () => {
    const { main, dev } = BRANCH_RULES;
    assert.deepEqual(main.bypass, [], "somebody may bypass the rules on the production branch");
    assert.equal(main.upToDateBeforeMerge, true);
    assert.ok(main.pullRequest, "production takes changes without a pull request");
    for (const check of Object.keys(dev.requiredChecks)) {
      assert.ok(
        check in main.requiredChecks || check in main.later,
        `dev requires "${check}" and main neither requires it nor says when it will`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/** GitHub's answer for a branch whose ruleset matches the declaration. */
function matching(branch) {
  const want = BRANCH_RULES[branch];
  return {
    id: 1,
    name: `protect ${branch}`,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: [want.refs[0]], exclude: [] } },
    bypass_actors: want.bypass.map((a) => ({ ...a })),
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      ...(want.pullRequest
        ? [{ type: "pull_request", parameters: { allowed_merge_methods: [...want.pullRequest.mergeMethods], required_approving_review_count: 0 } }]
        : []),
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: false,
          strict_required_status_checks_policy: want.upToDateBeforeMerge,
          required_status_checks: Object.keys(want.requiredChecks).map((context) => ({ context, integration_id: 15368 })),
        },
      },
      {
        type: "code_scanning",
        parameters: {
          code_scanning_tools: [
            { tool: "CodeQL", security_alerts_threshold: want.codeScanning.securityAlerts, alerts_threshold: want.codeScanning.alerts },
          ],
        },
      },
    ],
  };
}

const withRule = (ruleset, type, change) => ({
  ...ruleset,
  rules: ruleset.rules.flatMap((r) => (r.type === type ? (change ? [change(structuredClone(r))] : []) : [r])),
});

describe("GitHub against the declaration", () => {
  test("a ruleset that matches has no differences, on either branch", () => {
    for (const branch of Object.keys(BRANCH_RULES)) {
      const result = compare(branch, matching(branch));
      assert.deepEqual(result.failures, [], branch);
      assert.ok(result.lines.length >= 6, `${branch}: the comparison looked at very little`);
    }
  });

  test("a branch with no ruleset at all is a failure", () => {
    assert.equal(compare("main", undefined).failures.length, 1);
  });

  const differences = {
    "a required check missing on GitHub": (rs) =>
      withRule(rs, "required_status_checks", (r) => {
        r.parameters.required_status_checks.pop();
        return r;
      }),
    "a check GitHub requires that is not declared": (rs) =>
      withRule(rs, "required_status_checks", (r) => {
        r.parameters.required_status_checks.push({ context: "Something else", integration_id: 15368 });
        return r;
      }),
    "no required checks rule at all": (rs) => withRule(rs, "required_status_checks", null),
    "the up-to-date requirement flipped": (rs) =>
      withRule(rs, "required_status_checks", (r) => {
        r.parameters.strict_required_status_checks_policy = !r.parameters.strict_required_status_checks_policy;
        return r;
      }),
    "code scanning results no longer required": (rs) => withRule(rs, "code_scanning", null),
    "the code scanning threshold loosened": (rs) =>
      withRule(rs, "code_scanning", (r) => {
        r.parameters.code_scanning_tools[0].security_alerts_threshold = "critical";
        return r;
      }),
    "the ruleset switched to evaluate only": (rs) => ({ ...rs, enforcement: "evaluate" }),
    "deletion allowed": (rs) => withRule(rs, "deletion", null),
    "force pushes allowed": (rs) => withRule(rs, "non_fast_forward", null),
    "somebody added to the bypass list": (rs) => ({
      ...rs,
      bypass_actors: [...rs.bypass_actors, { actor_type: "Team", actor_id: 9, bypass_mode: "always" }],
    }),
  };

  for (const [what, change] of Object.entries(differences)) {
    test(`${what}: reported, on both branches`, () => {
      for (const branch of Object.keys(BRANCH_RULES)) {
        const result = compare(branch, change(matching(branch)));
        assert.ok(result.failures.length >= 1, `${branch}: ${what} was not noticed`);
      }
    });
  }

  test("production losing its pull request rule, or gaining a merge method, is reported", () => {
    assert.ok(compare("main", withRule(matching("main"), "pull_request", null)).failures.length >= 1);
    const squash = withRule(matching("main"), "pull_request", (r) => {
      r.parameters.allowed_merge_methods.push("squash");
      return r;
    });
    assert.ok(compare("main", squash).failures.length >= 1);
  });

  test("a bypass list the token cannot see is said out loud, not passed", () => {
    const { bypass_actors, ...hidden } = matching("dev");
    assert.ok(Array.isArray(bypass_actors));
    const result = compare("dev", hidden);
    assert.deepEqual(result.failures, []);
    assert.ok(result.notes.some((n) => /bypass list is not visible/.test(n)));
    assert.ok(!result.lines.some((l) => /bypass/.test(l)), "it claimed to have checked a list it could not see");
  });

  test("a check that is waiting to be required is noted every time", () => {
    const result = compare("main", matching("main"));
    for (const check of Object.keys(BRANCH_RULES.main.later)) {
      assert.ok(result.notes.some((n) => n.includes(`"${check}" is not required yet`)), check);
    }
  });

  test("the ruleset for a branch is found by the ref it covers", () => {
    const all = [matching("dev"), matching("main")];
    assert.equal(rulesetFor("main", all).name, "protect main");
    assert.equal(rulesetFor("dev", all).name, "protect dev");
    assert.equal(rulesetFor("main", []), undefined);
  });
});

describe("applying the declaration", () => {
  test("it writes the declared checks and the code scanning rule", () => {
    for (const branch of Object.keys(BRANCH_RULES)) {
      const bare = withRule(withRule(matching(branch), "code_scanning", null), "required_status_checks", (r) => {
        r.parameters.required_status_checks = [{ context: "Typecheck, lint, tests, build", integration_id: 15368 }];
        return r;
      });
      assert.ok(compare(branch, bare).failures.length > 0, "the starting point should differ");
      assert.deepEqual(compare(branch, { ...bare, ...applied(branch, bare) }).failures, [], branch);
    }
  });

  test("it leaves every other rule, the conditions and the bypass list as it found them", () => {
    const before = matching("main");
    const after = applied("main", before);
    for (const type of ["deletion", "non_fast_forward", "pull_request"]) {
      assert.deepEqual(
        after.rules.find((r) => r.type === type),
        before.rules.find((r) => r.type === type),
        type,
      );
    }
    assert.deepEqual(after.conditions, before.conditions);
    assert.deepEqual(after.bypass_actors, before.bypass_actors);
    assert.equal(after.rules.length, before.rules.length, "a rule was added or dropped");
  });

  test("applying twice changes nothing the second time", () => {
    const once = applied("dev", matching("dev"));
    const twice = applied("dev", { ...matching("dev"), ...once });
    assert.deepEqual(twice, once);
  });
});

describe("it is watched", () => {
  test("the daily workflow compares GitHub with the declaration, off pull requests", () => {
    const workflow = readFileSync(join(WORKFLOWS, "config-drift.yml"), "utf8");
    assert.match(workflow, /\n {6}- run: node scripts\/check-branch-rules\.mjs\n/);
    assert.match(workflow, /\n {4}if: github\.event_name != 'pull_request'\n/);
  });
});
