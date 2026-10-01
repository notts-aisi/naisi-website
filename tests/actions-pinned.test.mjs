/**
 * Two guards on the GitHub Actions workflows (run via `npm test`, Node's
 * built-in test runner, no dependencies).
 *
 * 1. EVERY ACTION IS PINNED TO A COMMIT. `uses: actions/checkout@v4` names a
 *    tag, and a tag is a pointer its owner can move: whoever controls that
 *    repository, or steals a maintainer's token, repoints `v4` and the next
 *    run here executes their code with this run's token and secrets. For the
 *    end-to-end workflow that means a Google Cloud identity on the dev project.
 *    A full commit SHA cannot be repointed, so every `uses:` must name one,
 *    with the release it corresponds to in a trailing comment
 *    (`@<40 hex> # v4.4.0`). The comment is what a reviewer reads, and it is
 *    what Dependabot rewrites when it bumps the pin, so it is required too.
 *    The repository setting "Require actions to be pinned to a full-length
 *    commit SHA" enforces the same thing at run time; this fails earlier, on
 *    the pull request that would break it, and says which line.
 *
 * 2. EVERY JOB'S TOKEN IS SCOPED. Without a `permissions:` block a job gets
 *    whatever the repository default is. Each workflow must declare one at the
 *    top level, or every one of its jobs must declare its own.
 *
 * Both walk every workflow file and every local composite action, so a new
 * workflow is covered without anyone remembering this file exists. A line the
 * reader below cannot classify fails rather than being skipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");
const LOCAL_ACTIONS_DIR = join(REPO_ROOT, ".github", "actions");

const isYaml = (name) => name.endsWith(".yml") || name.endsWith(".yaml");

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const workflowFiles = walk(WORKFLOW_DIR).filter((f) => isYaml(f));
const actionFiles = walk(LOCAL_ACTIONS_DIR).filter((f) => /(^|\/)action\.ya?ml$/.test(f));

/** Every `uses:` in a file, with its line number, its value and its trailing comment. */
function usesIn(file) {
  const found = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const m = line.match(/^\s*(?:-\s*)?uses:\s*(.*)$/);
      if (!m) return;
      const [value, ...rest] = m[1].split("#");
      found.push({
        where: `${relative(REPO_ROOT, file)}:${i + 1}`,
        ref: value.trim().replace(/^["']|["']$/g, ""),
        comment: rest.join("#").trim(),
      });
    });
  return found;
}

const SHA_PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
const DIGEST_PINNED = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
const VERSION_COMMENT = /^v\d+(?:\.\d+){0,2}\b/;

test("every action in every workflow is pinned to a full commit SHA", () => {
  assert.ok(workflowFiles.length > 0, "no workflow files found: the walk is looking in the wrong place");

  const all = [...workflowFiles, ...actionFiles].flatMap(usesIn);
  assert.ok(all.length > 0, "no `uses:` line found in any workflow: the reader is not reading them");

  const problems = [];
  for (const { where, ref, comment } of all) {
    // An action that lives in this repository is reviewed with the change that uses it.
    if (ref.startsWith("./")) continue;
    if (ref.startsWith("docker://")) {
      if (!DIGEST_PINNED.test(ref)) problems.push(`${where}: container image "${ref}" is not pinned to a sha256 digest`);
      continue;
    }
    if (!SHA_PINNED.test(ref)) {
      problems.push(`${where}: "${ref}" is not pinned to a 40-character commit SHA (a tag or branch can be repointed)`);
      continue;
    }
    if (!VERSION_COMMENT.test(comment)) {
      problems.push(`${where}: "${ref}" has no trailing version comment such as "# v4.4.0" (Dependabot and reviewers read it)`);
    }
  }

  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
});

test("every workflow scopes the token its jobs receive", () => {
  const problems = [];
  for (const file of workflowFiles) {
    const name = relative(REPO_ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");
    if (lines.some((l) => /^permissions:/.test(l))) continue;

    const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
    if (jobsAt < 0) {
      problems.push(`${name}: no top-level \`jobs:\` key found, so its jobs could not be read`);
      continue;
    }
    // Job ids sit two spaces in; each job's own keys sit four in.
    const jobs = [];
    for (let i = jobsAt + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break;
      const m = lines[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
      if (m) jobs.push({ id: m[1], scoped: false });
      else if (jobs.length && /^ {4}permissions:/.test(lines[i])) jobs[jobs.length - 1].scoped = true;
    }
    if (jobs.length === 0) {
      problems.push(`${name}: \`jobs:\` holds no job this reader could find`);
      continue;
    }
    for (const job of jobs.filter((j) => !j.scoped)) {
      problems.push(`${name}: job "${job.id}" has no \`permissions:\` block and the workflow has no top-level one`);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
});
