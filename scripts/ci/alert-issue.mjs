#!/usr/bin/env node
/**
 * Tell the owner when a scheduled check is not passing, by opening one issue
 * and keeping it up to date.
 *
 * WHY THIS EXISTS. The nightly end-to-end run failed every night for three
 * weeks in September 2026 and nobody knew. A scheduled run has no pull request
 * to turn red and nobody watching it; GitHub's own failure mail goes only to
 * whoever last edited the schedule line, and only if they have that mail
 * switched on. A check that fails where nobody looks is not a check.
 *
 * WHAT IT DOES. One issue per check, found by its label:
 *
 *   the check did not pass, no open issue    open one, assigned to the owner
 *   the check did not pass, issue open       add a comment (so it notifies again)
 *   the check passed, issue open             say so and close it
 *   the check passed, no open issue          nothing
 *
 * "Did not pass" means anything other than success: a failure, a cancelled
 * run, and a job that was SKIPPED. On a schedule a skip means the thing that
 * lets the check run is missing, which is the quietest failure of all and the
 * reason this reads the result rather than hooking `if: failure()`.
 *
 * WHAT THE ISSUE SAYS. That the check did not pass, and where the run is.
 * Nothing else. This repository is public; the detail stays in the run log.
 *
 * It talks to the GitHub API with the workflow's own token (`issues: write`)
 * and nothing else, so no third-party action and no extra secret is involved.
 * `tests/ci-alert-issue.test.mjs` drives `report` against a fake API.
 */

import { pathToFileURL } from "node:url";

const LABEL_COLOUR = "b60205";

/** A small client for one repository's issues, over `fetch`. */
export function githubApi({ token, repository, apiUrl = "https://api.github.com", fetchImpl = fetch }) {
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${apiUrl}/repos/${repository}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
  };
  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    patch: (path, body) => call("PATCH", path, body),
  };
}

function describe(result) {
  if (result === "failure") return "did not pass";
  if (result === "cancelled") return "was cancelled before it finished";
  if (result === "skipped") {
    return "did not run at all: its job was skipped, which on a schedule means something it needs is not configured";
  }
  return `ended as "${result}"`;
}

function must(response, doing) {
  if (!response.ok) {
    throw new Error(`could not ${doing}: the API answered ${response.status}`);
  }
  return response.data;
}

/**
 * @param {{ api: ReturnType<typeof githubApi>, key: string, what: string, result: string,
 *           runUrl: string, assignees: string[] }} args
 * @returns {Promise<string>} what was done, for the log
 */
export async function report({ api, key, what, result, runUrl, assignees }) {
  const label = `ci-alert:${key}`;
  const found = must(
    await api.get(`/issues?state=open&labels=${encodeURIComponent(label)}&per_page=10`),
    "look for an open alert",
  );
  // The issues list also returns pull requests carrying the label.
  const open = (found ?? []).find((issue) => !issue.pull_request);

  if (result === "success") {
    if (!open) return `${what} passed, and no alert was open.`;
    must(
      await api.post(`/issues/${open.number}/comments`, { body: `Passed again: ${runUrl}\n\nClosing.` }),
      "comment on the alert",
    );
    must(
      await api.patch(`/issues/${open.number}`, { state: "closed", state_reason: "completed" }),
      "close the alert",
    );
    return `${what} passed again: closed #${open.number}.`;
  }

  const mentions = assignees.map((name) => `@${name}`).join(" ");
  if (open) {
    must(
      await api.post(`/issues/${open.number}/comments`, {
        body: `Still not passing. The latest run ${describe(result)}: ${runUrl}${mentions ? `\n\n${mentions}` : ""}`,
      }),
      "comment on the alert",
    );
    return `${what} is still not passing: commented on #${open.number}.`;
  }

  // The label is how the next run finds this issue, so it has to exist. 422
  // is "already there".
  const made = await api.post("/labels", {
    name: label,
    color: LABEL_COLOUR,
    description: "Opened and closed by a scheduled workflow",
  });
  if (!made.ok && made.status !== 422) must(made, "create the alert label");

  const body =
    `${what} ${describe(result)}.\n\n` +
    `Run: ${runUrl}\n\n` +
    `This issue is opened and closed by the workflow. It gets a comment each time the check ` +
    `fails again, and it closes itself when the check next passes.` +
    (mentions ? `\n\n${mentions}` : "");
  const title = `${what} is not passing`;
  let created = await api.post("/issues", { title, body, labels: [label], assignees });
  if (!created.ok && created.status === 422 && assignees.length > 0) {
    // An account that cannot be assigned must not stop the alert. The mention
    // in the body still notifies it.
    created = await api.post("/issues", { title, body, labels: [label] });
  }
  const issue = must(created, "open the alert");
  return `${what} ${describe(result)}: opened #${issue.number}.`;
}

/** Prove the alert reaches its owner: open one under a label of its own, then close it. */
export async function drill({ api, runUrl, assignees }) {
  const args = { api, key: "drill", what: "The alert drill", runUrl, assignees };
  const opened = await report({ ...args, result: "failure" });
  const closed = await report({ ...args, result: "success" });
  return `${opened} ${closed}`;
}

async function main() {
  const env = process.env;
  for (const name of ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "ALERT_RUN_URL"]) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  const api = githubApi({ token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
  const assignees = (env.ALERT_ASSIGNEES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const runUrl = env.ALERT_RUN_URL;

  if (env.ALERT_DRILL === "true") {
    console.log(await drill({ api, runUrl, assignees }));
    return;
  }
  for (const name of ["ALERT_KEY", "ALERT_WHAT", "ALERT_RESULT"]) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  console.log(
    await report({ api, key: env.ALERT_KEY, what: env.ALERT_WHAT, result: env.ALERT_RESULT, runUrl, assignees }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // The alert failing to send is itself something the owner has to hear
    // about, and a red job on the scheduled run is the only voice it has.
    console.error(`::error title=Alert not sent::${err.message}`);
    process.exit(1);
  });
}
