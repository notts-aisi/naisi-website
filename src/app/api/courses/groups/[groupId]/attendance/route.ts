import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import {
  addDaysToKey,
  currentWeekFor,
  isValidDateKey,
  londonWallClockToInstant,
} from "@/lib/courses/weekPlan";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser, type SessionUser } from "@/lib/firebase/session";
import {
  ATTENDANCE_LIMITS,
  ATTENDANCE_STATUSES,
  attendanceDocId,
  type AttendanceStatus,
} from "@/lib/firestore/courseAttendance";
import { normalizeCourseEnrolment } from "@/lib/firestore/courseEnrolments";
import {
  normalizeCourseGroup,
  sessionForWeek,
  type CourseGroupDoc,
} from "@/lib/firestore/courseGroups";
import {
  normalizeCourseRun,
  normalizeCourseWeek,
  type CourseRunDoc,
} from "@/lib/firestore/courses";

/**
 * THE ATTENDANCE REGISTER for one group: the whole grid on GET, one week's
 * marks on POST.
 *
 * `courseAttendance` is `read/write: if false` in firestore.rules — no client
 * ever touches it. This file is the ONLY path to the data in either direction,
 * which is why the access rule, the PII rule and the shape rules all have to be
 * stated here rather than leaned on somewhere else.
 *
 * ── WHO MAY READ AND WRITE (locked product decision) ────────────────────────
 * A facilitator of THIS group, while it is LIVE (`courseGroups.facilitatorUids`
 * on a group that is not archived) ∪ admins. That is the whole list, and it is
 * the SAME list for both verbs: reading a register and marking one are the same
 * act of running the session.
 *  · ARCHIVING A GROUP UNSTAFFS IT — one rule, stated identically in
 *    `runAccess.ts`, the exercises queue, the review route and the page gates.
 *    Admins bypass it: an archived cohort is exactly what an admin is asked to
 *    go back and look at.
 *  · Plain members get 403. Attendance is a roster-wide record — "who else
 *    missed last week" is not a member's to read, even about their own group.
 *    A member's OWN attendance travels on the run overview instead.
 *  · Another group's facilitator, an admissions reviewer and a track lead all
 *    get 403. Admissions is a SEPARATE LANE from the cohort (locked decision)
 *    and staffing a run is not facilitating a group, which is why the run doc
 *    is not consulted for access at all.
 *
 * ── AUTHORIZATION BEFORE EXISTENCE ──────────────────────────────────────────
 * A missing group, an ARCHIVED group and a group you do not facilitate collapse
 * onto the SAME 403 (the P8 precedent), so probing group ids tells you nothing
 * about which ones exist. The honest 404/400 answers below the gate are
 * reachable only by an admin, who could read those documents anyway.
 *
 * ── PII: NAMES ONLY ─────────────────────────────────────────────────────────
 * `displayNameOf` never returns an email. A register is a list of people who
 * did or didn't turn up; it must not double as a mailing list. Anything that
 * needs to reach these people goes through the group email route, which
 * resolves addresses server-side and never hands them out. Every field added
 * below has to be checked against that line.
 *
 * ── MID-RUN JOINERS ─────────────────────────────────────────────────────────
 * `courseEnrolments.joinedWeekNumber` travels with every member and SCOPES the
 * grid: the UI renders the cells before it as inert, and POST REFUSES to write
 * them (see the write gate). Without that, someone who joined in week 5 reads
 * as four weeks absent — a record that is not merely unkind but false.
 */

// ---------------------------------------------------------------------------
// Wire types (the contract the AttendanceGrid renders from)
// ---------------------------------------------------------------------------

export type AttendancePayload = {
  group: { id: string; name: string };
  /**
   * The grid's COLUMNS, in plan order: every taught week that has started (see
   * `columnsFor`). Breaks carry no week doc and no session, so they never
   * appear — a register for "reading week" would be a register for a session
   * that does not happen.
   */
  weeks: Array<{ weekNumber: number; weekId: string; title: string }>;
  /** The grid's ROWS: active members of the group, name-sorted. Names only. */
  members: Array<{ uid: string; displayName: string; joinedWeekNumber: number }>;
  /**
   * The marks, `weekNumber -> uid -> status`. Sparse in BOTH directions: an
   * absent key means "not marked", which is a real and common state (nobody
   * has opened the register yet) and is deliberately distinct from "absent".
   *
   * The outer key is the week NUMBER as a string, because that is what a JSON
   * object key is. `String(weekNumber)` on the client, never the array index.
   */
  records: Record<string, Record<string, AttendanceStatus>>;
};

/** POST's answer. `marked` counts cells written, including cells cleared. */
export type AttendanceMarkResult = {
  ok: true;
  weekNumber: number;
  marked: number;
};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Matches the rules' `weekNumber` bounds and COURSE_FIELD_LIMITS.maxWeekPlanEntries. */
const MAX_WEEK_NUMBER = 60;

/**
 * Roster read cap — the same number the roster and exercises routes use, so
 * all three agree on how big a "group" can be before it stops being one.
 *
 * NOTE the deliberate mismatch with `ATTENDANCE_LIMITS.maxRecords` (40): the
 * register is ONE document with a uid-keyed map, so 40 is a document-shape
 * limit, not a roster limit. A group somewhere between the two can be read here
 * but cannot be fully marked, and the write path says so in a sentence rather
 * than silently dropping the overflow (see the transaction).
 */
const MAX_MEMBERS = 100;

/** Days in one week-plan slot — the plan's own constant, restated locally. */
const DAYS_PER_WEEK = 7;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Dynamic segments arrive URL-DECODED, so a `%2F` reaches us as a real path
 * separator and `doc()` would throw. Same guard as `runAccess.ts`, deliberately
 * identical so the gate and the routes agree on what counts as addressable.
 */
function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

/**
 * Display-name fallback chain: preferred name, then account name, then a
 * neutral placeholder — NEVER an email address, which is what makes this safe
 * for a facilitator-facing register. (Duplicated per route by house convention;
 * the plan's integration checklist has extracting it as its own cleanup.)
 */
function displayNameOf(data: Record<string, unknown>): string {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const preferred = profile.preferredName;
  const display = data.displayName;
  return (
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    "NAISI member"
  );
}

/** A positive integer inside the plan's bounds, or null. */
function parseWeekParam(raw: string | null): number | null {
  if (!raw || !/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_WEEK_NUMBER ? n : null;
}

type TaughtWeek = { weekNumber: number; weekId: string };

/**
 * The run's taught weeks, in PLAN ORDER, defended against a corrupt plan.
 *
 * `sanitizeWeekPlan` checks types but neither the range nor uniqueness of
 * `weekNumber`, and `weekId` is a free string that this route turns into a doc
 * path. So: integers in range only, first entry wins on a duplicate number, and
 * an unaddressable `weekId` costs the column its TITLE (below) but not the
 * column itself — the register is keyed by NUMBER, and a week whose curriculum
 * doc cannot be addressed is still a week the group met in.
 */
function taughtWeeksOf(run: CourseRunDoc): TaughtWeek[] {
  const out: TaughtWeek[] = [];
  const seen = new Set<number>();
  for (const entry of run.weekPlan) {
    if (entry.kind !== "week") continue;
    const n = entry.weekNumber;
    if (!Number.isInteger(n) || n < 1 || n > MAX_WEEK_NUMBER || seen.has(n)) continue;
    seen.add(n);
    out.push({ weekNumber: n, weekId: entry.weekId });
  }
  return out;
}

/**
 * Which columns the grid gets.
 *
 * Default: every taught week up to and including the cohort's CURRENT one —
 * `anchorWeekNumber`, so a group sitting in reading week still sees the taught
 * week it is anchored to rather than losing a column mid-break. Weeks that have
 * not started yet are not columns: an empty register for a session three weeks
 * out is noise a facilitator has to scroll past every time.
 *
 * `?week=N` widens that bound to include N. It is the escape hatch for the two
 * cases the default is wrong for — a group meeting on the very edge of the week
 * roll, and a run whose `startDate` is not authored yet — and it can only ADD
 * columns, never hide one, so it cannot be used to make a marked week vanish.
 *
 * The floor is the first taught week, so the surface is never an empty table
 * with nothing to explain itself.
 */
function columnsFor(
  run: CourseRunDoc,
  taught: TaughtWeek[],
  requestedWeek: number | null,
): TaughtWeek[] {
  let anchor = 0;
  // `currentWeekFor` throws RangeError on an unusable start date, which is a
  // legitimate half-authored state rather than an error — the guard is the
  // module's own prescribed one, and a run with no date simply has no anchor.
  if (isValidDateKey(run.startDate)) {
    anchor = currentWeekFor(run).anchorWeekNumber;
  }
  const first = taught[0]?.weekNumber ?? 0;
  const upTo = Math.max(anchor, requestedWeek ?? 0, first);
  return taught.filter((w) => w.weekNumber <= upTo);
}

/**
 * When the session for `week` actually happens, as an instant — the register's
 * optional `sessionAt`, resolved from the group's slot (or that week's
 * override) at marking time exactly as `courseAttendance.ts` describes.
 *
 * Derived, never taken from the caller: the slot's start day comes from the
 * run's own `startDate` plus the week's index in the plan, and the weekday
 * offset carries it to the group's meeting day inside that slot. Returns null
 * whenever any input is missing or malformed — `sessionAt` is documented as
 * "absent when never resolved", so a half-authored group simply stores no
 * timestamp rather than a wrong one.
 */
function sessionInstantFor(
  run: CourseRunDoc,
  group: CourseGroupDoc,
  week: TaughtWeek,
): Date | null {
  try {
    if (!isValidDateKey(run.startDate)) return null;
    const index = run.weekPlan.findIndex(
      (e) => e.kind === "week" && e.weekNumber === week.weekNumber,
    );
    if (index < 0) return null;
    const session = sessionForWeek(group, week.weekId);
    if (!session.startTimeLocal) return null;

    const slotStartKey = addDaysToKey(run.startDate, index * DAYS_PER_WEEK);
    // Civil weekday of the slot's first day. Parsed at UTC midnight (the same
    // convention `weekPlan.ts` parses every date key with), so no zone offset
    // enters the arithmetic and `getUTCDay()` is the London calendar weekday.
    const slotWeekday = new Date(`${slotStartKey}T00:00:00Z`).getUTCDay();
    const offset = (session.weekday - slotWeekday + DAYS_PER_WEEK) % DAYS_PER_WEEK;
    return londonWallClockToInstant(
      addDaysToKey(slotStartKey, offset),
      session.startTimeLocal,
    );
  } catch {
    // RangeError from a date key that survived the guards. Not resolvable is a
    // documented state for this field; it must never fail a facilitator's mark.
    return null;
  }
}

// ---------------------------------------------------------------------------
// The gate — identical for both verbs
// ---------------------------------------------------------------------------

type Gate =
  | { ok: true; group: CourseGroupDoc; runId: string }
  | { ok: false; response: NextResponse };

/**
 * Resolve the group and decide access in ONE place, so GET and POST cannot
 * drift apart about who may do what — the divergence the exercises route was
 * fixed for. Reading a register and marking one are the same act, so they are
 * gated by the same function rather than by two copies of the same predicate.
 *
 * Callers have already answered the questions that precede this one (malformed
 * id → 404, no session → 401, no Admin SDK → 500); what is left is the single
 * 403, and only then the honest answers an admin may see.
 */
async function gate(
  groupId: string,
  actor: SessionUser,
  db: FirebaseFirestore.Firestore,
): Promise<Gate> {
  const groupSnap = await db.collection("courseGroups").doc(groupId).get();
  const group = groupSnap.exists
    ? normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {})
    : null;

  // The whole access decision, in one expression and off ONE document. See the
  // module comment for why archiving unstaffs a group and why admissions roles
  // are absent from it.
  const isAdmin = actor.role === "admin";
  const facilitatesLiveGroup = Boolean(
    group && !group.archived && group.facilitatorUids.includes(actor.uid),
  );
  if (!isAdmin && !facilitatesLiveGroup) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  // Reachable only by an admin — every other caller is already past the gate on
  // a group that exists, so this discloses nothing they could not read anyway.
  if (!group) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Group not found" }, { status: 404 }),
    };
  }
  if (!group.runId || !isAddressableId(group.runId)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Group is not attached to a run" },
        { status: 400 },
      ),
    };
  }
  return { ok: true, group, runId: group.runId };
}

/**
 * The group's ACTIVE members, name-sorted, with the joined week that scopes
 * their row. Scoped by the GROUP's own `runId` — never a caller parameter — so
 * it is an exact match for the existing (runId, groupId, status) composite
 * index, the same query the roster and exercises routes run.
 */
async function loadMembers(
  db: FirebaseFirestore.Firestore,
  runId: string,
  groupId: string,
): Promise<AttendancePayload["members"]> {
  const memberSnap = await db
    .collection("courseEnrolments")
    .where("runId", "==", runId)
    .where("groupId", "==", groupId)
    .where("status", "==", "active")
    .limit(MAX_MEMBERS)
    .get();

  // Deduplicated by uid. `courseEnrolmentId` binds (run, uid), so a second row
  // for the same person is structurally impossible — but a duplicate here would
  // become a duplicate React key and a second row in the register, and the
  // Map costs nothing.
  const byUid = new Map<string, ReturnType<typeof normalizeCourseEnrolment>>();
  for (const d of memberSnap.docs) {
    const e = normalizeCourseEnrolment(d.id, d.data() ?? {});
    if (e.uid && !byUid.has(e.uid)) byUid.set(e.uid, e);
  }
  const enrolments = [...byUid.values()];

  const uids = [...byUid.keys()];
  const userDocs = uids.length
    ? await db.getAll(...uids.map((uid) => db.collection("users").doc(uid)))
    : [];
  const nameByUid = new Map<string, string>();
  for (const doc of userDocs) {
    if (doc.exists) nameByUid.set(doc.id, displayNameOf(doc.data() ?? {}));
  }

  return enrolments
    .map((e) => ({
      uid: e.uid,
      displayName: nameByUid.get(e.uid) ?? "NAISI member",
      joinedWeekNumber: e.joinedWeekNumber,
    }))
    .sort(
      (a, b) =>
        a.displayName.localeCompare(b.displayName) || a.uid.localeCompare(b.uid),
    );
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  req: Request,
  ctx: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await ctx.params;
  // An unaddressable id names no group at all, so answering it plainly leaks
  // nothing — the same 404 the P8 routes give before their own gate.
  if (!isAddressableId(groupId)) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const weekParam = new URL(req.url).searchParams.get("week");
  const requestedWeek = parseWeekParam(weekParam);
  // Present-but-unparseable is an error; absent is the default view.
  if (weekParam !== null && requestedWeek === null) {
    return NextResponse.json(
      { error: `week must be a whole number between 1 and ${MAX_WEEK_NUMBER}.` },
      { status: 400 },
    );
  }

  const gated = await gate(groupId, actor, db);
  if (!gated.ok) return gated.response;
  const { group, runId } = gated;

  const [runSnap, members] = await Promise.all([
    db.collection("courseRuns").doc(runId).get(),
    loadMembers(db, runId, groupId),
  ]);
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});
  const weeks = columnsFor(run, taughtWeeksOf(run), requestedWeek);

  // Two `getAll`s, one round trip: the week docs (titles only) and the
  // registers themselves. Both are addressed — no queries, no indexes, and the
  // register ids are `attendanceDocId`, which is construct-only by contract.
  const weekCollection = db.collection("courseRuns").doc(runId).collection("weeks");
  const titleRefs = weeks
    .filter((w) => isAddressableId(w.weekId))
    .map((w) => weekCollection.doc(w.weekId));
  const [weekDocs, registerDocs] = await Promise.all([
    titleRefs.length ? db.getAll(...titleRefs) : Promise.resolve([]),
    weeks.length
      ? db.getAll(
          ...weeks.map((w) =>
            db
              .collection("courseAttendance")
              .doc(attendanceDocId(runId, groupId, w.weekNumber)),
          ),
        )
      : Promise.resolve([]),
  ]);

  const titleByWeekId = new Map<string, string>();
  for (const doc of weekDocs) {
    if (doc.exists) {
      titleByWeekId.set(doc.id, normalizeCourseWeek(doc.id, doc.data() ?? {}).title);
    }
  }

  // Columns keyed by DOC ID rather than by array position: `getAll` does answer in
  // request order, but a register landing under the wrong week's column is a
  // silent, plausible-looking lie, and `attendanceDocId` makes the id→week map
  // free. The `weekNumber` FIELD on the doc is not used for this either — the
  // id is what the route addressed, and it is what the payload must agree with.
  const weekByDocId = new Map(
    weeks.map((w) => [attendanceDocId(runId, groupId, w.weekNumber), w.weekNumber]),
  );
  const memberUids = new Set(members.map((m) => m.uid));
  const records: AttendancePayload["records"] = {};
  for (const snap of registerDocs) {
    const weekNumber = weekByDocId.get(snap.id);
    if (!snap.exists || weekNumber === undefined) continue;
    const raw = (snap.data()?.records ?? {}) as Record<string, unknown>;
    const week: Record<string, AttendanceStatus> = {};
    for (const [uid, status] of Object.entries(raw)) {
      // THE ROSTER IS THE FILTER: a mark left behind by someone since removed
      // from the group has no row to sit in, and shipping their uid would hand
      // out an identifier for a person no longer in this facilitator's group.
      // A status this route does not recognise is dropped rather than shipped
      // for a client to guess at.
      if (!memberUids.has(uid)) continue;
      if (!ATTENDANCE_STATUSES.includes(status as AttendanceStatus)) continue;
      week[uid] = status as AttendanceStatus;
    }
    if (Object.keys(week).length > 0) records[String(weekNumber)] = week;
  }

  const payload: AttendancePayload = {
    group: { id: group.id, name: group.name },
    weeks: weeks.map((w) => ({
      weekNumber: w.weekNumber,
      weekId: w.weekId,
      title: titleByWeekId.get(w.weekId) ?? "",
    })),
    members,
    records,
  };

  return NextResponse.json(payload);
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

type IncomingMark = { uid?: unknown; status?: unknown };

/** Thrown inside the transaction, answered as a 409 outside it. */
class RegisterFullError extends Error {}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await ctx.params;
  if (!isAddressableId(groupId)) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // AUTHORIZATION BEFORE THE BODY IS EVEN PARSED — the same ordering the two P9
  // email routes hold. Validating first is how an unauthorized caller gets told
  // "maximum 40 marks" instead of the uniform 403: payload-shape errors are a
  // description of the API, and someone who may not read this register is not
  // owed one. Everything below this line is reachable only by a facilitator of
  // this live group, or an admin.
  const gated = await gate(groupId, actor, db);
  if (!gated.ok) return gated.response;
  const { group, runId } = gated;

  let body: { weekNumber?: unknown; marks?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const weekNumber = body.weekNumber;
  if (
    typeof weekNumber !== "number" ||
    !Number.isInteger(weekNumber) ||
    weekNumber < 1 ||
    weekNumber > MAX_WEEK_NUMBER
  ) {
    return NextResponse.json(
      { error: `weekNumber must be a whole number between 1 and ${MAX_WEEK_NUMBER}.` },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.marks) || body.marks.length === 0) {
    return NextResponse.json({ error: "Nothing to mark." }, { status: 400 });
  }
  // The cap is the register's own (`ATTENDANCE_LIMITS.maxRecords`), applied
  // before the roster query and the transaction: a batch that could not fit the
  // document shouldn't cost those reads. (It no longer runs before EVERYTHING —
  // the gate's single group read precedes it, which is the price of not
  // answering an unauthorized caller with a payload-shape error.)
  if (body.marks.length > ATTENDANCE_LIMITS.maxRecords) {
    return NextResponse.json(
      {
        error: `That's too many marks at once (maximum ${ATTENDANCE_LIMITS.maxRecords}).`,
      },
      { status: 400 },
    );
  }

  // Deduplicated by uid, LAST WINS — one cell, one outcome. `marked` counts
  // these entries rather than the raw array, so the number that comes back is
  // the number of cells that actually changed hands.
  const wanted = new Map<string, AttendanceStatus | null>();
  for (const raw of body.marks as IncomingMark[]) {
    if (!raw || typeof raw !== "object") {
      return NextResponse.json({ error: "That mark looks malformed." }, { status: 400 });
    }
    const uid = raw.uid;
    if (typeof uid !== "string" || !uid) {
      return NextResponse.json({ error: "That mark looks malformed." }, { status: 400 });
    }
    const status = raw.status;
    // `null` is the CLEAR instruction (see the write below), and the only
    // non-status value accepted.
    if (status !== null && !ATTENDANCE_STATUSES.includes(status as AttendanceStatus)) {
      return NextResponse.json(
        { error: `status must be null or one of: ${ATTENDANCE_STATUSES.join(", ")}.` },
        { status: 400 },
      );
    }
    wanted.set(uid, (status as AttendanceStatus | null) ?? null);
  }

  const [runSnap, members] = await Promise.all([
    db.collection("courseRuns").doc(runId).get(),
    loadMembers(db, runId, groupId),
  ]);
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});

  // WEEK VALIDITY IS RECOMPUTED, never trusted: the week must be a TAUGHT week
  // of this run's own plan. A break has no session to attend, and a number
  // outside the plan would mint a register for a week that does not exist.
  const week = taughtWeeksOf(run).find((w) => w.weekNumber === weekNumber);
  if (!week) {
    return NextResponse.json(
      { error: `Week ${weekNumber} isn't a taught week of this run.` },
      { status: 400 },
    );
  }

  // Every uid must be an ACTIVE member of THIS group. Unknown uids are REFUSED,
  // not silently dropped: a register that quietly ignored half a batch would
  // read as "marked" to the facilitator who sent it.
  const memberByUid = new Map(members.map((m) => [m.uid, m]));
  for (const [uid, status] of wanted) {
    const member = memberByUid.get(uid);
    if (!member) {
      return NextResponse.json(
        { error: "Someone in that batch isn't an active member of this group." },
        { status: 400 },
      );
    }
    // MID-RUN JOINERS (plan risk #5). The grid renders these cells inert; the
    // server refuses them, so the scoping is a fact about the data and not a
    // fact about one client. Clearing is exempt — a mark stranded there by an
    // edited `joinedWeekNumber` must stay removable.
    if (status !== null && weekNumber < member.joinedWeekNumber) {
      return NextResponse.json(
        {
          error: `${member.displayName} hadn't joined the group in week ${weekNumber}.`,
        },
        { status: 400 },
      );
    }
  }

  const ref = db
    .collection("courseAttendance")
    .doc(attendanceDocId(runId, groupId, weekNumber));
  const sessionAt = sessionInstantFor(run, group, week);

  try {
    // A TRANSACTION for one document, because the 40-key cap is a property of
    // the MERGED map: two facilitators marking the same session concurrently
    // would each see room and both be right, and the register would end up over
    // the cap that `normalizeCourseAttendance` then silently truncates on read.
    // Raw keys, not the normalised ones, so a doc already over the cap is
    // counted honestly rather than as 40.
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const raw = (snap.data()?.records ?? {}) as Record<string, unknown>;
      const keys = new Set(Object.keys(raw));
      for (const [uid, status] of wanted) {
        if (status === null) keys.delete(uid);
        else keys.add(uid);
      }
      if (keys.size > ATTENDANCE_LIMITS.maxRecords) {
        throw new RegisterFullError();
      }

      // `set(..., { merge: true })` rather than `update()`: it creates the
      // register on the first mark of a week and merges the `records` MAP key
      // by key on every later one, so two facilitators marking different people
      // never overwrite each other. It is also the dot-safe form — with
      // `update()` a uid would be parsed as a field PATH, whereas nested keys
      // in `set()` are literal field names.
      const records: Record<string, AttendanceStatus | FieldValue> = {};
      for (const [uid, status] of wanted) {
        // Clearing removes the MAP KEY (never the document): the register is
        // shared, and "not marked" is the absence of a key, not a status.
        records[uid] = status === null ? FieldValue.delete() : status;
      }

      tx.set(
        ref,
        {
          // The id is construct-only by contract, so the parts live as fields.
          runId,
          groupId,
          weekNumber,
          records,
          markedByUid: actor.uid,
          updatedAt: FieldValue.serverTimestamp(),
          // Only when it resolves — the field is documented as absent
          // otherwise, and a merge must not write `undefined`.
          ...(sessionAt ? { sessionAt } : {}),
        },
        { merge: true },
      );
    });
  } catch (err) {
    if (err instanceof RegisterFullError) {
      return NextResponse.json(
        {
          error: `This register is full (maximum ${ATTENDANCE_LIMITS.maxRecords} people). A group this size needs splitting.`,
        },
        { status: 409 },
      );
    }
    throw err;
  }

  const result: AttendanceMarkResult = {
    ok: true,
    weekNumber,
    marked: wanted.size,
  };
  return NextResponse.json(result);
}
