/**
 * A scheduled check that does not pass reaches a person.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * The nightly end-to-end run failed for three weeks in September 2026 with
 * nobody told. `scripts/ci/alert-issue.mjs` is the fix: one issue per check,
 * opened when it stops passing, commented on while it stays that way, closed
 * when it passes again. This drives it against a GitHub that lives in memory
 * and holds the four rows of its table, plus the two ways an alert could
 * quietly not be one: a SKIPPED check read as fine, and an issue nobody is
 * told about.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { report, drill, githubApi } from "../scripts/ci/alert-issue.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN = "https://github.com/notts-aisi/naisi-website/actions/runs/1";

/** A GitHub small enough to read. */
let issues;
let labels;
let calls;
let refuseAssignees;

function fakeApi() {
  const ok = (data, status = 200) => ({ ok: true, status, data });
  return {
    get: async (path) => {
      calls.push(`GET ${path}`);
      const label = decodeURIComponent(path.match(/labels=([^&]+)/)[1]);
      return ok(issues.filter((i) => i.state === "open" && i.labels.includes(label)));
    },
    post: async (path, body) => {
      calls.push(`POST ${path}`);
      if (path === "/labels") {
        if (labels.has(body.name)) return { ok: false, status: 422, data: null };
        labels.add(body.name);
        return ok(body, 201);
      }
      if (path === "/issues") {
        if (refuseAssignees && body.assignees?.length) return { ok: false, status: 422, data: null };
        const issue = { number: issues.length + 1, state: "open", comments: [], assignees: [], ...body };
        issues.push(issue);
        return ok(issue, 201);
      }
      const comment = path.match(/^\/issues\/(\d+)\/comments$/);
      if (comment) {
        issues[Number(comment[1]) - 1].comments.push(body.body);
        return ok({}, 201);
      }
      throw new Error(`the fake has no POST ${path}`);
    },
    patch: async (path, body) => {
      calls.push(`PATCH ${path}`);
      Object.assign(issues[Number(path.match(/^\/issues\/(\d+)$/)[1]) - 1], body);
      return ok({});
    },
  };
}

const nightly = (result, overrides = {}) =>
  report({
    api: fakeApi(),
    key: "nightly-e2e",
    what: "The nightly end-to-end run",
    result,
    runUrl: RUN,
    assignees: ["the-owner"],
    ...overrides,
  });

beforeEach(() => {
  issues = [];
  labels = new Set();
  calls = [];
  refuseAssignees = false;
});

describe("the four rows", () => {
  test("not passing, nothing open: an issue is opened, assigned and labelled", async () => {
    await nightly("failure");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].title, "The nightly end-to-end run is not passing");
    assert.deepEqual(issues[0].assignees, ["the-owner"]);
    assert.deepEqual(issues[0].labels, ["ci-alert:nightly-e2e"]);
    assert.ok(issues[0].body.includes(RUN), "the issue does not say where the run is");
  });

  test("not passing again: the same issue gets a comment, so it notifies again", async () => {
    await nightly("failure");
    await nightly("failure", { runUrl: `${RUN}2` });
    assert.equal(issues.length, 1, "a second issue was opened for the same check");
    assert.equal(issues[0].comments.length, 1);
    assert.ok(issues[0].comments[0].includes(`${RUN}2`));
    assert.ok(issues[0].comments[0].includes("@the-owner"), "a comment that mentions nobody notifies nobody new");
  });

  test("passing, with an issue open: it says so and closes it", async () => {
    await nightly("failure");
    await nightly("success");
    assert.equal(issues[0].state, "closed");
    assert.match(issues[0].comments.at(-1), /Passed again/);
  });

  test("passing, nothing open: nothing is written at all", async () => {
    await nightly("success");
    assert.equal(issues.length, 0);
    assert.deepEqual(calls.filter((c) => !c.startsWith("GET")), []);
  });

  test("after it has closed, the next failure opens a new issue", async () => {
    await nightly("failure");
    await nightly("success");
    await nightly("failure");
    assert.equal(issues.length, 2);
    assert.equal(issues[1].state, "open");
  });
});

describe("the ways an alert could quietly not be one", () => {
  test("a skipped or cancelled check is not passing", async () => {
    for (const result of ["skipped", "cancelled", "", "neutral"]) {
      issues = [];
      await nightly(result);
      assert.equal(issues.length, 1, `"${result}" opened no issue`);
    }
  });

  test("a skip is explained, because on a schedule it means something is not configured", async () => {
    await nightly("skipped");
    assert.match(issues[0].body, /did not run at all/);
  });

  test("an account that cannot be assigned does not stop the alert, and is still mentioned", async () => {
    refuseAssignees = true;
    await nightly("failure");
    assert.equal(issues.length, 1);
    assert.ok(issues[0].body.includes("@the-owner"));
  });

  test("each check has its own issue", async () => {
    await nightly("failure");
    await nightly("failure", { key: "config-drift", what: "The configuration drift check" });
    assert.equal(issues.length, 2);
    await nightly("success", { key: "config-drift", what: "The configuration drift check" });
    assert.equal(issues[0].state, "open", "one check passing closed another check's alert");
    assert.equal(issues[1].state, "closed");
  });

  test("a pull request carrying the label is not mistaken for the alert", async () => {
    issues.push({ number: 1, state: "open", labels: ["ci-alert:nightly-e2e"], pull_request: {}, comments: [] });
    await nightly("failure");
    assert.equal(issues.length, 2);
    assert.equal(issues[0].comments.length, 0);
  });

  test("an API that refuses is an error, not a shrug", async () => {
    const refusing = { ...fakeApi(), get: async () => ({ ok: false, status: 403, data: null }) };
    await assert.rejects(() => nightly("failure", { api: refusing }), /answered 403/);
  });

  test("the issue says the check did not pass and where, and nothing about why", async () => {
    // The repository is public, so the detail stays in the run log.
    await nightly("failure");
    const text = `${issues[0].title}\n${issues[0].body}`;
    assert.doesNotMatch(text, /stack|Error:|password|secret|token/i);
  });
});

describe("the drill", () => {
  test("opens an alert under its own label and closes it again", async () => {
    await drill({ api: fakeApi(), runUrl: RUN, assignees: ["the-owner"] });
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].labels, ["ci-alert:drill"]);
    assert.deepEqual(issues[0].assignees, ["the-owner"]);
    assert.equal(issues[0].state, "closed");
  });
});

describe("the client", () => {
  test("sends the token and addresses the repository it was given", async () => {
    const seen = [];
    const api = githubApi({
      token: "t0ken",
      repository: "an-org/a-repo",
      apiUrl: "https://api.example",
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return { ok: true, status: 200, json: async () => [] };
      },
    });
    await api.get("/issues?state=open");
    await api.post("/issues", { title: "x" });
    assert.equal(seen[0].url, "https://api.example/repos/an-org/a-repo/issues?state=open");
    assert.equal(seen[0].init.headers.authorization, "Bearer t0ken");
    assert.equal(seen[1].init.method, "POST");
    assert.equal(seen[1].init.body, JSON.stringify({ title: "x" }));
  });
});

describe("every scheduled workflow reports its result", () => {
  // The class is a scheduled run with nobody watching it. A new one is covered
  // without anybody remembering this file exists.
  const dir = join(REPO_ROOT, ".github/workflows");
  const scheduled = ["checks.yml", "codeql.yml", "e2e.yml", "config-drift.yml"]
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }))
    .filter(({ text }) => /\n {2}schedule:\n/.test(text));

  // A scheduled workflow with no alert, and why that is sound.
  const REPORTS_ANOTHER_WAY = {
    "codeql.yml":
      "its findings land under Security as alerts, which GitHub mails to the people watching them, " +
      "and its analyses are required checks on every pull request, so a broken analysis is seen there",
  };

  test("the list of workflows above is the whole directory", async () => {
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(
      readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort(),
      ["checks.yml", "codeql.yml", "config-drift.yml", "e2e.yml"],
      "a workflow was added or removed: update the list in this test so the walk below covers it",
    );
  });

  test("each one runs the alert on its schedule, or says why it need not", () => {
    assert.ok(scheduled.length >= 2, "the walk found fewer scheduled workflows than exist");
    for (const { name, text } of scheduled) {
      const alerts = /if: always\(\) && \(?github\.event_name == 'schedule'/.test(text)
        && /run: node scripts\/ci\/alert-issue\.mjs/.test(text);
      if (name in REPORTS_ANOTHER_WAY) {
        assert.ok(!alerts, `${name} now runs the alert: remove it from REPORTS_ANOTHER_WAY`);
      } else {
        assert.ok(alerts, `${name} runs on a schedule and nothing tells anybody when it fails`);
      }
    }
  });
});
