/**
 * The membership module, executed (run via `npm test`, Node's built-in runner).
 *
 * Four things are worth a test here, and they are the four places this design
 * can go quietly wrong rather than loudly:
 *
 *  1. THE ID ROUND TRIP. The period id is the academic year with the slash
 *     replaced, because a Firestore doc id cannot hold a slash, while the
 *     `year` field stays "2026/27" verbatim so `users.paidMembershipYears`
 *     needs no migration. Every membership row carries only the period id, so
 *     the year on a member's history is derived by the inverse. If those two
 *     ever disagree, a history renders blank years and nothing throws.
 *  2. TIER_COUNTS_AS_MEMBER. `alumni` is the one tier that records a fact
 *     without conferring a membership, so it must never enter the cache.
 *  3. THE CAP PRE-CHECK. `normalizeUser` keeps ten years. An eleventh written
 *     anyway drops one, and the member's badge blanks with nothing anywhere
 *     saying why, so the grant refuses by name instead. The descending sort
 *     before the slice is the second half of that: a stale array that already
 *     holds eleven must keep the CURRENT year, not the first ten stored.
 *  4. THE /me PROJECTION. The member sees their tier and when it was
 *     recorded. Not who granted it, not the import batch, not the admin's
 *     note on the period.
 *  5. THE CURRENT-PERIOD MEMO. Every row of the admin Members list is drawn
 *     off one shared answer to "which period is current". Remembering the
 *     wrong answer is how that list ends up telling twenty rows there is no
 *     period, minutes after somebody made one.
 *
 * The loader dance is the one from `account-deletion-admission-roles.test.mjs`:
 * this repo's Node predates native TypeScript stripping, so the module graph is
 * transpiled in memory with the `typescript` devDependency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

const STUBS = new Map([["server-only", "export {};"]]);

function resolveLocalTs(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
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
      // The scan is a regex over source text, so a plain string literal can
      // look like an import: `"su-import"` carries the word `import` inside
      // it, and the match that follows is not a module specifier at all.
      // Anything that will not resolve is left exactly as it was written.
      try {
        rewrites.set(specifier, import.meta.resolve(specifier));
      } catch {
        // Not a module. Leave the source alone.
      }
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

const memberships = await loadTs(join("lib", "firestore", "memberships.ts"));
const users = await loadTs(join("lib", "firestore", "users.ts"));
const periodCache = await loadTs(join("features", "admin", "currentPeriodCache.ts"));

// ---------------------------------------------------------------------------
// 1. Ids
// ---------------------------------------------------------------------------

test("the period id is the year with the slash replaced, and round-trips", () => {
  assert.equal(memberships.periodIdForYear("2026/27"), "2026-27");
  assert.equal(memberships.yearForPeriodId("2026-27"), "2026/27");
  for (const year of ["2024/25", "2025/26", "2026/27", "2099/00"]) {
    assert.equal(
      memberships.yearForPeriodId(memberships.periodIdForYear(year)),
      year,
      "a member's history renders the year derived from the period id, so a " +
        "trip that does not round is a blank year on somebody's profile",
    );
  }
});

test("a period id cannot be invented from free text", () => {
  for (const bad of ["2026-27", "2026", "twenty twenty six", "", "2026/2027"]) {
    assert.throws(() => memberships.periodIdForYear(bad), RangeError);
  }
  for (const bad of ["2026/27", "26-27", "current", ""]) {
    assert.throws(() => memberships.yearForPeriodId(bad), RangeError);
  }
});

test("a membership id is the uid and the period, in that order", () => {
  assert.equal(memberships.membershipId("abc", "2026-27"), "abc__2026-27");
});

// ---------------------------------------------------------------------------
// 2. Tiers
// ---------------------------------------------------------------------------

test("alumni is the one tier that does not count as a member", () => {
  assert.equal(memberships.TIER_COUNTS_AS_MEMBER.paid, true);
  assert.equal(memberships.TIER_COUNTS_AS_MEMBER.comped, true);
  assert.equal(memberships.TIER_COUNTS_AS_MEMBER.staff, true);
  assert.equal(
    memberships.TIER_COUNTS_AS_MEMBER.alumni,
    false,
    "an alumni row records that somebody was with us, not that they are a " +
      "member this year, so it must never enter paidMembershipYears",
  );
  // Every declared tier has an answer: a tier added without one would read as
  // `undefined` and quietly fall to "not a member".
  for (const tier of memberships.ALL_MEMBERSHIP_TIERS) {
    assert.equal(typeof memberships.TIER_COUNTS_AS_MEMBER[tier], "boolean");
  }
  // There is no "associate" tier. External collaborators are their own thing.
  assert.equal(memberships.isMembershipTier("associate"), false);
});

// ---------------------------------------------------------------------------
// 3. The cache: the cap, and the order
// ---------------------------------------------------------------------------

const CAP = users.FIELD_LIMITS.maxPaidMembershipYears;

function years(count, from = 2000) {
  return Array.from({ length: count }, (_, i) => {
    const start = from + i;
    return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
  });
}

test("the tenth membership year is accepted", () => {
  const existing = years(CAP - 1);
  const next = memberships.addPaidMembershipYear(existing, "2026/27", CAP);
  assert.equal(next.length, CAP);
  assert.ok(next.includes("2026/27"));
});

test("the eleventh is refused by name, not truncated", () => {
  const existing = years(CAP);
  assert.throws(
    () => memberships.addPaidMembershipYear(existing, "2026/27", CAP),
    (err) => {
      assert.equal(err.name, "MembershipYearCapError");
      assert.match(err.message, /Revoke an older one/);
      return true;
    },
    "writing an eleventh year would push one off normalizeUser's slice and " +
      "blank a badge with nothing saying why",
  );
});

test("re-granting a year already recorded is a no-op at any size", () => {
  const existing = years(CAP);
  const next = memberships.addPaidMembershipYear(existing, existing[0], CAP);
  assert.equal(next.length, CAP);
});

test("the cache comes back newest first, and revoking removes one year", () => {
  const next = memberships.addPaidMembershipYear(
    ["2024/25", "2026/27", "2025/26"],
    "2027/28",
    CAP,
  );
  assert.deepEqual(next, ["2027/28", "2026/27", "2025/26", "2024/25"]);
  assert.deepEqual(memberships.removePaidMembershipYear(next, "2026/27"), [
    "2027/28",
    "2025/26",
    "2024/25",
  ]);
});

test("normalizeUser sorts descending BEFORE its slice, so the current year survives", () => {
  // A stale array of eleven with the current year stored LAST: the old
  // implementation kept the first ten in document order and dropped it.
  const stale = [...years(CAP, 2000), "2026/27"];
  assert.equal(stale.length, CAP + 1);
  assert.equal(stale[stale.length - 1], "2026/27");

  const doc = users.normalizeUser("u1", { paidMembershipYears: stale });
  assert.equal(doc.paidMembershipYears.length, CAP);
  assert.ok(
    users.hasPaidMembership(doc, "2026/27"),
    "the newest year must survive the cap, or a paid-up member's badge blanks",
  );
  assert.equal(doc.paidMembershipYears[0], "2026/27");
  // And the oldest is the one that fell off.
  assert.equal(doc.paidMembershipYears.includes("2000/01"), false);
});

test("normalizeUser still drops junk years and keeps the field absent when empty", () => {
  const doc = users.normalizeUser("u2", {
    paidMembershipYears: ["2026/27", "nonsense", 7, "2026/27"],
  });
  assert.deepEqual(doc.paidMembershipYears, ["2026/27"]);
  assert.equal(users.normalizeUser("u3", {}).paidMembershipYears, undefined);
});

// ---------------------------------------------------------------------------
// 4. The /me projection
// ---------------------------------------------------------------------------

function row(periodId, tier, extra = {}) {
  return memberships.normalizeMembership(`u1__${periodId}`, {
    uid: "u1",
    periodId,
    tier,
    source: "manual",
    matchedOn: "manual",
    provenance: { at: new Date("2026-09-01T10:00:00Z"), byUid: "admin1", batchId: "b1" },
    ...extra,
  });
}

test("the /me projection carries no provenance beyond the date, and no note", () => {
  const period = memberships.normalizeMembershipPeriod("2026-27", {
    year: "2026/27",
    label: "Membership 2026/27",
    note: "Chased the SU twice for this list",
    totals: { paid: 4, comped: 1, alumni: 0, staff: 0 },
  });
  const payload = memberships.projectMembershipForMe(
    period,
    row("2026-27", "paid"),
    [row("2026-27", "paid"), row("2025-26", "comped")],
  );

  assert.deepEqual(payload.currentPeriod, {
    id: "2026-27",
    year: "2026/27",
    label: "Membership 2026/27",
  });
  assert.equal(payload.membership.tier, "paid");
  assert.equal(payload.membership.since, "2026-09-01T10:00:00.000Z");
  assert.deepEqual(payload.history, [
    { year: "2026/27", tier: "paid" },
    { year: "2025/26", tier: "comped" },
  ]);

  const json = JSON.stringify(payload);
  assert.equal(json.includes("admin1"), false, "the granting admin must not be in the payload");
  assert.equal(json.includes("b1"), false, "the import batch must not be in the payload");
  assert.equal(json.includes("Chased the SU"), false, "the period note is admin-only");
  assert.equal(json.includes("provenance"), false);
  assert.equal(json.includes("totals"), false);
});

test("no current period, and no row, are both plain nulls", () => {
  const empty = memberships.projectMembershipForMe(null, null, []);
  assert.deepEqual(empty, { currentPeriod: null, membership: null, history: [] });

  const period = memberships.normalizeMembershipPeriod("2026-27", {
    year: "2026/27",
    label: "Membership 2026/27",
  });
  const noRow = memberships.projectMembershipForMe(period, null, []);
  assert.equal(noRow.membership, null);
  assert.equal(noRow.currentPeriod.year, "2026/27");
});

test("a soft-revoked row is not a membership and is not history", () => {
  const revoked = row("2026-27", "paid", { revokedAt: new Date("2026-10-01T00:00:00Z") });
  const payload = memberships.projectMembershipForMe(null, revoked, [revoked]);
  assert.equal(payload.membership, null);
  assert.deepEqual(payload.history, []);
});

test("normalizeMembership refuses to promote an unreadable tier", () => {
  const odd = memberships.normalizeMembership("u1__2026-27", {
    uid: "u1",
    periodId: "2026-27",
    tier: "founder",
  });
  assert.equal(
    odd.tier,
    "alumni",
    "a hand-edited tier must fall to the one that counts as nothing, never to paid",
  );
  assert.equal(memberships.TIER_COUNTS_AS_MEMBER[odd.tier], false);
});

// ---------------------------------------------------------------------------
// 5. Period dates
// ---------------------------------------------------------------------------

test("period dates are real civil dates, in order, and may be empty", () => {
  assert.deepEqual(memberships.validatePeriodDates("2026-09-01", "2027-07-31"), {
    startsOn: "2026-09-01",
    endsOn: "2027-07-31",
  });
  assert.deepEqual(memberships.validatePeriodDates("", ""), { startsOn: "", endsOn: "" });
  assert.match(memberships.validatePeriodDates("2026-02-31", "").error, /real date/);
  assert.match(memberships.validatePeriodDates("", "not-a-date").error, /real date/);
  assert.match(
    memberships.validatePeriodDates("2027-07-31", "2026-09-01").error,
    /before the start date/,
  );
});

// ---------------------------------------------------------------------------
// 6. The shared current-period memo
// ---------------------------------------------------------------------------

/** A fetcher that answers from a script and counts how often it was asked. */
function scriptedFetcher(answers) {
  const queue = [...answers];
  const state = { calls: 0 };
  state.fetch = () => {
    state.calls += 1;
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return state;
}

const PERIOD = { id: "2026-27", year: "2026/27", label: "Membership 2026/27" };

test("a real answer is fetched once and shared by every row", async () => {
  const source = scriptedFetcher([PERIOD]);
  const cache = periodCache.createCurrentPeriodCache(source.fetch);
  const [a, b, c] = await Promise.all([cache.load(), cache.load(), cache.load()]);
  assert.deepEqual([a, b, c], [PERIOD, PERIOD, PERIOD]);
  assert.equal(source.calls, 1, "twenty member rows must not be twenty requests");
});

test("NO period is never remembered", async () => {
  // The state an admin is most likely to be halfway through changing. Keeping
  // it is how every row goes on saying "no membership period is current"
  // after one has been created and made current.
  const source = scriptedFetcher([null, PERIOD]);
  const cache = periodCache.createCurrentPeriodCache(source.fetch);
  assert.equal(await cache.load(), null);
  assert.deepEqual(await cache.load(), PERIOD);
  assert.equal(source.calls, 2);
});

test("a failed request is never remembered either", async () => {
  const source = scriptedFetcher([new Error("offline"), PERIOD]);
  const cache = periodCache.createCurrentPeriodCache(source.fetch);
  await assert.rejects(cache.load(), /offline/);
  assert.deepEqual(await cache.load(), PERIOD);
  assert.equal(source.calls, 2);
});

test("a real answer expires", async () => {
  const source = scriptedFetcher([PERIOD]);
  let clock = 1_000;
  const cache = periodCache.createCurrentPeriodCache(source.fetch, {
    ttlMs: 100,
    now: () => clock,
  });
  await cache.load();
  clock += 99;
  await cache.load();
  assert.equal(source.calls, 1, "still inside the window");
  clock += 2;
  await cache.load();
  assert.equal(source.calls, 2, "past it, so the badge cannot be stale forever");
});

test("reset drops the answer, and an in-flight request cannot undo the reset", async () => {
  const source = scriptedFetcher([PERIOD]);
  const cache = periodCache.createCurrentPeriodCache(source.fetch);
  const inFlight = cache.load();
  cache.reset();
  await inFlight;
  await cache.load();
  assert.equal(
    source.calls,
    2,
    "the console resets after a write; a request that started before it must " +
      "not put the pre-write answer back",
  );
});

// ---------------------------------------------------------------------------
// 7. The single-writer guard
// ---------------------------------------------------------------------------

/**
 * `users.paidMembershipYears` has exactly ONE writer: the grant route, which
 * moves it in the same transaction as the membership row and pre-checks the
 * cap. `adminMutations.setPaidMembership` used to write it client-direct from
 * the Members row and could only ever tag the CURRENT year, which is what made
 * a June reconciliation tag the wrong one. It is deleted, and this is what
 * keeps it deleted: a second writer would put a badge on somebody with no row
 * behind it, or move the cache without moving the period's totals.
 */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

test("GUARD: only the grant route writes paidMembershipYears", () => {
  const ALLOWED = new Set([
    // The writer.
    "src/app/api/admin/membership/grant/route.ts",
    // The field's own declaration, normaliser and cap.
    "src/lib/firestore/users.ts",
    // The pure cache helpers the writer uses.
    "src/lib/firestore/memberships.ts",
  ]);
  // Anything that merely READS the cache is fine, so the scan looks for a
  // write: the field on the left of a colon or an equals, which is every
  // shape a Firestore update takes here. A dotted read (`user.paidMembership
  // Years`) is excluded by the lookbehind, and a component that wants the
  // value takes it under another name rather than passing the field's own.
  const WRITE = /(?<![.\w])paidMembershipYears\s*[:=]/;

  const offenders = [];
  for (const file of sourceFiles(join(REPO_ROOT, "src"))) {
    const path = relative(REPO_ROOT, file).split(sep).join("/");
    if (ALLOWED.has(path)) continue;
    if (WRITE.test(readFileSync(file, "utf8"))) offenders.push(path);
  }

  assert.deepEqual(
    offenders,
    [],
    "these files write users.paidMembershipYears. It is a CACHE with one " +
      "writer, POST /api/admin/membership/grant, which moves it in the same " +
      "transaction as the memberships row and pre-checks the ten-year cap. A " +
      "second writer puts a badge on an account with no membership row behind " +
      "it. Read it through hasPaidMembership() instead.",
  );
});
