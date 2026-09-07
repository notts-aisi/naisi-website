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
 *  5. **The guard, in both directions.** The weekly nudge and the deadline
 *     reminders must never push: scheduled mail that also buzzes every phone
 *     in a cohort is how people turn notifications off for good, so the rule
 *     is pinned as "these files import nothing from lib/push" rather than
 *     left as a habit. The stage release is the case that went the other
 *     way. It sat on that list while the owner's decision was open; the
 *     decision came on 6 September 2026 and it was "both", so the entry is
 *     gone and what is pinned in its place is the SHAPE of the push it now
 *     sends: the shared mirror rather than a sender of its own, inside the
 *     one per-recipient claim so a retried tick repeats neither channel, and
 *     wrapped so a push service having a bad day cannot cost an applicant
 *     their email. The runtime proof of those three lives in
 *     `tests/admissions-stage-release.test.mjs`, which has the fake
 *     Firestore the job needs; what is here is the source pin that fails
 *     when somebody unpicks the shape.
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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/** Every .ts/.tsx file under a directory, so a guard can walk the tree. */
function tsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

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
  ALL_CATEGORIES,
  ALL_PUSH_KEYS,
  CATEGORY_LABELS,
  DEFAULT_NOTIFICATION_PREFS,
  OPT_IN_ROWS,
  OPT_OUT_ROWS,
  PUSH_LABELS,
  UNSUBSCRIBABLE_CATEGORIES,
  normaliseNotifications,
  resolveRow,
  serialiseNotifications,
  serialisePush,
  setCategory,
  setPushPreference,
  wantsCategory,
  wantsPush,
} = await loadTs("lib/firestore/notifications.ts");

const { mirrorTaskEmailToPush } = await loadTs("lib/push/taskNotifications.ts");
const { mirrorCourseDecisionToPush } = await loadTs("lib/push/courseNotifications.ts");
const { wantsPushFor } = await loadTs("lib/push/preferences.ts");

// ---------------------------------------------------------------------------
// 1. The shape and its defaults
// ---------------------------------------------------------------------------

describe("the grid's two columns", () => {
  const ROWS = ["newsletter", "events", "courses", "tasks"];

  test("categories and push have the SAME key set, one cell per row", () => {
    // The shape IS a grid: four rows, two columns. A key in one column and
    // not the other is a cell the /profile grid would draw and nothing would
    // store, or store and never draw.
    assert.deepEqual(Object.keys(DEFAULT_NOTIFICATION_PREFS.categories).sort(), [...ROWS].sort());
    assert.deepEqual(Object.keys(DEFAULT_NOTIFICATION_PREFS.push).sort(), [...ROWS].sort());
    assert.deepEqual([...ALL_CATEGORIES].sort(), [...ROWS].sort());
    assert.deepEqual([...ALL_PUSH_KEYS].sort(), [...ROWS].sort());
    for (const row of ALL_CATEGORIES) {
      assert.equal(typeof CATEGORY_LABELS[row], "string");
      assert.ok(CATEGORY_LABELS[row].length > 0, `${row} needs an email label`);
      assert.equal(typeof PUSH_LABELS[row], "string");
      assert.ok(PUSH_LABELS[row].length > 0, `${row} needs a push label`);
    }
  });

  test("neither column holds a channel key, and channels holds only addresses", () => {
    // If push or a category ever became a channel, addressesForSend would try
    // to deliver email to it. `channels` is ADDRESS ROUTING and nothing else.
    assert.deepEqual(Object.keys(DEFAULT_NOTIFICATION_PREFS.channels), [
      "gmail",
      "uniEmail",
    ]);
    for (const channel of ["gmail", "uniEmail"]) {
      assert.ok(
        !(channel in DEFAULT_NOTIFICATION_PREFS.categories),
        `${channel} must not be a row of the email column`,
      );
      assert.ok(
        !(channel in DEFAULT_NOTIFICATION_PREFS.push),
        `${channel} must not be a row of the push column`,
      );
    }
  });

  test("the defaults come from ONE table, applied to both columns", () => {
    assert.deepEqual([...OPT_IN_ROWS].sort(), ["events", "newsletter"]);
    assert.deepEqual([...OPT_OUT_ROWS].sort(), ["courses", "tasks"]);
    assert.deepEqual([...OPT_IN_ROWS, ...OPT_OUT_ROWS].sort(), [...ROWS].sort());
    for (const row of OPT_IN_ROWS) {
      assert.equal(resolveRow(row, undefined), false, `${row} is opt-in`);
      assert.equal(DEFAULT_NOTIFICATION_PREFS.categories[row], false);
      assert.equal(DEFAULT_NOTIFICATION_PREFS.push[row], false);
    }
    for (const row of OPT_OUT_ROWS) {
      assert.equal(resolveRow(row, undefined), true, `${row} is opt-out`);
      assert.equal(resolveRow(row, false), false, `${row} honours a refusal`);
      assert.equal(DEFAULT_NOTIFICATION_PREFS.categories[row], true);
      assert.equal(DEFAULT_NOTIFICATION_PREFS.push[row], true);
    }
  });

  test("the legacy courseDecisions key is READ and never written", () => {
    // The alias exists so a member who answered under the old key keeps their
    // answer. Writing it again would keep a second name for one cell alive
    // forever, and the two would drift the first time only one was updated.
    assert.equal(
      normaliseNotifications({ notifications: { push: { courseDecisions: false } } }).push
        .courses,
      false,
      "the alias must still be readable",
    );
    const files = tsFilesUnder(SRC);
    assert.ok(files.length > 200, "the walk found suspiciously few source files");
    const NOTIFICATIONS = join(SRC, "lib", "firestore", "notifications.ts");
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      if (file !== NOTIFICATIONS) {
        assert.ok(
          !code.includes("courseDecisions"),
          `${file} mentions courseDecisions: the alias is read in notifications.ts alone`,
        );
        continue;
      }
      // Inside the module: the read path may name it, the write path may not.
      const writer = code.slice(code.indexOf("export function serialisePush"));
      assert.ok(writer.length > 100, "serialisePush moved");
      assert.ok(
        !writer.includes("courseDecisions"),
        "serialisePush and serialiseNotifications must never write the alias",
      );
      assert.ok(
        code.includes("stored?.courseDecisions"),
        "the alias must still be read off the stored map",
      );
    }
  });
});

describe("normaliseNotifications, every stored shape", () => {
  const DEFAULTS = { newsletter: false, events: false, courses: true, tasks: true };

  test("no profile at all", () => {
    const prefs = normaliseNotifications({});
    assert.deepEqual(prefs.categories, DEFAULTS);
    assert.deepEqual(prefs.push, DEFAULTS);
    assert.deepEqual(prefs.channels, { gmail: true, uniEmail: false });
  });

  test("legacy newsletter, subscribed TRUE", () => {
    const prefs = normaliseNotifications({
      newsletter: { subscribed: true, deliverToGmail: true, deliverToUniEmail: true },
    });
    assert.deepEqual(prefs.categories, {
      newsletter: true,
      events: false,
      // The legacy shape cannot express a refusal on these two, so they
      // resolve ON. A false here would invent an opt-out nobody made.
      courses: true,
      tasks: true,
    });
    assert.deepEqual(prefs.channels, { gmail: true, uniEmail: true });
    assert.deepEqual(prefs.push, DEFAULTS);
  });

  test("legacy newsletter, subscribed FALSE, still gets the opt-out rows", () => {
    const prefs = normaliseNotifications({ newsletter: { subscribed: false } });
    assert.equal(prefs.categories.newsletter, false);
    assert.equal(prefs.categories.courses, true);
    assert.equal(prefs.categories.tasks, true);
  });

  test("legacy with deliverToGmail undefined defaults the inbox on", () => {
    const prefs = normaliseNotifications({ newsletter: { subscribed: true } });
    assert.equal(prefs.channels.gmail, true);
    assert.equal(prefs.channels.uniEmail, false);
  });

  test("modern with CHANNELS only", () => {
    const prefs = normaliseNotifications({
      notifications: { channels: { gmail: false, uniEmail: true } },
    });
    assert.deepEqual(prefs.channels, { gmail: false, uniEmail: true });
    // No categories stored: every row resolves to its own default, so the
    // opt-out rows stay on rather than being silenced by an absent map.
    assert.deepEqual(prefs.categories, DEFAULTS);
    assert.deepEqual(prefs.push, DEFAULTS);
  });

  test("modern with CATEGORIES only", () => {
    const prefs = normaliseNotifications({
      notifications: { categories: { newsletter: true, tasks: false } },
    });
    assert.deepEqual(prefs.categories, {
      newsletter: true,
      events: false,
      courses: true,
      tasks: false,
    });
    // The modern branch was taken, so channels come from an absent map.
    assert.deepEqual(prefs.channels, { gmail: false, uniEmail: false });
  });

  test("modern with PUSH only is still honoured", () => {
    // The push switches save on toggle, so a member who has touched only
    // those has a document with `push` and nothing else under
    // `notifications`. Reading that as "no modern shape" would silently
    // revert their answer.
    const prefs = normaliseNotifications({ notifications: { push: { tasks: false } } });
    assert.equal(prefs.push.tasks, false);
    assert.equal(prefs.push.courses, true);
    // No channels and no categories: the LEGACY-or-default branch runs for
    // the email half, so the opt-out rows still resolve on.
    assert.deepEqual(prefs.categories, DEFAULTS);
  });

  test("a legacy profile that ALSO carries a push map keeps both answers", () => {
    const prefs = normaliseNotifications({
      newsletter: { subscribed: true },
      notifications: { push: { tasks: false } },
    });
    assert.equal(prefs.push.tasks, false);
    assert.equal(prefs.categories.newsletter, true);
  });

  test("push.courseDecisions false with no push.courses turns the courses push off", () => {
    const prefs = normaliseNotifications({
      notifications: { push: { courseDecisions: false } },
    });
    assert.equal(prefs.push.courses, false);
    assert.equal(prefs.push.tasks, true);
  });

  test("an explicit push.courses WINS over the alias, in both directions", () => {
    assert.equal(
      normaliseNotifications({
        notifications: { push: { courses: true, courseDecisions: false } },
      }).push.courses,
      true,
    );
    assert.equal(
      normaliseNotifications({
        notifications: { push: { courses: false, courseDecisions: true } },
      }).push.courses,
      false,
    );
  });

  test("junk in every slot reads as the row's default, never as an answer", () => {
    const prefs = normaliseNotifications({
      notifications: {
        channels: { gmail: "yes", uniEmail: null },
        categories: { newsletter: null, events: 0, courses: "no", tasks: {} },
        push: { newsletter: undefined, events: [], courses: 1, tasks: "no" },
      },
    });
    // Opt-in rows need a truthy value; opt-out rows need a literal false.
    assert.deepEqual(prefs.categories, {
      newsletter: false,
      events: false,
      courses: true,
      tasks: true,
    });
    assert.deepEqual(prefs.push, {
      newsletter: false,
      events: true,
      courses: true,
      tasks: true,
    });
    assert.deepEqual(prefs.channels, { gmail: true, uniEmail: false });
  });

  test("an explicit false is a refusal on EACH opt-out row, one at a time", () => {
    for (const row of OPT_OUT_ROWS) {
      const email = normaliseNotifications({
        notifications: { channels: { gmail: true }, categories: { [row]: false } },
      });
      assert.equal(email.categories[row], false, `${row} email must honour the false`);
      for (const other of OPT_OUT_ROWS) {
        if (other !== row) assert.equal(email.categories[other], true);
      }
      const push = normaliseNotifications({ notifications: { push: { [row]: false } } });
      assert.equal(push.push[row], false, `${row} push must honour the false`);
    }
  });

  test("absent is OFF on each opt-in row and ON on each opt-out row", () => {
    const prefs = normaliseNotifications({
      notifications: { channels: { gmail: true }, categories: {}, push: {} },
    });
    for (const row of OPT_IN_ROWS) {
      assert.equal(prefs.categories[row], false, `${row} email must default off`);
      assert.equal(prefs.push[row], false, `${row} push must default off`);
    }
    for (const row of OPT_OUT_ROWS) {
      assert.equal(prefs.categories[row], true, `${row} email must default on`);
      assert.equal(prefs.push[row], true, `${row} push must default on`);
    }
  });

  test("wantsCategory and wantsPush read the same table", () => {
    const prefs = normaliseNotifications({});
    for (const row of OPT_IN_ROWS) {
      assert.equal(wantsCategory(prefs, row), false);
      assert.equal(wantsPush(prefs, row), false);
    }
    for (const row of OPT_OUT_ROWS) {
      assert.equal(wantsCategory(prefs, row), true);
      assert.equal(wantsPush(prefs, row), true);
    }
    assert.equal(wantsPush({ push: {} }, "tasks"), true);
    assert.equal(wantsPush({ push: { tasks: false } }, "tasks"), false);
    assert.equal(wantsCategory({ categories: {} }, "newsletter"), false);
  });
});

describe("the write shape round-trips", () => {
  test("every stored answer survives serialise then normalise", () => {
    const stored = normaliseNotifications({
      notifications: {
        channels: { gmail: true, uniEmail: true },
        categories: { newsletter: true, events: false, courses: false, tasks: false },
        push: { newsletter: true, events: false, courses: false, tasks: true },
      },
    });
    const written = serialiseNotifications(stored);
    assert.deepEqual(written, stored, "the write shape is the read shape");
    assert.deepEqual(normaliseNotifications({ notifications: written }), stored);
  });

  test("serialiseNotifications carries push, so a profile save cannot wipe it", () => {
    const stored = normaliseNotifications({
      notifications: {
        channels: { gmail: true, uniEmail: false },
        categories: { newsletter: false, events: false, courses: false, tasks: true },
        push: { tasks: false, courses: true },
      },
    });
    assert.deepEqual(serialiseNotifications(stored).push, {
      newsletter: false,
      events: false,
      courses: true,
      tasks: false,
    });
  });

  test("serialisePush writes four booleans and drops the alias", () => {
    const written = serialisePush({ tasks: 1, courses: undefined, courseDecisions: true });
    assert.deepEqual(written, {
      newsletter: false,
      events: false,
      courses: false,
      tasks: true,
    });
    assert.ok(!("courseDecisions" in written));
  });

  test("setPushPreference and setCategory touch one cell and no other axis", () => {
    const before = DEFAULT_NOTIFICATION_PREFS;
    const after = setPushPreference(before, "tasks", false);
    assert.equal(after.push.tasks, false);
    assert.equal(after.push.courses, true);
    assert.deepEqual(after.channels, before.channels);
    assert.deepEqual(after.categories, before.categories);
    assert.equal(before.push.tasks, true, "the input must not be mutated");

    const emailed = setCategory(before, "tasks", false);
    assert.equal(emailed.categories.tasks, false);
    assert.deepEqual(emailed.push, before.push, "the email cell must not move the push cell");
  });
});

describe("a marketing unsubscribe link cannot silence task mail", () => {
  test("UNSUBSCRIBABLE_CATEGORIES is the three bulk rows", () => {
    assert.deepEqual(UNSUBSCRIBABLE_CATEGORIES, ["newsletter", "events", "courses"]);
    assert.ok(
      !UNSUBSCRIBABLE_CATEGORIES.includes("tasks"),
      "an unsubscribe footer must never switch off review requests and mentions",
    );
  });

  test("/api/unsubscribe iterates it, never ALL_CATEGORIES", () => {
    const route = stripComments(source("src/app/api/unsubscribe/route.ts"));
    assert.ok(
      route.includes("UNSUBSCRIBABLE_CATEGORIES"),
      "the route must iterate the unsubscribable rows",
    );
    assert.ok(
      !route.includes("ALL_CATEGORIES"),
      "an `all` token must mean all the BULK mail, not every row in the grid",
    );
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
    assert.equal(await wantsPushFor("u1", "courses"), true);
  });

  test("a missing user doc falls back to the default", async () => {
    reset({ users: {} });
    assert.equal(await wantsPushFor("ghost", "courses"), true);
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

  test("sends NOTHING when the courses push cell is false", async () => {
    reset({
      users: { u1: { profile: { notifications: { push: { courses: false } } } } },
      subscriptions: [DEVICE],
    });
    await mirrorCourseDecisionToPush("u1", { title: "D", body: "B", url: "/x" });
    assert.deepEqual(globalThis.__pushes, []);
  });

  test("sends NOTHING when only the LEGACY courseDecisions key says no", async () => {
    // The rename must not re-enable a push somebody already switched off.
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

  test("a recipient with no device sends nothing and says nothing about it", async () => {
    // The ordinary case for almost everybody, and the one a scheduler job
    // leans on: an applicant with no enabled device costs one preference read
    // and one subscriptions query, and the caller cannot tell the difference
    // between that and a delivered push. Neither can throw, so neither can
    // cost the email the push mirrors.
    reset({ users: { u1: { profile: {} } }, subscriptions: [] });
    await mirrorCourseDecisionToPush("u1", { title: "D", body: "B", url: "/x" });
    assert.deepEqual(globalThis.__pushes, []);
  });

  test("an applicant with NO user doc still gets the push", async () => {
    // An applicant is not necessarily a member: the row a scheduler job holds
    // is an application, and the account behind it may carry no stored
    // preferences at all. Absent is the default, so the person who enabled a
    // device and never opened /profile is pushed, exactly as task mail
    // already assumes.
    reset({ users: {}, subscriptions: [DEVICE] });
    await mirrorCourseDecisionToPush("u1", { title: "D", body: "B", url: "/x" });
    assert.equal(globalThis.__pushes.length, 1);
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

// ---------------------------------------------------------------------------
// 6. The other direction: the stage release DOES push, and in one shape
// ---------------------------------------------------------------------------

describe("the stage-release announcement pushes, through the shared mirror", () => {
  const JOB = "src/lib/scheduler/jobs/admissionsStageRelease.ts";
  const code = stripComments(source(JOB));

  test("it reaches for the shared mirror and for no sender of its own", () => {
    // The mirror is where the VAPID gate, the `courses` push cell, the
    // subscriptions query and the dead-endpoint prune live. A job that
    // assembled its own would be a second copy of all four, and one of them
    // would be wrong first.
    assert.match(
      code,
      /import \{ mirrorCourseDecisionToPush \} from "@\/lib\/push\/courseNotifications";/,
      "the stage-release job must push through the shared mirror",
    );
    for (const bespoke of ["sendPushToUid", "web-push", "webpush", "subscriptionsForUid"]) {
      assert.ok(
        !code.includes(bespoke),
        `the stage-release job must not reach ${bespoke} directly`,
      );
    }
  });

  test("the push rides a send, between that send and that person's stamp", () => {
    // THE DUPLICATE RULE. One per-recipient marker is claimed before both
    // legs and stamped after both, so a retried tick that finds it stamped
    // repeats neither. A push before the claim could be sent twice; a push
    // after the stamp could be lost by the crash the stamp exists to survive.
    const body = code.slice(
      code.indexOf("async function mailCandidate("),
      code.indexOf("async function pushCandidate("),
    );
    assert.ok(body.length > 400, "could not slice mailCandidate out of the job");
    const claim = body.indexOf("await claim(");
    const send = body.indexOf("await sendAdmissionEmail(");
    const sent = body.indexOf('if (outcome === "sent")');
    // The LAST handoff. The first belongs to the push-only lane below, which
    // runs before any email precisely because its email is not going.
    const push = body.lastIndexOf("await pushCandidate(");
    const stamp = body.indexOf("await stampSentOrSettle(");
    for (const [what, at] of [
      ["claim", claim],
      ["send", send],
      ["sent check", sent],
      ["push", push],
      ["stamp", stamp],
    ]) {
      assert.ok(at !== -1, `the job no longer has a ${what}`);
    }
    assert.ok(claim < send, "the send runs before the claim");
    assert.ok(send < sent && sent < push, "the push does not ride a successful send");
    assert.ok(push < stamp, "the marker is stamped before the push");
  });

  test("the EMAIL cell does not gate the push: an opted-out applicant is still pushed", () => {
    // Two cells, two answers. `hasOptedOutOfCourseAnnouncements` is the
    // courses row's EMAIL cell inverted, so reading it as a refusal of both
    // would silence a push whose switch reads on, and the push cell would mean
    // nothing on the one row that has a scheduled sender behind it.
    const body = code.slice(
      code.indexOf("async function mailCandidate("),
      code.indexOf("async function pushCandidate("),
    );
    const branch = body.indexOf("if (resolved.skip === OPTED_OUT_REASON) {");
    assert.ok(branch !== -1, "the opted-out skip has no lane of its own");
    const push = body.indexOf("await pushCandidate(", branch);
    const skipStamp = body.indexOf("await stampSkipped(", branch);
    assert.ok(push !== -1 && push < skipStamp, "the opted-out lane pushes after it settles");
    // And the mailbox skips are NOT in that lane: a suppressed address or a
    // missing one is a fact rather than an answer, and stops the announcement
    // whole. The runtime proof of both is in tests/admissions-stage-release.
    assert.ok(
      !/resolved\.skip === "suppressed"/.test(body),
      "a suppressed mailbox has grown a push lane without a decision to give it one",
    );
  });

  test("a push failure is counted and logged, never thrown, never a failed send", () => {
    // A push service having a bad day must not leave a marker unstamped: an
    // unstamped marker is a re-claim, and a re-claim is a second email. It
    // must not reach `summary.failures` either, which the release receipt
    // renders as "failed" and an admin reads as "somebody was not told".
    const body = code.slice(
      code.indexOf("async function pushCandidate("),
      code.indexOf("async function stampSentOrSettle("),
    );
    assert.ok(body.length > 150, "could not slice pushCandidate out of the job");
    assert.match(body, /catch \(err\) \{/, "the push handoff is not wrapped");
    assert.match(body, /summary\.pushFailed \+= 1;/, "a failed push is not counted");
    assert.match(body, /ctx\.log\(/, "a failed push is not logged");
    assert.ok(!/throw/.test(body), "a failed push throws into the per-recipient loop");
    assert.ok(
      !/summary\.failures/.test(body),
      "a failed push is recorded as a failed send",
    );
  });

  test("the payload is the round and the stage, on a same-origin path", () => {
    // A push renders on a lock screen. The round's name and the stage's title
    // are what tells the applicant it is theirs; a question, an intro or a
    // deadline belongs behind the account. The destination is a PATH, and the
    // one the email's own button is built from: the service worker hands it
    // to clients.openWindow, so an absolute url would let a notification
    // wearing this site's name open somebody else's page.
    const call = code.slice(
      code.indexOf("await mirrorCourseDecisionToPush("),
      code.indexOf("summary.pushed += 1;"),
    );
    assert.ok(call.length > 60, "could not slice the push call out of the job");
    assert.match(call, /stage\.label/, "the push does not name the stage");
    assert.match(call, /round\.label/, "the push does not name the round");
    assert.match(call, /admissionApplicationPath\(round\.id, "apply"\)/);
    for (const leak of ["questions", "intro", "deadline", "answers"]) {
      assert.ok(
        !new RegExp(`\\b${leak}\\b`).test(call),
        `the push must not carry ${leak}: a lock screen is not a private surface`,
      );
    }
  });
});
