/**
 * Guards for the service worker's write-nothing contract and the offline
 * page's self-containment (run via `npm test`, Node's built-in runner).
 *
 * public/sw.js promises, in its docblock, that the only Cache Storage write
 * it ever performs is one cache.add("/offline.html") and that it never
 * caches HTML routes. That promise is what makes skipWaiting safe, makes
 * deploys unbrickable (App Hosting does not keep old /_next/static
 * addressable, so any cached document would 404 its chunks after a
 * rollout), and keeps authed HTML out of shared-device storage. Prose
 * contracts drift; these assertions do not.
 *
 * KILL SWITCH escape hatch: the emergency worker (scripts/pwa/sw-kill.js)
 * contains zero cache.add calls by design, and deploying it means copying
 * it over public/sw.js. The write-nothing assertions therefore SKIP when
 * the file carries the KILL SWITCH sentinel, so the rollback that must
 * merge fastest cannot be blocked by its own test suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const swRaw = readFileSync(join(REPO_ROOT, "public", "sw.js"), "utf8");
const offlineRaw = readFileSync(join(REPO_ROOT, "public", "offline.html"), "utf8");
const killWorkerDeployed = swRaw.includes("KILL SWITCH");

/*
 * Assert against CODE, not commentary. The sw.js docblock legitimately
 * discusses cache.add and /_next/ in prose, and the first run of this suite
 * failed on exactly that. Comment-stripping here is naive (it would mangle
 * string literals containing markers) but sufficient for these two files,
 * which the self-containment tests below keep simple enough for it to hold.
 */
const stripJsComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const stripHtmlComments = (src) => src.replace(/<!--[\s\S]*?-->/g, "");
const sw = stripJsComments(swRaw);
const offline = stripHtmlComments(offlineRaw);

test("sw.js writes nothing to Cache Storage except the offline page", { skip: killWorkerDeployed }, () => {
  const adds = sw.match(/cache\.add\(/g) ?? [];
  assert.equal(adds.length, 1, "expected exactly one cache.add() (the offline page)");
  assert.match(sw, /cache\.add\(OFFLINE_URL\)/, "the one cache.add must target OFFLINE_URL");
  assert.doesNotMatch(sw, /\.put\(/, "cache.put would be a runtime cache write; the contract forbids it");
  assert.doesNotMatch(sw, /addAll\(/, "addAll would precache multiple resources; the contract allows one");
});

test("sw.js only responds to navigations", { skip: killWorkerDeployed }, () => {
  const respondCalls = sw.match(/respondWith\(/g) ?? [];
  assert.equal(respondCalls.length, 1, "expected exactly one respondWith call site");
  assert.match(
    sw,
    /request\.mode !== "navigate"[\s\S]{0,80}return/,
    "the fetch handler must return early for non-navigation requests",
  );
});

test("sw.js keeps the push notification inside waitUntil", { skip: killWorkerDeployed }, () => {
  // Losing this is how iOS push subscriptions get silently revoked: a push
  // with no visible notification counts against the userVisibleOnly promise.
  assert.match(
    sw,
    /event\.waitUntil\(\s*self\.registration\.showNotification/,
    "showNotification must be wrapped in event.waitUntil",
  );
});

test("offline.html is fully self-contained", () => {
  assert.doesNotMatch(offline, /<link[^>]+href/i, "no external stylesheets");
  assert.doesNotMatch(offline, /<script[^>]+src/i, "no external scripts");
  assert.doesNotMatch(offline, /src="(?!data:)/i, "every src must be a data: URI");
  assert.doesNotMatch(offline, /url\(\s*['"]?(?:https?:)?\/\//i, "no external CSS url() references");
  assert.doesNotMatch(offline, /_next\//, "no build-hashed asset paths; they die with each deploy");
  assert.match(offlineRaw, /GENERATED from scripts\/offline-template\.html/, "must be generator output, not a hand edit");
  assert.match(offline, /name="robots" content="noindex"/, "utility page must carry noindex");
});

test("the kill worker parses and carries its sentinel", () => {
  const killRaw = readFileSync(join(REPO_ROOT, "scripts", "pwa", "sw-kill.js"), "utf8");
  const kill = stripJsComments(killRaw);
  assert.match(killRaw, /KILL SWITCH/, "sentinel missing: deploying it would fail the suite above");
  assert.match(kill, /registration\.unregister\(\)/, "the kill worker must unregister itself");
  assert.doesNotMatch(kill, /cache\.add|\.put\(|addAll\(/, "the kill worker must write nothing");
});
