/**
 * Unit tests for the WEEKLY COURSE NUDGE — the send-dedupe marker
 * (`src/lib/email/courseNudgeEmail.ts`), the token resolver's degradation
 * rules, and the four-way token contract the admin designer proofs against.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies).
 *
 * ## Why this file exists
 *
 * P10 shipped `course-task-mirror.test.mjs` for exactly this class of
 * guarantee: a property the source carries paragraphs about and nothing
 * executed. P11 has two of them.
 *
 *  1. **The marker.** It is what stands between a misconfigured cron and a
 *     cohort receiving the same email seven times. It is keyed on the CALENDAR
 *     SLOT rather than the display week number, and that choice is the whole
 *     defence against a track lead renumbering the week plan mid-week — an edit
 *     that would otherwise mint a fresh marker and re-mail everyone. Nothing
 *     type-checks that; a test has to.
 *  2. **The degradation rules.** A cohort must never receive
 *     "Your group meets {sessionWhen}, {sessionWhere}.", a paragraph reading
 *     "{weekPrep}", or a dead link whose href is the string "{weekUrl}". The
 *     renderer's answer is to drop a text unit whose tokens ALL resolved empty
 *     and tidy the punctuation of the mixed case. That is an exact rule over a
 *     seed template with six paragraphs and ten tokens, so the matrix below
 *     renders all 2^10 combinations and asserts the invariants on every one.
 *
 * ## Why the loader dance is bigger than the task mirror's
 *
 * Same root cause: this repo's Node predates the v22.18 that strips TypeScript
 * natively, so `loadTsGraph` transpiles in memory with the `typescript`
 * devDependency `npx tsc --noEmit` already uses. Three differences from
 * `course-task-mirror.test.mjs`, all forced by the module under test:
 *
 *  - **`@/…` alias resolution.** `courseNudgeEmail.ts` imports by alias, and a
 *    `data:` URL can resolve neither a relative path nor an alias.
 *  - **THREE STUBBED SPECIFIERS**, listed in `STUBS` with the reason each is
 *    unreachable from an assertion here. Everything the tests actually call is
 *    the real module: the real `courseTemplateDefaults`, the real `firstWord`,
 *    the real `weekPlan` maths, the real `courseSampleTokens`.
 *  - **The transpile path is taken unconditionally**, not as a fallback. On a
 *    Node new enough to import `.ts` directly, a native import would bypass the
 *    rewrites and load `server-only`, which throws by design outside a React
 *    Server Component graph.
 *
 * Delete the dance once the repo's Node is >= 22.18 AND `server-only` can be
 * resolved to its no-op build from a plain script.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const NUDGE_ROUTE = join(
  SRC,
  "app",
  "api",
  "courses",
  "runs",
  "[runId]",
  "nudge",
  "route.ts",
);
const EDITOR = join(
  SRC,
  "features",
  "admin",
  "emailDesigns",
  "CourseEmailDesignEditor.tsx",
);

/**
 * Every module specifier in transpiled output: `from "x"`, `import "x"` and
 * `import("x")`, in either quote style. Deliberately a regex over the OUTPUT
 * rather than a TypeScript AST walk — by that point the type-only imports are
 * already gone and what is left is plain ES module syntax.
 */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/**
 * Specifiers replaced with a no-op module, and why each one is safe to replace.
 *
 * NOTHING BELOW IS REACHABLE FROM AN ASSERTION IN THIS FILE. Only
 * `sendCourseWeekNudgeEmail` touches the email component and the transport, and
 * calling it would put real mail on the wire — which is the one thing a unit
 * test of this feature must never do.
 */
const STUBS = new Map([
  // Throws by design when imported outside a React Server Component graph.
  // Its real job is a build-time guard, and there is no build here.
  ["server-only", "export {};"],
  // A .tsx pulling in @react-email/components and the block renderer. Only the
  // send path renders it.
  [
    join(SRC, "emails", "CourseNudgeEmail.tsx"),
    "export default function CourseNudgeEmail() {\n" +
      "  throw new Error('CourseNudgeEmail is stubbed in tests');\n}",
  ],
  // nodemailer + the deliverability log. Only the send path calls it, and a
  // stub that throws is the belt to the braces of never calling it.
  [
    join(SRC, "lib", "email", "send.ts"),
    "export function sendEmail() {\n" +
      "  throw new Error('sendEmail is stubbed in tests — a unit test must not send mail');\n}",
  ],
]);

function resolveLocalTs(specifier, fromFile) {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** file path (or stub key) → data: URL of its module source. Memoised. */
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
      // A package. `import.meta.resolve` is the runtime's own resolver, so this
      // is exactly the file the app would have loaded.
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
        "the `typescript` devDependency is not installed — run `npm install`.",
        { cause: err },
      );
    }
  }
  return import(await transpileToDataUrl(join(SRC, relativePath)));
}

const {
  buildCourseNudgeTokens,
  courseNudgeSessionDateKey,
  courseNudgeSessionWhen,
  courseNudgeSessionWhere,
  courseNudgeTokensFrom,
  courseWeekPrepLine,
  courseWeekUrl,
  nudgeMarkerId,
  nudgeWeekMarkerIds,
  renderCourseNudge,
  COURSE_NUDGE_TOKEN_KEYS,
} = await loadTs("lib/email/courseNudgeEmail.ts");
const { courseTemplateDefaults } = await loadTs("lib/firestore/courseEmails.ts");
const { weekDocId } = await loadTs("lib/firestore/courses.ts");
const { currentWeekFor } = await loadTs("lib/courses/weekPlan.ts");
const { courseSampleTokens } = await loadTs(
  "features/admin/emailDesigns/courseEmailSamples.ts",
);

const SEED = courseTemplateDefaults["course-week-nudge"];
const ROUTE_SOURCE = readFileSync(NUDGE_ROUTE, "utf8");
const EDITOR_SOURCE = readFileSync(EDITOR, "utf8");

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

/** A Monday, so every slot in the plans below starts on a Monday. */
const START = "2026-09-28";

const week = (n) => ({ kind: "week", weekNumber: n, weekId: weekDocId(n) });

/** Full, everything-resolves token input — the "longest email" case. */
function fullInput(overrides = {}) {
  return {
    courseTitle: "AI Safety Fundamentals",
    runLabel: "Autumn 2026",
    weekNumber: 3,
    weekTitle: "Goal misgeneralisation",
    weekSummary:
      "Why a system that learned the right thing in training can still pursue the wrong one when the world shifts.",
    sessionWhen: "Tuesday 21 October, 18:00–19:30",
    sessionWhere: "Hallward Library, B12",
    weekPrep:
      "There are four things to read or watch and one exercise to write up this week, about 2 hours in total.",
    weekUrl: "https://naisi.uk/learn/asf-autumn-2026/weeks/3",
    recipientName: "Alex Taylor",
    ...overrides,
  };
}

const renderSeed = (overrides = {}) =>
  renderCourseNudge(SEED, buildCourseNudgeTokens(fullInput(overrides)));

/** Every heading's text and every richText block's html, concatenated. */
function bodyOf(rendered) {
  return rendered.blocks
    .map((b) => (b.type === "heading" ? b.text : b.type === "richText" ? b.html : ""))
    .join("\n");
}

/**
 * The body as a reader sees it — tags removed, paragraph boundaries kept as
 * line breaks so stripping cannot fuse two paragraphs into a false adjacency.
 * Used for the punctuation assertions; the brace assertions run on raw markup
 * so an unresolved token hiding in an attribute cannot escape them.
 */
function readableOf(rendered) {
  return bodyOf(rendered)
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "");
}

/**
 * How many paragraphs survived. The seed's whole body is ONE admin-authored
 * richText block holding six `<p>`s, and the drop rule works per paragraph — so
 * counting blocks proves nothing and counting paragraphs is the assertion with
 * teeth. A renderer that merely blanked its tokens would keep all six.
 */
function paragraphsOf(rendered) {
  return (bodyOf(rendered).match(/<p\b/g) ?? []).length;
}

/** Every `{token}` a template references, across subject, headings and html. */
function tokensReferencedBy(template) {
  const surfaces = [template.subject];
  for (const block of template.blocks) {
    if (block.type === "heading") surfaces.push(block.text);
    if (block.type === "richText") surfaces.push(block.html);
  }
  const found = new Set();
  for (const surface of surfaces) {
    for (const [, key] of surface.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)) {
      found.add(key);
    }
  }
  return found;
}

// ===========================================================================
// FIX 4 — the marker is keyed on the calendar slot
// ===========================================================================

test("nudgeMarkerId is deterministic for the same (run, slot)", () => {
  // `.create()` at a deterministic id IS the once-per-cohort-week guarantee.
  // Two racing ticks aim at one document or they do not race at all.
  assert.equal(
    nudgeMarkerId("run1", "2026-10-12"),
    nudgeMarkerId("run1", "2026-10-12"),
  );
  assert.equal(nudgeMarkerId("run1", "2026-10-12"), "nudge__run1__2026-10-12");
});

test("nudgeMarkerId separates run and slot", () => {
  const ids = new Set([
    nudgeMarkerId("run1", "2026-10-12"),
    nudgeMarkerId("run2", "2026-10-12"), // different run
    nudgeMarkerId("run1", "2026-10-19"), // the following week
  ]);
  assert.equal(ids.size, 3);
});

test("nudgeMarkerId shares its collection with the P9 throttle without colliding", () => {
  // Both live in `courseNudges`, which firestore.rules locks `read, write: if
  // false`. The prefixes are what keep them apart, and shipping without a rules
  // change depends on that staying true.
  assert.ok(nudgeMarkerId("run1", "2026-10-12").startsWith("nudge__"));
  assert.ok(!nudgeMarkerId("run1", "2026-10-12").startsWith("emailrate__"));
});

test("the marker survives a track lead RENUMBERING the week plan", () => {
  // THE duplicate-blast property. Monday the w03 nudge sends and claims its
  // marker; Wednesday a track lead relabels the plan entry the cohort is
  // sitting in. Keyed on the display week number, Thursday's tick would look
  // for a marker that does not exist and re-mail the whole cohort.
  const now = new Date("2026-10-14T09:00:00Z"); // Wed of the third slot

  const before = { startDate: START, weekPlan: [week(1), week(2), week(3), week(4)] };
  const after = {
    startDate: START,
    // Same slot, relabelled: the plan's `weekNumber` is authored data, not a
    // position, so a lead can move it without touching the calendar.
    weekPlan: [week(1), week(2), week(4), week(5)],
  };

  const a = currentWeekFor(before, now);
  const b = currentWeekFor(after, now);

  // The premise: the DISPLAY week number really did move under the same clock.
  assert.equal(a.weekNumber, 3);
  assert.equal(b.weekNumber, 4);
  assert.notEqual(weekDocId(a.weekNumber), weekDocId(b.weekNumber));

  // The property: the calendar slot did not, so the marker did not.
  assert.equal(a.slotStartKey, b.slotStartKey);
  assert.equal(
    nudgeMarkerId("run1", a.slotStartKey),
    nudgeMarkerId("run1", b.slotStartKey),
  );
});

test("the marker survives a break being INSERTED into the week plan", () => {
  // The other shape of the same edit: a reading week added at the front shifts
  // every later slot's number down by one without moving any slot's dates.
  const now = new Date("2026-10-14T09:00:00Z");

  const before = { startDate: START, weekPlan: [week(1), week(2), week(3), week(4)] };
  const after = {
    startDate: START,
    weekPlan: [week(1), { kind: "break", label: "Reading week" }, week(2), week(3)],
  };

  const a = currentWeekFor(before, now);
  const b = currentWeekFor(after, now);
  assert.equal(a.weekNumber, 3);
  assert.equal(b.weekNumber, 2);
  assert.equal(a.slotStartKey, b.slotStartKey);
  assert.equal(
    nudgeMarkerId("run1", a.slotStartKey),
    nudgeMarkerId("run1", b.slotStartKey),
  );
});

test("the marker DOES move when the cohort moves to the next slot", () => {
  // The guarantee is once per week, not once per run: consecutive slots must
  // mint different ids or a cohort gets exactly one nudge, ever.
  const run = { startDate: START, weekPlan: Array.from({ length: 8 }, (_, i) => week(i + 1)) };
  const seen = new Set();
  for (let day = 0; day < 56; day += 7) {
    const at = new Date(`2026-09-28T09:00:00Z`);
    at.setUTCDate(at.getUTCDate() + day);
    seen.add(nudgeMarkerId("run1", currentWeekFor(run, at).slotStartKey));
  }
  assert.equal(seen.size, 8);
});

test("the nudge route still keys its marker on the slot, and recomputes the slot", () => {
  // A source check, deliberately: the route is not importable from here
  // (next/server, firebase-admin). Without it the assertions above could keep
  // passing against a key the route no longer uses.
  assert.match(ROUTE_SOURCE, /nudgeMarkerId\(runId,\s*resolved\.slotStartKey\)/);
  assert.match(ROUTE_SOURCE, /slotStartKey:\s*currentWeek\.slotStartKey/);
  // And it must not have quietly grown a second key off the week number.
  assert.doesNotMatch(ROUTE_SOURCE, /nudgeMarkerId\([^)]*weekNumber/);
});

// ===========================================================================
// The ±6-day span — a `startDate` edit cannot re-mail the same calendar week
// ===========================================================================

test("EDITING startDate moves the slot id under an already-mailed week", () => {
  // The hole the slot key alone leaves open, and the reason the span exists.
  // `startDate` is not pinned by firestore.rules, a track lead may edit a run
  // directly, and a track lead is an authorised nudge sender.
  const now = new Date("2026-10-14T09:00:00Z"); // Wednesday of the third slot
  const plan = [week(1), week(2), week(3), week(4)];

  const before = currentWeekFor({ startDate: START, weekPlan: plan }, now);
  // The lead corrects the start date by one day. Same Wednesday, same taught
  // week — but a different calendar slot.
  const after = currentWeekFor({ startDate: "2026-09-29", weekPlan: plan }, now);

  assert.equal(before.weekNumber, 3);
  assert.equal(after.weekNumber, 3);
  assert.equal(before.slotStartKey, "2026-10-12");
  assert.equal(after.slotStartKey, "2026-10-13");
  // Monday's claim is invisible to the new key, which is what would let the
  // next press mail the whole cohort a second time.
  assert.notEqual(
    nudgeMarkerId("run1", before.slotStartKey),
    nudgeMarkerId("run1", after.slotStartKey),
  );

  // THE FIX: the marker one day off is inside the span the corrected slot
  // consults, so it is found and the cohort is mailed once.
  assert.ok(
    nudgeWeekMarkerIds("run1", after.slotStartKey).includes(
      nudgeMarkerId("run1", before.slotStartKey),
    ),
  );
});

test("the span stops at six days — seven is genuinely the next week", () => {
  const ids = nudgeWeekMarkerIds("run1", "2026-10-12");
  assert.equal(ids.length, 13);
  assert.equal(new Set(ids).size, 13);
  // This slot's own id first: it is the one a send actually claims.
  assert.equal(ids[0], nudgeMarkerId("run1", "2026-10-12"));

  for (const key of ["2026-10-06", "2026-10-11", "2026-10-13", "2026-10-18"]) {
    assert.ok(ids.includes(nudgeMarkerId("run1", key)), `${key} should be in the span`);
  }
  // Seven days out is a different cohort week and MUST be sendable.
  for (const key of ["2026-10-05", "2026-10-19"]) {
    assert.ok(!ids.includes(nudgeMarkerId("run1", key)), `${key} must be outside the span`);
  }
});

test("an unedited weekly cadence never sees its own previous marker", () => {
  // The span must not suppress next week's nudge on a run nobody has touched:
  // consecutive slots are seven days apart, exactly one day outside it.
  const run = {
    startDate: START,
    weekPlan: Array.from({ length: 8 }, (_, i) => week(i + 1)),
  };
  const slots = [];
  for (let day = 0; day < 56; day += 7) {
    const at = new Date("2026-09-28T09:00:00Z");
    at.setUTCDate(at.getUTCDate() + day);
    slots.push(currentWeekFor(run, at).slotStartKey);
  }
  assert.equal(new Set(slots).size, 8);

  for (const slot of slots) {
    const span = new Set(nudgeWeekMarkerIds("run1", slot));
    for (const other of slots) {
      if (other === slot) continue;
      assert.ok(
        !span.has(nudgeMarkerId("run1", other)),
        `slot ${slot} would suppress ${other}`,
      );
    }
  }
});

test("the route consults the whole span, and reads it in ONE batch", () => {
  // A source check for the same reason the marker tests are: the route is not
  // importable here. GET and POST must consult the SAME span, or the panel
  // shows a clean unsent state for a week POST refuses to send.
  assert.match(ROUTE_SOURCE, /nudgeWeekMarkerIds\(runId,\s*slotStartKey\)/);
  assert.match(ROUTE_SOURCE, /db\.getAll\(/);

  const get = ROUTE_SOURCE.indexOf("export async function GET");
  const post = ROUTE_SOURCE.indexOf("export async function POST");
  assert.ok(get > 0 && post > get);
  assert.match(
    ROUTE_SOURCE.slice(get, post),
    /findWeekMarker\(db, runId, resolved\.slotStartKey\)/,
  );
  assert.match(
    ROUTE_SOURCE.slice(post),
    /findWeekMarker\(db, runId, resolved\.slotStartKey\)/,
  );
});

test("a FORCE over a NEIGHBOURING marker is recorded on the marker it writes", () => {
  // A neighbour cannot collide with `.create()`, so nothing throws and the
  // usual force audit never runs. Without this the record shows a first send
  // (`forceCount: 0`) for a cohort that has now had the week's nudge twice.
  const claim = ROUTE_SOURCE.indexOf("markerRef.create({");
  const dispatch = ROUTE_SOURCE.indexOf("dispatchSends(recipients");
  assert.ok(claim > 0 && claim < dispatch);

  const claimBlock = ROUTE_SOURCE.slice(claim, dispatch);
  assert.match(claimBlock, /forcedOverMarkerId/);
  assert.match(claimBlock, /forceCount:\s*forcedOverMarkerId\s*\?\s*1\s*:\s*0/);
  // …and the caller is told the cohort had already been mailed this week.
  assert.match(claimBlock, /alreadySent = true/);
});

test("the route source stays greppable", () => {
  // A literal NUL byte makes GNU/BSD `grep -r` report "Binary file … matches"
  // and print nothing, which silently excluded this route from a reviewer's own
  // sweep for other nudge renderers. The separator is written as an escape.
  assert.ok(!ROUTE_SOURCE.includes("\u0000"), "a raw NUL byte is back in the route");
  assert.match(ROUTE_SOURCE, /const SESSION_KEY_SEP = "\\u0000";/);
});

// ===========================================================================
// FIX 9 — the route's send ordering, asserted at the source
// ===========================================================================

test("the marker is CLAIMED BEFORE the first message is dispatched", () => {
  // Claim-then-send trades "possible partial send" for "never a duplicate
  // blast", which is the right trade for email. Reversing these two lines is a
  // one-character-looking change that turns a crash at recipient 190 into 189
  // people re-mailed on every subsequent tick.
  const claim = ROUTE_SOURCE.indexOf("markerRef.create(");
  const dispatch = ROUTE_SOURCE.indexOf("dispatchSends(recipients");
  assert.ok(claim > 0, "the route no longer claims a marker");
  assert.ok(dispatch > 0, "the route no longer dispatches through dispatchSends");
  assert.ok(claim < dispatch, "the marker must be claimed before any mail moves");

  // And the rate-limit slot is reserved before the claim, so a throttled
  // request cannot leave a marker behind for a send that never happened.
  const slot = ROUTE_SOURCE.indexOf("reserveSendSlot(db");
  assert.ok(slot > 0 && slot < claim);
});

test("a TEST send claims nothing", () => {
  // A rehearsal reached only its own sender; the cohort's week is still owed
  // its nudge. The claim therefore sits inside `if (!testOnly)`.
  const guard = ROUTE_SOURCE.lastIndexOf("if (!testOnly) {");
  const claim = ROUTE_SOURCE.indexOf("markerRef.create(");
  assert.ok(guard > 0 && guard < claim);
});

test("the FORCE path leaves the marker in place", () => {
  // A forced re-send must be visible on the record afterwards. Deleting and
  // re-creating would erase who sent it first and when.
  assert.doesNotMatch(ROUTE_SOURCE, /markerRef\.delete\(/);
  assert.match(ROUTE_SOURCE, /markerRef\.update\(\{/);
  assert.match(ROUTE_SOURCE, /forceCount:\s*FieldValue\.increment\(1\)/);
  // AUDIT FIRST: the update lands before the dispatch loop.
  assert.ok(
    ROUTE_SOURCE.indexOf("markerRef.update({") <
      ROUTE_SOURCE.indexOf("dispatchSends(recipients"),
  );
});

test("an EMPTY audience deliberately does not claim the marker", () => {
  // A cohort where everyone has opted out today, or nobody is allocated yet,
  // must not have this week's nudge permanently suppressed for whoever becomes
  // deliverable tomorrow. So the zero-recipient path returns BEFORE the claim.
  const empty = ROUTE_SOURCE.indexOf("if (recipients.length === 0) {");
  const claim = ROUTE_SOURCE.indexOf("markerRef.create(");
  assert.ok(empty > 0, "the route no longer short-circuits an empty audience");
  assert.ok(empty < claim, "the empty-audience return must precede the claim");
  // It reports the marker as untouched rather than as already sent.
  const block = ROUTE_SOURCE.slice(empty, claim);
  assert.match(block, /alreadySent:\s*false/);
});

test("the route holds no copy machinery of its own", () => {
  // FIX 1: exactly one implementation. Three parallel builds of this feature
  // each grew their own token map, and the wired one resolved none of the four
  // tokens the seed template uses. These are the shapes that came back.
  for (const forbidden of [
    /function escapeHtml/,
    /personaliseBlocks\(/,
    /personaliseString\(/,
    /function buildNudgeTokens/,
    /function unsubscribeBlocks/,
    /Unsubscribe from the weekly course emails/,
  ]) {
    assert.doesNotMatch(ROUTE_SOURCE, forbidden);
  }
  // What it does instead.
  assert.match(ROUTE_SOURCE, /renderCourseNudge\(/);
  assert.match(ROUTE_SOURCE, /sendCourseWeekNudgeEmail\(/);
  assert.match(ROUTE_SOURCE, /resolveCourseNudgeTemplate\(/);
});

test("both cohort routes derive their audience from the one shared helper", () => {
  // FIX 3: ~120 duplicated lines, under a comment conceding "IF YOU CHANGE ONE,
  // CHANGE BOTH". They are now one function, and neither route may grow a
  // private copy back.
  const announcement = readFileSync(
    join(SRC, "app", "api", "courses", "runs", "[runId]", "email", "route.ts"),
    "utf8",
  );
  for (const source of [ROUTE_SOURCE, announcement]) {
    assert.match(source, /resolveCohortAudience\(db,\s*runId,\s*LANE\)/);
    assert.match(source, /gateRunStaff\(runId\)/);
    assert.doesNotMatch(source, /function deriveAudience/);
    assert.doesNotMatch(source, /findRecipientsForChannel\(/);
    assert.doesNotMatch(source, /function hasOptedOutOfCourseAnnouncements/);
  }
});

// ===========================================================================
// FIX 2 — one token contract, four places
// ===========================================================================

test("the seed template references only tokens the resolver can resolve", () => {
  const known = new Set(COURSE_NUDGE_TOKEN_KEYS);
  for (const token of tokensReferencedBy(SEED)) {
    assert.ok(
      known.has(token),
      `the seed template uses {${token}}, which nothing resolves — it would ship as literal braces`,
    );
  }
});

test("the resolver produces exactly the advertised token map", () => {
  const produced = Object.keys(buildCourseNudgeTokens(fullInput())).sort();
  assert.deepEqual(produced, [...COURSE_NUDGE_TOKEN_KEYS].sort());
});

test("the admin editor advertises exactly the tokens that resolve", () => {
  // The editor is a client component and cannot import the `server-only`
  // resolver, so this source read is the only thing holding the two together.
  const block = /const WEEK_TOKENS: TokenHelp\[\] = \[([\s\S]*?)\n\];/.exec(EDITOR_SOURCE);
  assert.ok(block, "WEEK_TOKENS is no longer where the contract test can find it");
  const advertised = [...block[1].matchAll(/token:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...advertised].sort(), [...COURSE_NUDGE_TOKEN_KEYS].sort());
});

test("the designer's sample map fills in exactly the tokens that resolve", () => {
  // Anything extra renders in the preview and nowhere else — an admin proofs a
  // sentence a recipient never sees. Anything missing does the reverse.
  const sample = Object.keys(courseSampleTokens("course-week-nudge", "Alex Taylor"));
  assert.deepEqual(sample.sort(), [...COURSE_NUDGE_TOKEN_KEYS].sort());
});

test("the seed template rendered with the designer's own samples has no gaps", () => {
  // What the admin sees in the preview pane, asserted end to end.
  const rendered = renderCourseNudge(
    SEED,
    courseNudgeTokensFrom(courseSampleTokens("course-week-nudge", "Alex Taylor")),
  );
  assert.doesNotMatch(rendered.subject, /\{[a-zA-Z]/);
  assert.doesNotMatch(bodyOf(rendered), /\{[a-zA-Z]/);
  // Nothing dropped: the designer shows the longest version anyone receives.
  assert.equal(paragraphsOf(rendered), 6);
  assert.equal(rendered.blocks.length, SEED.blocks.length);
});

test("the nudge template's advertised behaviour is the behaviour it has", () => {
  // The editor promises "the whole sentence around it is removed". It was a
  // promise about a module nothing imported; this is the assertion that it is
  // now a promise about the send path.
  assert.match(EDITOR_SOURCE, /the whole sentence around it is removed/);
  assert.equal(paragraphsOf(renderSeed()), 6);
  assert.equal(paragraphsOf(renderSeed({ weekSummary: "" })), 5);
  assert.doesNotMatch(bodyOf(renderSeed({ weekSummary: "" })), /\{weekSummary\}/);
});

// ===========================================================================
// The seed copy itself (FIX 8b, 8c)
// ===========================================================================

test("the subject leads with what varies week to week", () => {
  // A phone truncates at roughly 35 characters. "Week 3 of AI Safety
  // Fundamenta…" spends the whole visible line on the identical half.
  assert.ok(
    SEED.subject.startsWith("{weekTitle}"),
    "the subject must lead with the week's own title",
  );
  const subject = renderSeed().subject;
  assert.equal(subject, "Goal misgeneralisation · Week 3 of AI Safety Fundamentals");
  assert.ok(subject.slice(0, 35).includes("Goal misgeneralisation"));
});

test("the body does not carry the run label as a parenthetical", () => {
  // A member is on exactly one run; "(Autumn 2026)" is bookkeeping addressed to
  // nobody. `{runLabel}` still resolves for an admin who wants it.
  assert.doesNotMatch(bodyOf(renderSeed()), /\(Autumn 2026\)/);
  assert.ok(COURSE_NUDGE_TOKEN_KEYS.includes("runLabel"));
});

test("the unpushy last line survives verbatim", () => {
  assert.match(
    bodyOf(renderSeed()),
    /Read what you can\. The week stays open, and nobody is keeping score\./,
  );
});

// ===========================================================================
// Degradation — the drop rule, one case at a time
// ===========================================================================

test("a member with no session gets no session sentence", () => {
  const rendered = renderSeed({ sessionWhen: "", sessionWhere: "Hallward Library, B12" });
  const body = bodyOf(rendered);
  assert.equal(paragraphsOf(rendered), 5);
  assert.doesNotMatch(body, /Your group meets/);
  // The pairing rule: a room with no time is not a fact worth a sentence, and
  // "Your group meets, Hallward B12." is the one shape the tidy cannot repair.
  assert.doesNotMatch(body, /Hallward/);
});

test("a session with a time but no room keeps the sentence and closes it up", () => {
  const body = bodyOf(renderSeed({ sessionWhere: "" }));
  assert.match(body, /Your group meets Tuesday 21 October, 18:00–19:30\./);
  assert.doesNotMatch(body, /,\s*\./);
});

test("a week with no summary written yet loses that paragraph, not its scaffolding", () => {
  const rendered = renderSeed({ weekSummary: "" });
  assert.equal(paragraphsOf(rendered), 5);
  assert.doesNotMatch(bodyOf(rendered), /\{weekSummary\}/);
  assert.doesNotMatch(bodyOf(rendered), /<p><\/p>/);
});

test("a week with nothing to prepare loses that paragraph", () => {
  const rendered = renderSeed({ weekPrep: "" });
  assert.equal(paragraphsOf(rendered), 5);
  assert.doesNotMatch(bodyOf(rendered), /\{weekPrep\}/);
  assert.match(bodyOf(rendered), /Read what you can\./);
});

test("no app URL means no dead link — the whole line goes", () => {
  // The seed's link paragraph holds one token, so the drop rule takes it whole.
  // Shipping `<a href="{weekUrl}">` or `<a href="">` would be a link that looks
  // real and goes nowhere.
  const rendered = renderSeed({ weekUrl: "" });
  assert.equal(paragraphsOf(rendered), 5);
  assert.doesNotMatch(bodyOf(rendered), /\{weekUrl\}/);
  assert.doesNotMatch(bodyOf(rendered), /href=""/);
  assert.doesNotMatch(bodyOf(rendered), /Open this week on the site/);
});

test("an anchor that resolved SOMETHING but has no href is unwrapped, not shipped dead", () => {
  // The mixed case the seed's own copy rule avoids but an admin can write.
  const template = {
    subject: "Week {weekNumber}",
    blocks: [
      {
        id: "b1",
        type: "richText",
        html: '<p>Open <a href="{weekUrl}">week {weekNumber}</a> when you can.</p>',
      },
    ],
  };
  const html = bodyOf(renderCourseNudge(template, buildCourseNudgeTokens(fullInput({ weekUrl: "" }))));
  assert.doesNotMatch(html, /<a\b/);
  assert.doesNotMatch(html, /href/);
  assert.match(html, /Open week 3 when you can\./);
});

test("a week with no title yet still gets a subject and an unbroken sentence", () => {
  const rendered = renderSeed({ weekTitle: "" });
  // The leading separator is trimmed rather than shipped.
  assert.equal(rendered.subject, "Week 3 of AI Safety Fundamentals");
  assert.match(bodyOf(rendered), /Week 3 of AI Safety Fundamentals is open\./);
});

test("a member with neither preferred name nor display name is not greeted 'Hi NAISI,'", () => {
  // `displayNameOf` falls back to "NAISI member" and `firstWord` takes "NAISI".
  // The nudge is handed the placeholder-free name and drops the line instead.
  const rendered = renderSeed({ recipientName: "" });
  const body = bodyOf(rendered);
  assert.doesNotMatch(body, /Hi NAISI/);
  assert.doesNotMatch(body, /Hi ,/);
  assert.doesNotMatch(body, /\{firstName\}/);
  // The greeting is a heading block, so the whole block goes.
  assert.equal(rendered.blocks.filter((b) => b.type === "heading").length, 0);
  // The rest of the email is untouched.
  assert.equal(paragraphsOf(rendered), 6);
  assert.match(body, /Week 3 of AI Safety Fundamentals is open/);
});

test("a subject made entirely of tokens that all resolved empty falls back", () => {
  // It cannot be deleted the way a paragraph can, and "Week of" is worse than
  // either an honest fallback or an empty header.
  const rendered = renderCourseNudge(
    SEED,
    buildCourseNudgeTokens(fullInput({ weekTitle: "", weekNumber: 0, courseTitle: "" })),
  );
  assert.equal(rendered.subject, "This week on your course");
});

test("an unknown token stays literal so an ADMIN notices the typo", () => {
  // The one place the house convention wins over the drop rule: a typo must not
  // silently delete a paragraph, or an admin loses copy with no signal.
  const template = {
    subject: "Week {weekNumber}",
    blocks: [{ id: "b1", type: "richText", html: "<p>This week: {weekTtile}.</p>" }],
  };
  const body = bodyOf(renderCourseNudge(template, buildCourseNudgeTokens(fullInput())));
  assert.match(body, /\{weekTtile\}/);
});

// ===========================================================================
// Degradation — the exhaustive matrix
// ===========================================================================

test("no combination of missing values can ship a brace, a gap or a dead link", () => {
  // THE headline property, over all 2^10 on/off combinations of the seed
  // template's ten tokens. One case at a time is how the three parallel builds
  // each convinced themselves they were fine.
  const keys = [
    "courseTitle",
    "runLabel",
    "weekTitle",
    "weekSummary",
    "sessionWhen",
    "sessionWhere",
    "weekPrep",
    "weekUrl",
    "recipientName",
  ];
  const blanks = { weekNumber: 0 };
  let cases = 0;

  for (let mask = 0; mask < 1 << (keys.length + 1); mask += 1) {
    const overrides = {};
    keys.forEach((key, i) => {
      if (mask & (1 << i)) overrides[key] = "";
    });
    if (mask & (1 << keys.length)) overrides.weekNumber = blanks.weekNumber;

    const rendered = renderSeed(overrides);
    const markup = bodyOf(rendered);
    const readable = readableOf(rendered);
    const where = `mask ${mask}`;

    // 1. Nothing token-shaped, and nothing "undefined", reaches an inbox.
    assert.doesNotMatch(markup, /\{[a-zA-Z][a-zA-Z0-9_]*\}/, where);
    assert.doesNotMatch(rendered.subject, /\{[a-zA-Z][a-zA-Z0-9_]*\}/, where);
    assert.doesNotMatch(markup, /undefined/, where);
    assert.doesNotMatch(rendered.subject, /undefined/, where);

    // 2. No dead link, and no inline wrapper left standing empty.
    assert.doesNotMatch(markup, /href=""/, where);
    assert.doesNotMatch(markup, /<(strong|b|em|i|u|span|a)\b[^>]*>\s*<\/\1>/i, where);
    assert.doesNotMatch(markup, /<p[^>]*>\s*<\/p>/i, where);

    // 3. No stranded punctuation where a token used to be.
    assert.doesNotMatch(readable, /[,;:·]\s*[.,;:!?]/, where);
    assert.doesNotMatch(readable, /\s[.,;!?]/, where);
    assert.doesNotMatch(readable, /\(\s*\)/, where);

    // 4. The subject is always a single, non-empty line — see FIX 6.
    assert.ok(rendered.subject.length > 0, where);
    assert.doesNotMatch(rendered.subject, /[\r\n]/, where);
    assert.equal(rendered.subject, rendered.subject.trim(), where);

    // 5. THE DROP RULE IS EXACT, not a heuristic. The seed's six paragraphs
    //    each disappear under a stated condition and under no other, so the
    //    surviving count is predictable from the mask alone. A renderer that
    //    merely blanked its tokens would keep "Your group meets ." and an
    //    unwrapped "Open this week on the site" pointing nowhere.
    const noWeekNumber = (mask & (1 << keys.length)) !== 0;
    const dropped =
      // "Week N of X is open: T." — only when it has nothing left to say.
      Number(noWeekNumber && overrides.courseTitle === "" && overrides.weekTitle === "") +
      Number(overrides.weekSummary === "") +
      // The pairing blanks the room when there is no time, so one test covers it.
      Number(overrides.sessionWhen === "") +
      Number(overrides.weekPrep === "") +
      Number(overrides.weekUrl === "");
    assert.equal(paragraphsOf(rendered), 6 - dropped, where);
    // The greeting is a heading, and it goes whole rather than reading "Hi ,".
    assert.equal(
      rendered.blocks.filter((b) => b.type === "heading").length,
      overrides.recipientName === "" ? 0 : 1,
      where,
    );

    cases += 1;
  }
  assert.equal(cases, 1024);
});

// ===========================================================================
// FIX 6 + 8g — header hygiene and per-context escaping
// ===========================================================================

test("a multi-line week title cannot put a line break in a Subject header", () => {
  // P9's `parseStaffMessage` rejects CR/LF in a subject outright and explains
  // why. `normalizeCourseWeek` stores titles and summaries with newlines
  // intact, so the nudge collapses every token value to one line instead.
  const rendered = renderSeed({
    weekTitle: "Goal\r\nmisgeneralisation",
    weekSummary: "Line one.\nLine two.",
  });
  assert.doesNotMatch(rendered.subject, /[\r\n]/);
  assert.match(rendered.subject, /Goal misgeneralisation/);
});

test("a token in the subject is collapsed even when the template puts one there", () => {
  const template = { subject: "{weekSummary}", blocks: [] };
  const rendered = renderCourseNudge(
    template,
    buildCourseNudgeTokens(fullInput({ weekSummary: "One.\n\nTwo.\tThree." })),
  );
  assert.equal(rendered.subject, "One. Two. Three.");
});

test("a name is escaped per destination: text in a heading, entities in markup", () => {
  // A heading renders as a React child, which escapes by construction — running
  // it through `escapeHtml` first is how a member called O'Brien is greeted
  // "Hi O&#39;Brien,". A richText block reaches `dangerouslySetInnerHTML`, so
  // the same value must be escaped there.
  const rendered = renderSeed({ recipientName: "O'Brien & Sons" });
  const heading = rendered.blocks.find((b) => b.type === "heading");
  assert.equal(heading.text, "Hi O'Brien,");
  assert.doesNotMatch(heading.text, /&#39;|&amp;/);
});

test("facilitator-authored text reaches a richText block as TEXT, never as markup", () => {
  const rendered = renderSeed({
    weekSummary: 'Reward <script>alert("x")</script> & goal drift',
  });
  const html = bodyOf(rendered);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp; goal drift/);
});

test("an escaped entity survives the punctuation tidy intact", () => {
  // `&quot;` ends in a semicolon, and the stranded-separator rule would eat it
  // the moment a quoted phrase ends a sentence. The tidy masks entities first;
  // this is the assertion that it still does.
  const html = bodyOf(renderSeed({ weekSummary: 'She called it "alignment".' }));
  assert.match(html, /&quot;alignment&quot;\./);
  assert.doesNotMatch(html, /&quot(?!;)/);
});

// ---------------------------------------------------------------------------
// The preheader is TEXT, and the body is MARKUP — the same value, twice
// ---------------------------------------------------------------------------

/** `&amp;` `&#39;` `&#x2014;` — anything whose trailing `;` is structural. */
const ANY_ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][0-9a-fA-F]+);/;

test("the inbox preview line carries no HTML entity", () => {
  // react-email's `<Preview>` renders the preheader as a PLAIN REACT CHILD, so
  // it escapes whatever it is given a second time. Built from the already-
  // escaped `block.html`, an apostrophe or an ampersand in a facilitator's week
  // title reaches the recipient's Gmail snippet as "What&#39;s next".
  //
  // Nothing on screen can catch it: `<Preview>` renders inside
  // `display:none`, so the admin designer and the facilitator panel both look
  // perfect while every real send is broken in the inbox.
  const rendered = renderSeed({
    weekTitle: "What's next",
    weekSummary: "Reward hacking & Goodhart's law.",
  });

  // The BODY is markup and must stay escaped — that half is not the bug.
  assert.match(bodyOf(rendered), /What&#39;s next/);
  assert.match(bodyOf(rendered), /&amp; Goodhart&#39;s law/);

  // The PREHEADER is text.
  assert.doesNotMatch(rendered.preheader, ANY_ENTITY);
  assert.match(rendered.preheader, /is open: What's next\./);
  assert.match(rendered.preheader, /Reward hacking & Goodhart's law\./);
});

test("the preview line decodes ONCE — a literal entity an admin typed survives", () => {
  // A facilitator who types "&amp;" into a week title means those five
  // characters; escaping makes it "&amp;amp;" and a second decode pass would
  // turn it into a bare "&". One pass, so what they typed is what is previewed.
  const rendered = renderSeed({ weekTitle: "Tokens &amp; entities" });
  assert.ok(rendered.preheader.includes("is open: Tokens &amp; entities."));

  // The same rule over template copy the admin authored in the editor, where
  // "&amp;" is what TipTap emits for a typed ampersand.
  const template = {
    subject: "Week {weekNumber}",
    blocks: [{ id: "b1", type: "richText", html: "<p>Q&amp;A on {weekTitle}</p>" }],
  };
  const custom = renderCourseNudge(
    template,
    buildCourseNudgeTokens(fullInput({ weekTitle: "R&D" })),
  );
  assert.equal(custom.preheader, "Q&A on R&D");
});

test("no combination of missing values puts an entity in the preview line", () => {
  // The 1024-case matrix's sibling, cheap enough to run over the same masks:
  // the preheader is built from whatever paragraph survived the drop rule, so
  // which one it is varies with the mask.
  const keys = ["courseTitle", "weekTitle", "weekSummary", "weekPrep"];
  for (let mask = 0; mask < 1 << keys.length; mask += 1) {
    const overrides = { weekTitle: "What's next", weekSummary: "Reward & risk." };
    keys.forEach((key, i) => {
      if (mask & (1 << i)) overrides[key] = "";
    });
    const { preheader } = renderSeed(overrides);
    assert.doesNotMatch(preheader, ANY_ENTITY, `mask ${mask}: ${preheader}`);
    assert.doesNotMatch(preheader, /<[^>]*>/, `mask ${mask}: ${preheader}`);
  }
});

// ===========================================================================
// The token builder and the derived values
// ===========================================================================

test("every token value is a string — absent is \"\", never undefined", () => {
  const tokens = buildCourseNudgeTokens({ weekNumber: 3 });
  for (const key of COURSE_NUDGE_TOKEN_KEYS) {
    assert.equal(typeof tokens[key], "string", `${key} is not a string`);
  }
  assert.equal(tokens.weekNumber, "3");
  assert.equal(tokens.courseTitle, "");
});

test("sessionWhere is blanked whenever sessionWhen is empty", () => {
  const tokens = buildCourseNudgeTokens({
    weekNumber: 3,
    sessionWhen: "   ",
    sessionWhere: "Hallward B12",
  });
  assert.equal(tokens.sessionWhen, "");
  assert.equal(tokens.sessionWhere, "");
});

test("a nonsense week number resolves to empty rather than to a number", () => {
  for (const weekNumber of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(buildCourseNudgeTokens({ weekNumber }).weekNumber, "");
  }
  assert.equal(buildCourseNudgeTokens({ weekNumber: 3.7 }).weekNumber, "3");
});

test("courseNudgeTokensFrom coerces an admin sample map under the same rules", () => {
  const tokens = courseNudgeTokensFrom({
    weekTitle: " Goal\nmisgeneralisation ",
    sessionWhere: "Hallward B12",
    notATokenHere: "ignored",
  });
  assert.equal(tokens.weekTitle, "Goal misgeneralisation");
  // No `sessionWhen`, so the pairing blanks the room here too — the preview
  // degrades the way the send does.
  assert.equal(tokens.sessionWhere, "");
  assert.equal(tokens.weekPrep, "");
  assert.equal("notATokenHere" in tokens, false);
});

test("courseNudgeSessionWhen reads as a date when it has one, a habit when it doesn't", () => {
  const session = {
    weekday: 2,
    startTimeLocal: "18:00",
    durationMinutes: 90,
    location: "Hallward B12",
    meetingUrl: null,
    notes: "",
  };
  assert.equal(
    courseNudgeSessionWhen(session, "2026-10-20"),
    "Tuesday 20 October, 18:00–19:30",
  );
  assert.equal(courseNudgeSessionWhen(session, null), "Tuesdays 18:00–19:30");
  // No time set at all: "" is what makes the whole sentence disappear.
  assert.equal(courseNudgeSessionWhen({ ...session, startTimeLocal: "" }, "2026-10-20"), "");
  assert.equal(courseNudgeSessionWhen(null, "2026-10-20"), "");
});

test("courseNudgeSessionWhere never puts a meeting link in an inbox", () => {
  const base = { weekday: 2, startTimeLocal: "18:00", durationMinutes: 90, notes: "" };
  assert.equal(
    courseNudgeSessionWhere({ ...base, location: "Hallward B12", meetingUrl: null }),
    "Hallward B12",
  );
  assert.equal(
    courseNudgeSessionWhere({ ...base, location: "", meetingUrl: "https://meet.example/abc" }),
    "Online",
  );
  assert.equal(courseNudgeSessionWhere({ ...base, location: "", meetingUrl: null }), "");
});

test("courseNudgeSessionDateKey places the session inside the cohort's own slot", () => {
  // 2026-10-12 is a Monday. Tuesday (2) is the next day; Sunday (0) is six days
  // on, still inside the slot rather than the day before it.
  assert.equal(courseNudgeSessionDateKey("2026-10-12", 2), "2026-10-13");
  assert.equal(courseNudgeSessionDateKey("2026-10-12", 1), "2026-10-12");
  assert.equal(courseNudgeSessionDateKey("2026-10-12", 0), "2026-10-18");
  // Degrades to "" rather than throwing mid-send.
  assert.equal(courseNudgeSessionDateKey("not-a-date", 2), "");
  assert.equal(courseNudgeSessionDateKey("2026-10-12", 9), "");
});

test("courseWeekPrepLine counts only what is actually expected", () => {
  assert.equal(
    courseWeekPrepLine({
      materials: [{}, {}, { optional: true }, {}],
      exercises: [{ required: true }, { required: false }],
      estimatedMinutes: 120,
    }),
    "There are three things to read or watch and one exercise to write up this week, about 2 hours in total.",
  );
  assert.equal(
    courseWeekPrepLine({ materials: [{}], exercises: [], estimatedMinutes: 45 }),
    "There is one thing to read or watch this week, about 45 minutes in total.",
  );
  // Nothing authored yet: "" so the paragraph disappears rather than reading
  // "There are this week."
  assert.equal(courseWeekPrepLine({ materials: [], exercises: [] }), "");
  assert.equal(
    courseWeekPrepLine({ materials: [], exercises: [], estimatedMinutes: 90 }),
    "This week is about 1.5 hours of reading.",
  );
});

test("courseWeekUrl refuses to build a half-formed link", () => {
  assert.equal(
    courseWeekUrl("https://naisi.uk/", "asf-autumn-2026", 3),
    "https://naisi.uk/learn/asf-autumn-2026/weeks/3",
  );
  // An unset NEXT_PUBLIC_APP_URL is the realistic one — it must produce "" so
  // the drop rule removes the link rather than shipping "/learn/…".
  assert.equal(courseWeekUrl("", "asf-autumn-2026", 3), "");
  assert.equal(courseWeekUrl("https://naisi.uk", "", 3), "");
  assert.equal(courseWeekUrl("https://naisi.uk", "asf-autumn-2026", 0), "");
});
