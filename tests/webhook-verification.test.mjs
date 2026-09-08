/**
 * Every webhook route verifies its sender before it trusts a byte of the body,
 * and none confirms a subscription on the sender's say-so.
 *
 * WHY. A webhook is an unauthenticated POST from the internet by definition;
 * the only thing that makes it the provider's is a signature the route
 * checks itself. On 8 September 2026 the SES/SNS webhook was found to accept
 * any message AWS had signed for ANY customer, and to confirm any SNS
 * subscription by fetching the `SubscribeURL` in the body, so a stranger with
 * a free AWS account could subscribe the endpoint to their own topic and
 * write bounces that suppressed arbitrary addresses. The SES pipeline had
 * been orphaned by the Resend migration, so the route was deleted. This guard
 * is what stops the next one:
 *
 * - every route.ts under src/app/api/webhooks is in VERIFIERS, both ways;
 * - its verifier is called BEFORE the first JSON.parse of the body;
 * - nothing under that tree fetches a URL the body supplied.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEBHOOKS = join(REPO_ROOT, "src", "app", "api", "webhooks");

/** route.ts, repo-relative -> the function that proves the sender. */
const VERIFIERS = {
  "src/app/api/webhooks/resend-events/route.ts": "verifySvixSignature",
};

function codeOf(file) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry === "route.ts") yield full;
  }
}

const routes = existsSync(WEBHOOKS) ? [...walk(WEBHOOKS)].map((f) => relative(REPO_ROOT, f)) : [];

test("every webhook route is registered with its verifier, and every registered route exists", () => {
  const unregistered = routes.filter((r) => !(r in VERIFIERS));
  assert.deepEqual(unregistered, [], "Add the route to VERIFIERS with the function that checks its signature.");
  const stale = Object.keys(VERIFIERS).filter((r) => !routes.includes(r));
  assert.deepEqual(stale, [], "These registered routes no longer exist: remove them.");
});

test("each webhook verifies the sender before parsing the body, and never fetches a URL from it", () => {
  for (const [route, verifier] of Object.entries(VERIFIERS)) {
    const source = codeOf(join(REPO_ROOT, route));
    const call = source.indexOf(`${verifier}(`);
    // The definition comes first; the CALL is the second occurrence.
    const callSite = source.indexOf(`${verifier}(`, call + 1);
    assert.ok(callSite > -1, `${route} defines ${verifier} but never calls it.`);
    const parse = source.search(/JSON\.parse\(|\.json\(\)/);
    assert.ok(parse > -1, `${route} never parses a body, which is not what a webhook does.`);
    assert.ok(callSite < parse, `${route} must call ${verifier} before it parses the body.`);
    assert.doesNotMatch(source, /SubscribeURL|SubscriptionConfirmation/, `${route} confirms a subscription from the body.`);
  }
});
