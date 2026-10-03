/**
 * The signup tracker says "Completed" only when a profile exists.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * WHY THIS FILE EXISTS. For the email sign-up route the tracker used to call a
 * registration completed the moment a password was set. The profile form comes
 * AFTER the password, and on production the sign-in between the two was
 * refused for every email sign-up (the project's Email/Password provider was
 * switched off). Nobody reached the form, nothing reached Approvals, and the
 * admin tab reported each stranded person as done. The tracker was the one
 * screen that could have shown the failure, and it said the opposite.
 *
 * The class is A STATUS THAT CLAIMS MORE THAN THE DATA PROVES, and it has four
 * places to come back from, each held here:
 *
 *  1. THE RULE. `deriveRegistrationStatus` returns "completed" only with a
 *     profile, for every method and every combination of flags.
 *  2. THE STORED WORD. Rows written before the rule changed still store
 *     "completed" beside a password and no profile. Nothing that shows or
 *     counts a status may read that word back, so the view derives it again
 *     and no query in the tree selects on it.
 *  3. THE FLAG. `profileComplete` is a mirror the browser asks the server to
 *     set. The server looks for the document before it sets it, and the list
 *     an admin acts on looks the document up for every row rather than
 *     trusting the mirror in either direction.
 *  4. THE COUNTS. The whole-collection numbers add up to the total with stale
 *     rows landing where their flags put them, with no backfill.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";
import { stripSource } from "./lib/stripSource.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");
const posix = (file) => relative(REPO_ROOT, file).split("\\").join("/");
const codeOf = (path) => stripSource(readFileSync(join(REPO_ROOT, path), "utf8"), { keepStrings: true });

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

// ---------------------------------------------------------------------------
// A Firestore small enough to read: the handful of calls these routes make.
// ---------------------------------------------------------------------------

/** path -> data. Reset before every test. */
const store = new Map();
/** Every read the code under test made, so a test can say what was NOT read. */
const reads = [];

const millis = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : v instanceof Date ? v.getTime() : v);

function snapOf(collection, id) {
  const data = store.get(`${collection}/${id}`);
  return {
    id,
    exists: data !== undefined,
    data: () => (data === undefined ? undefined : { ...data }),
    get: (field) => (data === undefined ? undefined : data[field]),
  };
}

function queryOf(collection, filters = [], order = null, after = null, max = Infinity) {
  const rows = () => {
    let out = [...store.entries()]
      .filter(([path]) => path.startsWith(`${collection}/`) && path.split("/").length === 2)
      .map(([path]) => path.split("/")[1]);
    for (const [field, op, value] of filters) {
      out = out.filter((id) => {
        const got = store.get(`${collection}/${id}`)[field];
        // A document with no such field is in no index for it, so it matches
        // no filter on it. This is the behaviour the counts have to survive.
        if (got === undefined) return false;
        if (op === "==") return got === value;
        if (op === ">=") return millis(got) >= millis(value);
        if (op === "in") return value.includes(got);
        throw new Error(`the fake has no "${op}" operator`);
      });
    }
    if (order) {
      const [field, direction] = order;
      out = out.filter((id) => store.get(`${collection}/${id}`)[field] !== undefined);
      out.sort((a, b) => {
        const x = millis(store.get(`${collection}/${a}`)[field]);
        const y = millis(store.get(`${collection}/${b}`)[field]);
        return direction === "desc" ? y - x : x - y;
      });
    }
    if (after) out = out.slice(out.indexOf(after) + 1);
    return out.slice(0, max);
  };
  return {
    where: (field, op, value) => queryOf(collection, [...filters, [field, op, value]], order, after, max),
    orderBy: (field, direction = "asc") => queryOf(collection, filters, [field, direction], after, max),
    startAfter: (snap) => queryOf(collection, filters, order, snap.id, max),
    limit: (n) => queryOf(collection, filters, order, after, n),
    select: () => queryOf(collection, filters, order, after, max),
    doc: (id) => ({
      id,
      path: `${collection}/${id}`,
      collection,
      get: async () => {
        reads.push(`get ${collection}/${id}`);
        return snapOf(collection, id);
      },
      update: async (patch) => {
        if (!store.has(`${collection}/${id}`)) throw new Error("NOT_FOUND");
        store.set(`${collection}/${id}`, { ...store.get(`${collection}/${id}`), ...patch });
      },
    }),
    get: async () => {
      reads.push(`query ${collection} ${JSON.stringify(filters)}`);
      return { docs: rows().map((id) => snapOf(collection, id)) };
    },
    count: () => ({
      get: async () => {
        reads.push(`count ${collection} ${JSON.stringify(filters.map(([f, op, v]) => [f, op, typeof v === "object" ? "<time>" : v]))}`);
        return { data: () => ({ count: rows().length }) };
      },
    }),
  };
}

const fakeDb = {
  collection: (name) => queryOf(name),
  getAll: async (...args) => {
    const refs = args.filter((a) => a && typeof a.path === "string");
    const options = args.find((a) => a && Array.isArray(a.fieldMask));
    reads.push(`getAll ${refs.map((r) => r.path).join(",")}`);
    return refs.map((r) => {
      const snap = snapOf(r.collection, r.id);
      if (!options) return snap;
      // What Firestore does with a field mask: the document still EXISTS, and
      // only the masked fields come back. A lookup that leaned on the data
      // rather than on `exists` would find nobody.
      const masked = Object.fromEntries(Object.entries(snap.data() ?? {}).filter(([k]) => options.fieldMask.includes(k)));
      return { ...snap, data: () => (snap.exists ? masked : undefined), get: (field) => masked[field] };
    });
  },
};

globalThis.__regFakeDb = fakeDb;
globalThis.__regActor = null;
globalThis.__regSessionUid = null;
globalThis.__regLookupThrows = false;

const STUBS = [
  ["server-only", "export {};"],
  [
    "next/server",
    "export const NextResponse = { json(body, init) { return { status: (init && init.status) || 200, json: async () => body }; } };",
  ],
  ["@/lib/firebase/admin", "export function getAdminDb() { return globalThis.__regFakeDb; }"],
  [
    "@/lib/firebase/session",
    "export async function getCurrentUser() { return globalThis.__regActor; }\n" +
      "export async function getSessionUid() { return globalThis.__regSessionUid ? { uid: globalThis.__regSessionUid } : null; }",
  ],
  ["@/lib/firebase/impersonation", "export async function assertNotImpersonating() { return null; }"],
];

const { loadTs } = createLoader({ stubs: STUBS });
const {
  deriveRegistrationStatus,
  toRegistrationView,
  registrationCounts,
  REGISTRATION_STATUS_META,
  ORPHAN_STATUSES,
} = await loadTs("lib/firestore/registrations.ts");
const { uidsWithProfile } = await loadTs("lib/firestore/registrationProfiles.ts");
const { markRegistrationPasswordSet, markRegistrationProfileComplete } = await loadTs(
  "lib/firestore/registrationWrites.ts",
);
const listRoute = await loadTs("app/api/admin/registrations/route.ts");
const summaryRoute = await loadTs("app/api/admin/registrations/summary/route.ts");
const flipRoute = await loadTs("app/api/register/profile-complete/route.ts");

const at = (iso) => ({ toMillis: () => Date.parse(iso), toDate: () => new Date(iso) });

/** A registration row as the write helpers leave it. */
function row(uid, overrides = {}) {
  store.set(`registrations/${uid}`, {
    uid,
    email: `${uid}@example.org`,
    audience: "member",
    method: "email",
    emailVerified: false,
    passwordSet: false,
    profileComplete: false,
    status: "pending-verify",
    createdAt: at("2026-09-01T10:00:00Z"),
    updatedAt: at("2026-09-01T10:00:00Z"),
    lastSentAt: at("2026-09-01T10:00:00Z"),
    sendCount: 1,
    ...overrides,
  });
}
// As the app writes it: a profile document is NAMED by its uid and does not
// repeat the uid inside.
const member = (uid) => store.set(`users/${uid}`, { role: "pending", email: `${uid}@example.org` });
const collaborator = (uid) => store.set(`collaborators/somebody__${uid}`, { uid, status: "pending" });

beforeEach(() => {
  store.clear();
  reads.length = 0;
  globalThis.__regActor = { uid: "admin-1", role: "admin" };
  globalThis.__regSessionUid = null;
});

// ---------------------------------------------------------------------------
// 1. The rule
// ---------------------------------------------------------------------------

describe("completed means a profile exists", () => {
  const flagSets = [];
  for (const emailVerified of [false, true]) {
    for (const passwordSet of [false, true]) {
      for (const profileComplete of [false, true]) flagSets.push({ emailVerified, passwordSet, profileComplete });
    }
  }

  test("for every method and every combination of flags", () => {
    for (const method of ["email", "google"]) {
      for (const flags of flagSets) {
        const status = deriveRegistrationStatus(method, flags);
        assert.equal(
          status === "completed",
          flags.profileComplete,
          `${method} ${JSON.stringify(flags)} derived "${status}"`,
        );
      }
    }
  });

  test("an email sign-up with a password and no profile is not finished", () => {
    assert.equal(
      deriveRegistrationStatus("email", { emailVerified: true, passwordSet: true, profileComplete: false }),
      "pending-profile",
    );
    assert.ok(ORPHAN_STATUSES.includes("pending-profile"), "an unfinished row must be findable as one");
  });

  test("the earlier steps of the email route read as before", () => {
    assert.equal(deriveRegistrationStatus("email", {}), "pending-verify");
    assert.equal(deriveRegistrationStatus("email", { emailVerified: true }), "verified-no-password");
    assert.equal(deriveRegistrationStatus("google", {}), "pending-profile");
  });

  test("a profile finishes an email row that never set a password", () => {
    // The owner signed in with Google afterwards and filled in the form.
    assert.equal(
      deriveRegistrationStatus("email", { emailVerified: true, passwordSet: false, profileComplete: true }),
      "completed",
    );
  });

  test("only one label says Completed, and it is that status's", () => {
    const saying = Object.entries(REGISTRATION_STATUS_META).filter(([, meta]) => /complete/i.test(meta.label));
    assert.deepEqual(saying.map(([status]) => status), ["completed"]);
  });
});

// ---------------------------------------------------------------------------
// 2. The stored word
// ---------------------------------------------------------------------------

describe("nothing reads the stored status back", () => {
  test("a row that stores the old meaning is shown by its flags", () => {
    const stale = { method: "email", emailVerified: true, passwordSet: true, profileComplete: false, status: "completed" };
    assert.equal(toRegistrationView("u1", stale).status, "pending-profile");
  });

  test("a row from before the method and profile fields existed is an email row with no profile", () => {
    const legacy = { emailVerified: true, passwordSet: true, status: "completed" };
    const view = toRegistrationView("u1", legacy);
    assert.equal(view.method, "email");
    assert.equal(view.status, "pending-profile");
  });

  test("the write helpers store the new meaning", async () => {
    row("u1", { emailVerified: true, status: "verified-no-password" });
    await markRegistrationPasswordSet("u1");
    assert.equal(store.get("registrations/u1").passwordSet, true);
    assert.equal(store.get("registrations/u1").status, "pending-profile");
    await markRegistrationProfileComplete("u1");
    assert.equal(store.get("registrations/u1").status, "completed");
  });

  test("setting a password on a row that already has a profile leaves it completed", async () => {
    row("u1", { emailVerified: true, profileComplete: true, status: "completed" });
    await markRegistrationPasswordSet("u1");
    assert.equal(store.get("registrations/u1").status, "completed");
  });

  test("no query in src selects registrations on a status that can be stale", () => {
    // The two early statuses never changed meaning, so the stored word is
    // still true for them. "completed" and "pending-profile" are the two the
    // change moved rows between, and a variable could be either.
    const STILL_TRUE = new Set(['"pending-verify"', '"verified-no-password"']);
    const offenders = [];
    let inspected = 0;
    for (const file of walk(SRC)) {
      const code = stripSource(readFileSync(file, "utf8"), { keepStrings: true });
      if (!/REGISTRATIONS_COLLECTION/.test(code)) continue;
      for (const m of code.matchAll(/\.where\(\s*"status"\s*,\s*"([^"]+)"\s*,\s*([^)]+?)\s*\)/g)) {
        inspected += 1;
        if (m[1] !== "==" || !STILL_TRUE.has(m[2])) offenders.push(`${posix(file)}: where("status", "${m[1]}", ${m[2]})`);
      }
    }
    assert.ok(inspected > 0, "the walk found no status filter at all, so it is not reading the summary route");
    assert.deepEqual(
      offenders,
      [],
      "A registration row's stored status is wrong on every email row with a password and no " +
        "profile written before October 2026. Count or select on the profileComplete flag, or " +
        "derive the status from the flags after reading.",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The flag is a mirror; the document is the fact
// ---------------------------------------------------------------------------

describe("the profile lookup", () => {
  test("finds a member by document id and a collaborator by its uid field", async () => {
    member("m1");
    collaborator("c1");
    const found = await uidsWithProfile(fakeDb, ["m1", "c1", "nobody"]);
    assert.deepEqual([...found].sort(), ["c1", "m1"]);
  });

  test("asks about collaborators thirty at a time, and only for accounts with no member profile", async () => {
    const uids = Array.from({ length: 65 }, (_, i) => `u${i}`);
    member("u0");
    await uidsWithProfile(fakeDb, uids);
    const collaboratorQueries = reads.filter((r) => r.startsWith("query collaborators"));
    assert.equal(collaboratorQueries.length, 3, "64 accounts left over is three filters of at most thirty");
    for (const q of collaboratorQueries) {
      const values = JSON.parse(q.slice("query collaborators ".length))[0][2];
      assert.ok(values.length <= 30, `an "in" filter carried ${values.length} values`);
      assert.ok(!values.includes("u0"), "an account already found as a member was asked about again");
    }
  });

  test("reads nothing when there is nobody to look up", async () => {
    assert.equal((await uidsWithProfile(fakeDb, [])).size, 0);
    assert.deepEqual(reads, []);
  });
});

describe("the list an admin acts on reports the document, not the mirror", () => {
  async function list() {
    const res = await listRoute.GET(new Request("https://naisi.test/api/admin/registrations?limit=100"));
    assert.equal(res.status, 200);
    const body = await res.json();
    return Object.fromEntries(body.rows.map((r) => [r.uid, r]));
  }

  test("a stranded email sign-up reads No profile yet, whatever its row stores", async () => {
    row("stranded", { emailVerified: true, passwordSet: true, status: "completed" });
    const rows = await list();
    assert.equal(rows.stranded.status, "pending-profile");
    assert.equal(rows.stranded.profileComplete, false);
    assert.equal(REGISTRATION_STATUS_META[rows.stranded.status].label, "No profile yet");
  });

  test("a finished registration whose flip was lost still reads Completed", async () => {
    row("lost-flip", { emailVerified: true, passwordSet: true, status: "pending-profile" });
    member("lost-flip");
    const rows = await list();
    assert.equal(rows["lost-flip"].status, "completed");
    assert.equal(rows["lost-flip"].profileComplete, true);
  });

  test("a flag with no document behind it does not read Completed", async () => {
    row("flag-only", { method: "google", emailVerified: true, profileComplete: true, status: "completed" });
    const rows = await list();
    assert.equal(rows["flag-only"].status, "pending-profile");
  });

  test("a collaborator's profile counts", async () => {
    row("collab", { audience: "collaborator", emailVerified: true, passwordSet: true, status: "completed" });
    collaborator("collab");
    assert.equal((await list()).collab.status, "completed");
  });

  test("someone who is not an admin gets nothing, and nothing is read for them", async () => {
    row("stranded", { emailVerified: true, passwordSet: true, status: "completed" });
    for (const actor of [null, { uid: "m", role: "member" }, { uid: "c", role: "committee" }]) {
      globalThis.__regActor = actor;
      reads.length = 0;
      const res = await listRoute.GET(new Request("https://naisi.test/api/admin/registrations"));
      assert.equal(res.status, 403);
      assert.deepEqual(reads, []);
    }
  });

  test("every registration view built in a route is given the lookup", () => {
    const offenders = [];
    let calls = 0;
    for (const file of walk(join(SRC, "app", "api"))) {
      const code = stripSource(readFileSync(file, "utf8"), { keepStrings: true });
      for (const m of code.matchAll(/toRegistrationView\(/g)) {
        calls += 1;
        // Read the call's arguments by matching its brackets.
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (; end < code.length; end += 1) {
          if (code[end] === "(") depth += 1;
          if (code[end] === ")" && (depth -= 1) === 0) break;
        }
        const args = code.slice(m.index + m[0].length, end);
        if (!/hasProfile\s*:/.test(args)) offenders.push(posix(file));
      }
    }
    assert.ok(calls > 0, "no route builds a registration view: the walk is reading the wrong tree");
    assert.deepEqual(
      offenders,
      [],
      "A route that sends a registration row to an admin passes { hasProfile } from uidsWithProfile, " +
        "so the status on the screen is about the profile document and not the row's own flag.",
    );
  });
});

describe("the flip is set only when the document is there", () => {
  const flip = async () => {
    const res = await flipRoute.POST();
    return { status: res.status, body: await res.json() };
  };

  test("no profile: the row is left alone, and the answer is the same", async () => {
    globalThis.__regSessionUid = "u1";
    row("u1", { emailVerified: true, passwordSet: true, status: "pending-profile" });
    assert.deepEqual(await flip(), { status: 200, body: { ok: true } });
    assert.equal(store.get("registrations/u1").profileComplete, false);
    assert.equal(store.get("registrations/u1").status, "pending-profile");
  });

  test("a profile: the row is completed", async () => {
    globalThis.__regSessionUid = "u1";
    row("u1", { emailVerified: true, passwordSet: true, status: "pending-profile" });
    member("u1");
    assert.deepEqual(await flip(), { status: 200, body: { ok: true } });
    assert.equal(store.get("registrations/u1").profileComplete, true);
    assert.equal(store.get("registrations/u1").status, "completed");
  });

  test("nobody signed in: refused before anything is read", async () => {
    globalThis.__regSessionUid = null;
    const res = await flipRoute.POST();
    assert.equal(res.status, 401);
    assert.deepEqual(reads, []);
  });

  test("the route looks before it marks, in that order", () => {
    const code = codeOf("src/app/api/register/profile-complete/route.ts");
    const look = code.indexOf("hasProfile(");
    const mark = code.indexOf("markRegistrationProfileComplete(");
    assert.ok(look > 0 && mark > 0, "the route no longer calls both");
    assert.ok(look < mark, "the flag is set before the profile document has been looked for");
  });

  test("every other caller of the mark has just written the document itself", () => {
    // Callers are listed, with what makes each one safe. A new caller fails
    // here until it is added with its own reason.
    const SEEN_THE_DOCUMENT = {
      "src/app/api/register/profile-complete/route.ts": "looks the document up with hasProfile first",
      "src/app/api/collaborators/route.ts": "calls it straight after creating the collaborator document",
    };
    const callers = [];
    for (const file of walk(SRC)) {
      const path = posix(file);
      if (path === "src/lib/firestore/registrationWrites.ts") continue;
      const code = stripSource(readFileSync(file, "utf8"), { keepStrings: true });
      if (/markRegistrationProfileComplete\(/.test(code)) callers.push(path);
    }
    assert.deepEqual(callers.sort(), Object.keys(SEEN_THE_DOCUMENT).sort());
  });

  test("the browser's request for the flip outlives the navigation after it", () => {
    const code = codeOf("src/auth/signInWithGoogle.ts");
    const call = code.match(/fetch\(\s*"\/api\/register\/profile-complete"\s*,\s*\{([^}]*)\}/);
    assert.ok(call, "completeRegistration no longer asks for the flip");
    assert.match(call[1], /keepalive:\s*true/, "without keepalive the page change that follows can drop the request");
  });
});

// ---------------------------------------------------------------------------
// 4. The counts
// ---------------------------------------------------------------------------

describe("the whole-collection counts", () => {
  function seedEveryKind() {
    // The stranded person: password set before the rule changed, no profile.
    row("A", { emailVerified: true, passwordSet: true, status: "completed" });
    // Finished through the email route.
    row("B", { emailVerified: true, passwordSet: true, profileComplete: true, status: "completed" });
    // Google, form never finished.
    row("C", { method: "google", emailVerified: true, status: "pending-profile" });
    // Google, finished.
    row("D", { method: "google", emailVerified: true, profileComplete: true, status: "completed" });
    // The two early steps.
    row("E", { status: "pending-verify" });
    row("F", { emailVerified: true, status: "verified-no-password" });
    // An email row finished through Google: the old helper left the early word.
    row("G", { emailVerified: true, profileComplete: true, status: "verified-no-password" });
    // A row from before the profile flag existed.
    row("H", { emailVerified: true, passwordSet: true, status: "completed" });
    delete store.get("registrations/H").profileComplete;
    delete store.get("registrations/H").method;
  }

  test("a stranded row is counted as unfinished, with no backfill", async () => {
    seedEveryKind();
    const res = await summaryRoute.GET();
    assert.equal(res.status, 200);
    const { counts } = await res.json();
    assert.deepEqual(counts, {
      total: 8,
      pendingVerify: 1,
      verifiedNoPassword: 1,
      pendingProfile: 3,
      completed: 3,
      orphans: 5,
    });
  });

  test("the four statuses always add up to the total", () => {
    for (const read of [
      { total: 8, withProfile: 3, storedPendingVerify: 1, storedPendingVerifyWithProfile: 0, storedVerifiedNoPassword: 2, storedVerifiedNoPasswordWithProfile: 1 },
      { total: 0, withProfile: 0, storedPendingVerify: 0, storedPendingVerifyWithProfile: 0, storedVerifiedNoPassword: 0, storedVerifiedNoPasswordWithProfile: 0 },
      { total: 50, withProfile: 50, storedPendingVerify: 0, storedPendingVerifyWithProfile: 0, storedVerifiedNoPassword: 0, storedVerifiedNoPasswordWithProfile: 0 },
    ]) {
      const c = registrationCounts(read);
      assert.equal(c.pendingVerify + c.verifiedNoPassword + c.pendingProfile + c.completed, c.total);
      assert.equal(c.orphans, c.total - c.completed);
    }
  });

  test("counts that disagree mid-write never go negative", () => {
    // Six separate reads are not one snapshot: a row can move between them.
    const c = registrationCounts({
      total: 2,
      withProfile: 3,
      storedPendingVerify: 0,
      storedPendingVerifyWithProfile: 1,
      storedVerifiedNoPassword: 0,
      storedVerifiedNoPasswordWithProfile: 0,
    });
    for (const [name, value] of Object.entries(c)) assert.ok(value >= 0, `${name} is ${value}`);
  });

  test("the summary never counts the stored word completed", async () => {
    seedEveryKind();
    await summaryRoute.GET();
    const counted = reads.filter((r) => r.startsWith("count registrations"));
    assert.ok(counted.length >= 6, "the summary made fewer counts than the arithmetic needs");
    for (const r of counted) assert.doesNotMatch(r, /"completed"|"pending-profile"/, r);
  });
});
