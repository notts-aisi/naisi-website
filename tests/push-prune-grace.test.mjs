/**
 * Guards for the push sender's fresh-subscription grace window (run via
 * `npm test`, Node's built-in runner).
 *
 * Measured 2026-08-29: FCM answers 410 "push subscription has unsubscribed
 * or expired" for roughly the first nine seconds after a subscription is
 * created, then 201. The first thing a member does after enabling is send
 * themselves a test, which lands inside that window every time, and a naive
 * prune-on-410 then deletes the row they just registered. src/lib/push/send.ts
 * therefore refuses to prune a row younger than PRUNE_GRACE_MS, and the
 * self-test route asks for retries inside it. These assertions keep both
 * halves from being simplified away by a future tidy-up; the source files
 * are read as text because the modules import server-only and firebase-admin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(REPO_ROOT, p), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const send = stripComments(read("src/lib/push/send.ts"));
const store = stripComments(read("src/lib/push/store.ts"));
const testRoute = stripComments(read("src/app/api/push/test/route.ts"));

test("the grace window is at least the measured lag, with margin", () => {
  const m = send.match(/PRUNE_GRACE_MS\s*=\s*([^;]+);/);
  assert.ok(m, "PRUNE_GRACE_MS must be declared in send.ts");
  const ms = Function(`return (${m[1]})`)();
  assert.ok(ms >= 30_000, `grace window ${ms}ms is below the 30s floor (measured lag ~9s)`);
});

test("a 404/410 only prunes outside the grace window", () => {
  const catchBlock = send.slice(send.indexOf("catch (err)"));
  const graceIdx = catchBlock.indexOf("isWithinGrace(");
  const pruneIdx = catchBlock.indexOf("pruneSubscription(");
  assert.ok(graceIdx !== -1, "the catch path must consult isWithinGrace");
  assert.ok(pruneIdx !== -1, "the catch path must still prune dead rows");
  assert.ok(graceIdx < pruneIdx, "the grace check must come before the prune");
  assert.equal(
    (send.match(/pruneSubscription\(/g) ?? []).length,
    1,
    "pruneSubscription must be called from exactly one place in send.ts",
  );
});

test("the store surfaces createdAt so the window has something to key on", () => {
  assert.match(store, /createdAt\?:\s*Date/, "StoredSubscription must carry createdAt");
  assert.match(store, /createdAt\.toDate\(\)/, "subscriptionsForUid must convert the Timestamp");
});

test("the self-test retries inside the window; task mirrors do not", () => {
  assert.match(testRoute, /retryFresh:\s*true/, "the self-test route must pass retryFresh");
  const mirror = stripComments(read("src/lib/push/taskNotifications.ts"));
  assert.doesNotMatch(mirror, /retryFresh/, "task mirrors must not hold a task route open on retries");
});
