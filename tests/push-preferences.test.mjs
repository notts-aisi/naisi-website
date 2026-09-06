/**
 * Push as a preference axis, and the decision push.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## What is worth executing here
 *
 *  1. **The default, on a LEGACY profile.** `profile.notifications` did not
 *     always exist, and the legacy branch of `normaliseNotifications` returns
 *     `channels` and `categories` and nothing else. Push has to be attached
 *     to both branches or the members who have never saved under the new UI
 *     come out with an undefined map, which reads as "off" at every call
 *     site. Executed, not reasoned about, because the branch is chosen by
 *     which fields happen to be stored.
 *  2. **The asymmetry.** Absent is the default; only a stored `false` turns
 *     a key off. Both directions are asserted, including the awkward case of
 *     a member who has touched the push switches and NOTHING else, whose
 *     document has a `push` map with no `channels` beside it.
 *  3. **The mirrors, against a fake.** A source pin can prove a call is
 *     written; it cannot prove the switch is consulted before the send. Both
 *     mirrors are run for real against a fake Firestore and a fake push
 *     service, so "off means nothing is sent" is a measurement.
 *  4. **The dormant case.** With no VAPID configuration nothing is sent and
 *     nothing is read: the feature is unprovisioned in every environment
 *     until the secrets land (docs/pwa.md), and it must stay silent there.
 *  5. **The guard.** The weekly nudge, the deadline-reminder job and the
 *     stage-release job must never push. Scheduled mail that also buzzes
 *     every phone in a cohort is how people turn notifications off for good,
 *     so the rule is pinned as "these files import nothing from lib/push"
 *     rather than left as a habit.
 *
 * ## The fakes
 *
 * A double, not the emulator, and a stubbed `web-push`: `npm test` must not
 * reach a project and must never put a notification on the wire. The push
 * "service" records what it was handed and returns; every assertion about a
 * send reads that record.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/**
 * The doors to the outside world, replaced. They talk to the tests through
 * `globalThis` rather than through injected arguments because the mirrors
 * resolve them by import, exactly as they do in production.
 */
const STUBS = new Map([
  ["server-only", "export {};"],
  [
    "firebase-admin/firestore",
    "export const FieldValue = { serverTimestamp: () => ({ __sentinel: true }) };\n" +
      "export class Timestamp {\n" +
      "  constructor(date) { this.date = date; }\n" +
      "  toDate() { return this.date; }\n" +
      "}",
  ],
  ["@/lib/firebase/admin", "export const getAdminDb = () => globalThis.__db ?? null;"],
  [
    "web-push",
    "const webpush = {\n" +
      "  setVapidDetails: () => {},\n" +
      "  sendNotification: async (subscription, payload) => {\n" +
      "    (globalThis.__pushes ??= []).push({ endpoint: subscription.endpoint, payload });\n" +
      "    if (globalThis.__pushStatus) {\n" +
      "      const err = new Error('push service refused');\n" +
      "      err.statusCode = globalThis.__pushStatus;\n" +
      "      throw err;\n" +
      "    }\n" +
      "  },\n" +
      "};\n" +
      "export default webpush;",
  ],
]);

/** A FILE, never a directory: `@/lib/devBypass` is both. */
function resolveLocalTs(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, base, join(base, "index.ts")]) {
    if (!existsSync(candidate)) continue;
    if (statSync(candidate).isDirectory()) continue;
    return candidate;
  }
  return null;
}

const graph = new Map();
let tsc = null;

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

function stubUrl(key) {
  const cached = graph.get(key);
  if (cached) return cached;
  const url = dataUrl(STUBS.get(key));
  graph.set(key, url);
  return url;
}

async function transpileToDataUrl(file) {
  if (STUBS.has(file)) return stubUrl(file);
  const cached = graph.get(file);
  if (cached) return cached;

  const { outputText } = tsc.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: tsc.ScriptTarget.ES2022,
      module: tsc.ModuleKind.ESNext,
    },
  });

  const rewrites = new Map();
  for (const [, , , specifier] of outputText.matchAll(SPECIFIER)) {
    if (rewrites.has(specifier)) continue;
    if (STUBS.has(specifier)) {
      rewrites.set(specifier, stubUrl(specifier));
    } else if (specifier.startsWith(".") || specifier.startsWith("@/")) {
      const target = resolveLocalTs(specifier, file);
      if (!target) throw new Error(`cannot resolve "${specifier}" imported from ${file}`);
      rewrites.set(specifier, await transpileToDataUrl(target));
    } else {
      rewrites.set(specifier, import.meta.resolve(specifier));
    }
  }

  const rewritten = outputText.replace(
    SPECIFIER,
    (whole, prefix, quote, specifier) =>
      rewrites.has(specifier)
        ? `${prefix}${quote}${rewrites.get(specifier)}${quote}`
        : whole,
  );
  const url = dataUrl(rewritten);
  graph.set(file, url);
  return url;
}

async function loadTs(relativePath) {
  if (!tsc) {
    try {
      tsc = (await import("typescript")).default;
    } catch (err) {
      throw new Error(
        "the `typescript` devDependency is not installed. Run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

function source(relativePath) {
  return readFileSync(join(REPO_ROOT, ...relativePath.split("/")), "utf8");
}

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// The fake Firestore: one user doc lookup and one subscriptions query.
// ---------------------------------------------------------------------------

function fakeDb({ users = {}, subscriptions = [] } = {}) {
  return {
    collection(name) {
      return {
        doc(id) {
          return {
            get: async () => {
              if (globalThis.__userReadThrows && name === "users") {
                throw new Error(globalThis.__userReadThrows);
              }
              const has = name === "users" && Object.hasOwn(users, id);
              return { exists: has, data: () => (has ? users[id] : undefined) };
            },
            delete: async () => {
              (globalThis.__pruned ??= []).push(id);
            },
          };
        },
        where(field, _op, value) {
          return {
            get: async () => ({
              docs: subscriptions
                .filter((s) => s[field] === value)
                .map((s) => ({ data: () => s })),
            }),
          };
        },
      };
    },
  };
}

const DEVICE = {
  endpoint: "https://push.example/one",
  keys: { p256dh: "p", auth: "a" },
  uid: "u1",
};

function withVapid(on) {
  if (on) {
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "test-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-private-key";
  } else {
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  }
}

function reset({ users, subscriptions } = {}) {
  globalThis.__db = fakeDb({ users, subscriptions });
  globalThis.__pushes = [];
  globalThis.__pruned = [];
  globalThis.__pushStatus = null;
  globalThis.__userReadThrows = null;
  withVapid(true);
}

// ---------------------------------------------------------------------------
// Real imports. Everything below this line is shipping code.
// ---------------------------------------------------------------------------

const {
  ALL_PUSH_KEYS,
  DEFAULT_NOTIFICATION_PREFS,
  PUSH_LABELS,
  normaliseNotifications,
  serialiseNotifications,
  serialisePush,
  setPushPreference,
  wantsPush,
} = await loadTs("lib/firestore/notifications.ts");

const { mirrorTaskEmailToPush } = await loadTs("lib/push/taskNotifications.ts");
const { mirrorCourseDecisionToPush } = await loadTs("lib/push/courseNotifications.ts");
const { wantsPushFor } = await loadTs("lib/push/preferences.ts");

// ---------------------------------------------------------------------------
// 1. The shape and its defaults
// ---------------------------------------------------------------------------

describe("the push preference map", () => {
  test("DEFAULT_NOTIFICATION_PREFS carries push, both keys on", () => {
    assert.deepEqual(DEFAULT_NOTIFICATION_PREFS.push, {
      tasks: true,
      courseDecisions: true,
    });
  });

  test("the keys are exactly the two topics that push", () => {
    assert.deepEqual([...ALL_PUSH_KEYS].sort(), ["courseDecisions", "tasks"]);
    for (const key of ALL_PUSH_KEYS) {
      assert.equal(typeof PUSH_LABELS[key], "string");
      assert.ok(PUSH_LABELS[key].length > 0, `${key} needs a label`);
    }
  });

  test("push is not folded into channels, which is address routing", () => {
    // If push ever became a channel, addressesForSend would try to deliver
    // email to it. The two maps must stay disjoint.
    assert.deepEqual(Object.keys(DEFAULT_NOTIFICATION_PREFS.channels), [
      "gmail",
      "uniEmail",
    ]);
    for (const key of ALL_PUSH_KEYS) {
      assert.ok(
        !(key in DEFAULT_NOTIFICATION_PREFS.channels),
        `${key} must not be a channel`,
      );
      assert.ok(
        !(key in DEFAULT_NOTIFICATION_PREFS.categories),
        `${key} must not be a category`,
      );
    }
  });
});

describe("normaliseNotifications resolves push on every branch", () => {
  test("a LEGACY profile, with no notifications field at all, gets both defaults", () => {
    const prefs = normaliseNotifications({
      newsletter: { subscribed: true, deliverToGmail: true },
    });
    assert.deepEqual(prefs.push, { tasks: true, courseDecisions: true });
    // And the legacy branch really was the one taken.
    assert.equal(prefs.categories.newsletter, true);
    assert.equal(prefs.categories.events, false);
  });

  test("an empty profile gets both defaults", () => {
    assert.deepEqual(normaliseNotifications({}).push, {
      tasks: true,
      courseDecisions: true,
    });
  });

  test("a modern profile with no push key gets both defaults", () => {
    const prefs = normaliseNotifications({
      notifications: {
        channels: { gmail: true, uniEmail: false },
        categories: { newsletter: true, events: false, courses: false },
      },
    });
    assert.deepEqual(prefs.push, { tasks: true, courseDecisions: true });
  });

  test("an explicit false is honoured, one key at a time", () => {
    const prefs = normaliseNotifications({
      notifications: {
        channels: { gmail: true, uniEmail: false },
        categories: { newsletter: false, events: false, courses: false },
        push: { tasks: false },
      },
    });
    assert.equal(prefs.push.tasks, false);
    assert.equal(prefs.push.courseDecisions, true);
  });

  test("a push map with no channels beside it is still honoured", () => {
    // The switches save on toggle, so a member who has touched only those has
    // a document with `push` and nothing else under `notifications`. Reading
    // that as "no modern shape" would silently revert their answer.
    const prefs = normaliseNotifications({
      notifications: { push: { courseDecisions: false } },
    });
    assert.equal(prefs.push.courseDecisions, false);
    assert.equal(prefs.push.tasks, true);
  });

  test("a legacy profile that ALSO carries a push map keeps both answers", () => {
    const prefs = normaliseNotifications({
      newsletter: { subscribed: true },
      notifications: { push: { tasks: false } },
    });
    assert.equal(prefs.push.tasks, false);
    assert.equal(prefs.categories.newsletter, true);
  });

  test("junk in the stored map reads as the default, not as a refusal", () => {
    const prefs = normaliseNotifications({
      notifications: { push: { tasks: "no", courseDecisions: null } },
    });
    assert.deepEqual(prefs.push, { tasks: true, courseDecisions: true });
  });
});

describe("the write shape round-trips", () => {
  test("serialiseNotifications carries push, so a profile save cannot wipe it", () => {
    const stored = normaliseNotifications({
      notifications: {
        channels: { gmail: true, uniEmail: false },
        categories: { newsletter: false, events: false, courses: false },
        push: { tasks: false, courseDecisions: true },
      },
    });
    const written = serialiseNotifications(stored);
    assert.deepEqual(written.push, { tasks: false, courseDecisions: true });
    assert.deepEqual(normaliseNotifications({ notifications: written }).push, {
      tasks: false,
      courseDecisions: true,
    });
  });

  test("serialisePush writes booleans only", () => {
    assert.deepEqual(serialisePush({ tasks: 1, courseDecisions: undefined }), {
      tasks: true,
      courseDecisions: false,
    });
  });

  test("setPushPreference touches one key and no other axis", () => {
    const before = DEFAULT_NOTIFICATION_PREFS;
    const after = setPushPreference(before, "tasks", false);
    assert.equal(after.push.tasks, false);
    assert.equal(after.push.courseDecisions, true);
    assert.deepEqual(after.channels, before.channels);
    assert.deepEqual(after.categories, before.categories);
    assert.equal(before.push.tasks, true, "the input must not be mutated");
  });

  test("wantsPush treats an absent key as yes", () => {
    assert.equal(wantsPush({ push: {} }, "tasks"), true);
    assert.equal(wantsPush({ push: { tasks: false } }, "tasks"), false);
  });
});

// ---------------------------------------------------------------------------
// 2. The server's read
// ---------------------------------------------------------------------------

describe("wantsPushFor", () => {
  test("a member who has never answered is pushed to", async () => {
    reset({ users: { u1: { profile: {} } } });
    assert.equal(await wantsPushFor("u1", "tasks"), true);
  });

  test("a stored false is a no", async () => {
    reset({
      users: { u1: { profile: { notifications: { push: { tasks: false } } } } },
    });
    assert.equal(await wantsPushFor("u1", "tasks"), false);
    assert.equal(await wantsPushFor("u1", "courseDecisions"), true);
  });

  test("a missing user doc falls back to the default", async () => {
    reset({ users: {} });
    assert.equal(await wantsPushFor("ghost", "courseDecisions"), true);
  });

  test("a FAILED read is a no, because we cannot know", async () => {
    reset({ users: { u1: { profile: {} } } });
    globalThis.__userReadThrows = "firestore is down";
    assert.equal(await wantsPushFor("u1", "tasks"), false);
  });
});

// ---------------------------------------------------------------------------
// 3. The mirrors, executed
// ---------------------------------------------------------------------------

describe("mirrorTaskEmailToPush", () => {
  test("pushes when the member has not switched tasks off", async () => {
    reset({ users: { u1: { profile: {} } }, subscriptions: [DEVICE] });
    await mirrorTaskEmailToPush("u1", { title: "T", body: "B", taskId: "task-1" });
    assert.equal(globalThis.__pushes.length, 1);
    const payload = JSON.parse(globalThis.__pushes[0].payload);
    assert.equal(payload.notification.title, "T");
    assert.equal(payload.notification.navigate, "/committee/tasks?task=task-1");
  });

  test("a rooted url override wins over the board", async () => {
    // Worksheets (docs/worksheets.md): the recipient acts on the respond
    // page, not on the card. A push that lands one hop short of the thing it
    // is about is a push people learn to ignore, so the caller may say where
    // it goes.
    reset({ users: { u1: { profile: {} } }, subscriptions: [DEVICE] });
    await mirrorTaskEmailToPush("u1", {
      title: "T",
      body: "B",
      taskId: "task-1",
      url: "/worksheets/respond/circ-1",
    });
    const payload = JSON.parse(globalThis.__pushes[0].payload);
    assert.equal(payload.notification.navigate, "/worksheets/respond/circ-1");
  });

  for (const [what, url] of [
    ["an absolute URL", "https://elsewhere.example/phish"],
    ["a protocol-relative URL", "//elsewhere.example/phish"],
    ["a relative path with no root", "worksheets/respond/circ-1"],
    ["an empty string", ""],
  ]) {
    test(`${what} is refused and the board is used instead`, async () => {
      // The service worker hands this value to `clients.openWindow`, so an
      // off-origin override would open somebody else's page from a
      // notification carrying this site's name and icon. Refused rather than
      // dropped: the member still hears about their task.
      reset({ users: { u1: { profile: {} } }, subscriptions: [DEVICE] });
      await mirrorTaskEmailToPush("u1", {
        title: "T",
        body: "B",
        taskId: "task-1",
        url,
      });
      const payload = JSON.parse(globalThis.__pushes[0].payload);
      assert.equal(payload.notification.navigate, "/committee/tasks?task=task-1");
    });
  }

  test("sends NOTHING when push.tasks is false", async () => {
    reset({
      users: { u1: { profile: { notifications: { push: { tasks: false } } } } },
      subscriptions: [DEVICE],
    });
    await mirrorTaskEmailToPush("u1", { title: "T", body: "B", taskId: "task-1" });
    assert.deepEqual(globalThis.__pushes, []);
  });

  test("switching tasks off leaves course decisions alone", async () => {
    reset({
      users: { u1: { profile: { notifications: { push: { tasks: false } } } } },
      subscriptions: [DEVICE],
    });
    await mirrorTaskEmailToPush("u1", { title: "T", body: "B", taskId: "task-1" });
    await mirrorCourseDecisionToPush("u1", { title: "D", body: "B", url: "/x" });
    assert.equal(globalThis.__pushes.length, 1);
    assert.equal(JSON.parse(globalThis.__pushes[0].payload).notification.title, "D");
  });
});

describe("mirrorCourseDecisionToPush", () => {
  test("pushes the decision, with the tap landing on the given path", async () => {
    reset({ users: { u1: { profile: {} } }, subscriptions: [DEVICE] });
    await mirrorCourseDecisionToPush("u1", {
      title: "A decision on your application",
      body: "There's a decision on your Autumn intake application.",
      url: "/applications/autumn",
    });
    assert.equal(globalThis.__pushes.length, 1);
    const payload = JSON.parse(globalThis.__pushes[0].payload);
    assert.equal(payload.notification.navigate, "/applications/autumn");
  });

  test("sends NOTHING when courseDecisions is false", async () => {
    reset({
      users: {
        u1: { profile: { notifications: { push: { courseDecisions: false } } } },
      },
      subscriptions: [DEVICE],
    });
    await mirrorCourseDecisionToPush("u1", { title: "D", body: "B", url: "/x" });
    assert.deepEqual(globalThis.__pushes, []);
  });

  test("sends NOTHING, and reads nothing, with no VAPID configuration", async () => {
    reset({ users: { u1: { profile: {} } }, subscriptions: [DEVICE] });
    withVapid(false);
    // A user-doc read that would throw proves the preference was never read:
    // the configuration gate has to come first.
    globalThis.__userReadThrows = "must not be reached";
    await mirrorCourseDecisionToPush("u1", { title: "D", body: "B", url: "/x" });
    await mirrorTaskEmailToPush("u1", { title: "T", body: "B", taskId: "t" });
    assert.deepEqual(globalThis.__pushes, []);
    withVapid(true);
  });

  test("a refusing push service never reaches the caller", async () => {
    reset({ users: { u1: { profile: {} } }, subscriptions: [DEVICE] });
    globalThis.__pushStatus = 500;
    await mirrorCourseDecisionToPush("u1", { title: "D", body: "B", url: "/x" });
    // Attempted, failed, swallowed. A committed decision is not a 500.
    assert.equal(globalThis.__pushes.length, 1);
  });

  test("an empty uid is a no-op", async () => {
    reset({ users: { u1: { profile: {} } }, subscriptions: [DEVICE] });
    await mirrorCourseDecisionToPush("", { title: "D", body: "B", url: "/x" });
    assert.deepEqual(globalThis.__pushes, []);
  });
});

// ---------------------------------------------------------------------------
// 4. The call sites, pinned in source
// ---------------------------------------------------------------------------

const DECIDE_ROUTE = "src/app/api/admissions/rounds/[roundId]/decide/route.ts";
const PUBLISH_ROUTE =
  "src/app/api/courses/runs/[runId]/allocation/publish/route.ts";

describe("the decision push is called where it must be", () => {
  const decide = stripComments(source(DECIDE_ROUTE));

  test("the decide route calls the mirror AFTER its transaction", () => {
    const commit = decide.indexOf("runTransaction");
    const push = decide.indexOf("mirrorCourseDecisionToPush(");
    assert.ok(commit !== -1, "the decide route must still run a transaction");
    assert.ok(push !== -1, "the decide route must mirror the decision to push");
    assert.ok(push > commit, "the push must not sit inside the transaction");
  });

  test("BOTH branches push: the call is keyed on the uid, not the address", () => {
    // The email block is guarded on `to.email`; an applicant with no address
    // on file can still have a device. One call serves both branches through
    // a ternary on the decision.
    const push = decide.indexOf("mirrorCourseDecisionToPush(");
    const guard = decide.lastIndexOf("if (to && to.uid)", push);
    assert.ok(guard !== -1 && guard < push, "the push guard must be to.uid");
    const call = decide.slice(push, push + 700);
    assert.match(call, /decision === "appoint"/, "the appoint branch must be named");
    // The decline arm, pinned by its copy rather than by the ternary's colon.
    // A bare `:` matches an object literal, so it proved nothing.
    assert.match(
      call,
      /"A decision on your application"/,
      "the decline arm must still carry its own title",
    );
    assert.match(
      call,
      /There's a decision on your \$\{round\.label\} application/,
      "the decline arm must still carry its own body, naming the round",
    );
  });

  test("the decide route AWAITS the push", () => {
    // Cloud Run may reap work that outlives the response, and the mirror's
    // own contract is that callers await it. A `void` here would be a push
    // that silently stops arriving under load.
    assert.match(decide, /await mirrorCourseDecisionToPush\(/);
    assert.ok(
      !/void\s+mirrorCourseDecisionToPush\(/.test(decide),
      "the decide route must not fire the push and forget it",
    );
  });

  test("the push body never carries the decider's reason", () => {
    const push = decide.indexOf("mirrorCourseDecisionToPush(");
    const call = decide.slice(push, push + 700);
    // Word boundaries: a raw substring test for "note" also fires on
    // "notification", which would fail this for the wrong reason one day.
    for (const forbidden of ["note", "sharedReason", "reasonShared"]) {
      assert.ok(
        !new RegExp(`\\b${forbidden}\\b`).test(call),
        `the push must not carry ${forbidden}: a lock screen is not a private surface`,
      );
    }
  });

  test("the word-boundary guard would still catch the real leak", () => {
    // The guard nobody has seen fail. `note` alone must be caught; `note` as
    // part of a longer word must not be.
    const leak = 'body: note,';
    const innocent = 'body: "a notification about your application",';
    assert.ok(/\bnote\b/.test(leak));
    assert.ok(!/\bnote\b/.test(innocent));
  });

  test("the allocation publish route pushes after it stamps the send", () => {
    const publish = stripComments(source(PUBLISH_ROUTE));
    const stamp = publish.indexOf("allocatedEmailAt: FieldValue.serverTimestamp()");
    const push = publish.indexOf("mirrorCourseDecisionToPush(");
    assert.ok(push !== -1, "publishing an allocation must mirror the placement");
    assert.ok(
      stamp !== -1 && push > stamp,
      "the push must hang off the idempotency stamp so a re-publish cannot repeat it",
    );
  });

  test("the placement push is a second pass, not a step in the email loop", () => {
    const publish = stripComments(source(PUBLISH_ROUTE));
    const pacing = publish.lastIndexOf("await sleep(SLEEP_MS)");
    const push = publish.indexOf("mirrorCourseDecisionToPush(");
    assert.ok(pacing !== -1, "the email loop must still pace its sends");
    assert.ok(
      push > pacing,
      "the push must sit after the email loop: in it, a slow push service eats the budget the emails need",
    );
    assert.match(
      publish,
      /MAX_PUSHES_PER_REQUEST/,
      "the push pass must carry its own per-request cap",
    );
  });
});

// ---------------------------------------------------------------------------
// 4b. The switches are reachable
// ---------------------------------------------------------------------------

describe("the account-level switches do not hide behind the device card", () => {
  const CARD = "src/features/pwa/PushSettings.tsx";
  const PROFILE = "src/app/(app)/profile/page.tsx";

  test("PushTopics is exported and rendered as its own thing on /profile", () => {
    const card = source(CARD);
    assert.match(
      card,
      /export function PushTopics\(/,
      "PushTopics must be exported, not private to the device card",
    );
    const profile = source(PROFILE);
    assert.match(profile, /<PushTopics\s*\/>/, "/profile must render it directly");
  });

  test("PushSettings does not render PushTopics inside its own early return", () => {
    // The regression this pins: PushSettings returns null with no VAPID key
    // and on any browser without push, which is every environment today. A
    // nested PushTopics was therefore unreachable everywhere, even though the
    // preference it edits is about the account and not about this hardware.
    const card = stripComments(source(CARD));
    const settings = card.indexOf("export function PushSettings(");
    const topics = card.indexOf("export function PushTopics(");
    assert.ok(settings !== -1 && topics !== -1);
    const body = card.slice(settings, topics);
    assert.ok(
      !body.includes("<PushTopics"),
      "the device card must not render the account switches",
    );
    assert.match(
      body,
      /if \(!PUBLIC_KEY \|\| state === null \|\| state === "unsupported"\) return null;/,
      "the device card's early return must still be there",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. The guard: scheduled and bulk course mail never pushes
// ---------------------------------------------------------------------------

describe("the never-push list", () => {
  /** Any import of the push tree, by alias or by relative path. */
  const PUSH_IMPORT = /(?:from|import)\s*\(?\s*["'][^"']*(?:@\/lib\/push|\.\.?\/(?:[^"']*\/)?push)[^"']*["']/;

  const NEVER_PUSH = [
    {
      path: "src/app/api/courses/runs/[runId]/nudge/route.ts",
      why: "the weekly reminder goes to a whole cohort on a schedule",
    },
    {
      path: "src/lib/scheduler/jobs/admissionsReminders.ts",
      why: "the deadline reminder is a scheduled nag, not an answer",
    },
    {
      // OPEN OWNER DECISION: the V3 contract says twice that the stage
      // release pushes under `courseDecisions`; this guard says it never
      // pushes. Both cannot be true. Until it is settled the guard stands,
      // because "never" is the reversible answer. The job is being built on
      // a sibling branch, so this entry skips until the file exists and
      // starts biting the moment the branches merge.
      path: "src/lib/scheduler/jobs/admissionsStageRelease.ts",
      why: "a stage opening is an announcement, not a decision",
    },
  ];

  for (const { path, why } of NEVER_PUSH) {
    test(`${path} imports no push helper (${why})`, (t) => {
      if (!existsSync(join(REPO_ROOT, ...path.split("/")))) {
        // Skipping is honest; asserting on a file that does not exist would
        // be a green tick for nothing. The skip is named so a reader can see
        // which rule is currently unguarded rather than assuming all of them
        // ran, and it disappears on its own once the file lands.
        t.skip(`${path} does not exist yet, so there is nothing to guard`);
        return;
      }
      const src = source(path);
      assert.ok(
        !PUSH_IMPORT.test(src),
        `${path} must not import from lib/push: ${why}`,
      );
      for (const helper of [
        "mirrorTaskEmailToPush",
        "mirrorCourseDecisionToPush",
        "sendPushToUid",
      ]) {
        assert.ok(!src.includes(helper), `${path} must not call ${helper}`);
      }
    });
  }

  test("the guard's regex would actually catch a new push import", () => {
    // A guard nobody has seen fail is a guard nobody knows works.
    assert.ok(PUSH_IMPORT.test('import { sendPushToUid } from "@/lib/push/send";'));
    assert.ok(
      PUSH_IMPORT.test(
        'import { mirrorCourseDecisionToPush } from "../../push/courseNotifications";',
      ),
    );
    assert.ok(!PUSH_IMPORT.test('import { sendEmail } from "@/lib/email/send";'));
  });
});
