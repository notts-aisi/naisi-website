import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { isValidDateKey } from "@/lib/courses/weekPlan";
import { memberCurrentWeek, resolveCalendar } from "@/lib/courses/groupResolve";
import { readMirrorPlan, type RegisterOverride } from "@/lib/courses/attendanceMirror";
import {
  gateGroupRegister,
  isAddressableId,
  loadRegisterMembers,
  type RegisterMember,
} from "@/lib/courses/registerAccess";
import {
  resolveSessions,
  sessionInstants,
  type ResolvedSession,
} from "@/lib/courses/sessions";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  ATTENDANCE_LIMITS,
  ATTENDANCE_STATUSES,
  ATTENDANCE_STATUS_LABEL,
  attendanceDocId,
  type AttendanceStatus,
} from "@/lib/firestore/courseAttendance";
import { COURSE_AUDIT_COLLECTION } from "@/lib/firestore/courseAudit";
import type { CourseGroupDoc } from "@/lib/firestore/courseGroups";
import {
  normalizeCourseRun,
  normalizeCourseWeek,
  type CourseRunDoc,
} from "@/lib/firestore/courses";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";

/**
 * THE ATTENDANCE REGISTER for one group: the whole grid on GET, one session's
 * marks on POST, an admin's correction to a LOCKED register on PATCH.
 *
 * `courseAttendance` is `read/write: if false` in firestore.rules, so no
 * client ever touches it. This file and its two siblings (`attendance/push`,
 * `participant-notes`) are the only paths to the data in either direction.
 * The access rule lives in `src/lib/courses/registerAccess.ts` so all four
 * verbs answer to one predicate.
 *
 * ── A COLUMN IS A SESSION, NOT A WEEK ───────────────────────────────────────
 * Columns come from `resolveSessions`, so a group that meets twice in a week
 * gets two, each with its own register document, its own held switch and its
 * own push. For every group that meets once, which is all of them today, the
 * columns and the register ids are exactly what they were.
 *
 * ── THE DRAFT / PUSHED BOUNDARY ─────────────────────────────────────────────
 * A register is a DRAFT the facilitator saves as often as they like during the
 * session, and PUSH ATTENDANCE is the state change: the register locks, the
 * enrolment rollups are recomputed from it, and the group's next-session
 * reminder goes out. After that:
 *  · POST REFUSES. A facilitator who needs a mark changed asks an admin, and
 *    the reason is not procedural: the push is what mailed the group and moved
 *    the numbers a reviewer reads, so a quiet edit afterwards would leave the
 *    record and the mirror describing different sessions.
 *  · PATCH is that admin's door, and every mark it moves appends its own
 *    `courseAudit` row saying what changed and from what to what.
 * A learner sees their own mark only once the register is pushed, which is
 * what makes the draft a draft.
 *
 * ── MID-RUN JOINERS ─────────────────────────────────────────────────────────
 * `courseEnrolments.joinedWeekNumber` travels with every member and SCOPES the
 * grid: the UI renders the cells before it as inert, and the write gate
 * REFUSES them. Without that, someone who joined in week 5 reads as four weeks
 * absent, a record that is not merely unkind but false.
 *
 * ── V2-3: THE COLUMNS ARE THE GROUP'S RHYTHM ────────────────────────────────
 * Every calendar question here is asked of the GROUP's resolved calendar: its
 * own pacing when its facilitator has set one, the run's otherwise. A group
 * that inserted its own reading week is a group that did not meet that week,
 * and a register offering a column for a session nobody held invites a
 * facilitator to mark a room full of people absent from a class that never
 * happened. Column TITLES resolve group-first too, so a week the facilitator
 * has forked and renamed reads under the name their members see.
 */

// ---------------------------------------------------------------------------
// Wire types (the contract the AttendanceGrid renders from)
// ---------------------------------------------------------------------------

/** One column: a session the group holds, and the state of its register. */
export type AttendanceSession = {
  weekNumber: number;
  /** 1-based. Two sessions in one week differ only here and in `sessionKey`. */
  occurrence: number;
  /** `sessionKey(weekNumber, occurrence)`. The key of every map below. */
  sessionKey: string;
  weekId: string;
  title: string;
  /** Civil date of the session, or "" when the calendar cannot resolve one. */
  dateKey: string;
  /** False = the session did not happen. Out of every denominator. */
  held: boolean;
  /** The facilitator's note on the session as a whole. */
  notes: string;
  /** ISO instant of PUSH ATTENDANCE, or null while this is still a draft. */
  pushedAt: string | null;
};

export type AttendancePayload = {
  group: { id: string; name: string };
  /**
   * The grid's COLUMNS, in plan order: every session that has started (see
   * `columnsFor`). Breaks carry no week and no session, so they never appear.
   */
  sessions: AttendanceSession[];
  /** The grid's ROWS: active members of the group, name-sorted. Names only. */
  members: RegisterMember[];
  /**
   * The marks, `sessionKey -> uid -> status`. Sparse in BOTH directions: an
   * absent key means "not marked", which is a real and common state (nobody
   * has opened the register yet) and is deliberately distinct from "absent".
   */
  records: Record<string, Record<string, AttendanceStatus>>;
  /**
   * Post-session notes about individual participants, `sessionKey -> uid ->
   * note`. PERSONAL DATA ABOUT A NAMED STUDENT: served only to the people this
   * route's gate admits, never to the cohort and never to the member it is
   * about. The drawer that renders them says so in as many words.
   */
  participantNotes: Record<string, Record<string, string>>;
  /** True when the caller may correct a register that is already pushed. */
  canEditPushed: boolean;
};

/** POST's answer. `marked` counts cells written, including cells cleared. */
export type AttendanceMarkResult = {
  ok: true;
  sessionKey: string;
  weekNumber: number;
  occurrence: number;
  marked: number;
  held: boolean;
};

/** PATCH's answer: the same, plus how many audit rows it appended. */
export type AttendanceEditResult = AttendanceMarkResult & { logged: number };

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Matches the rules' `weekNumber` bounds and COURSE_FIELD_LIMITS.maxWeekPlanEntries. */
const MAX_WEEK_NUMBER = 60;

/** A group meeting more than twice in one week is not a shape this supports. */
const MAX_OCCURRENCE = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A positive integer inside the plan's bounds, or null. */
function parseWeekParam(raw: string | null): number | null {
  if (!raw || !/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_WEEK_NUMBER ? n : null;
}

/**
 * Which columns the grid gets.
 *
 * Default: every session up to and including the cohort's CURRENT week,
 * `anchorWeekNumber`, so a group sitting in reading week still sees the taught
 * week it is anchored to rather than losing a column mid-break. Sessions that
 * have not started yet are not columns: an empty register for a session three
 * weeks out is noise a facilitator has to scroll past every time.
 *
 * `?week=N` widens that bound to include N. It is the escape hatch for the two
 * cases the default is wrong for, a group meeting on the very edge of the week
 * roll and a run whose `startDate` is not authored yet, and it can only ADD
 * columns, never hide one, so it cannot be used to make a marked session
 * vanish. The floor is the first session, so the surface is never an empty
 * table with nothing to explain itself.
 */
export function columnsFor(
  run: CourseRunDoc,
  group: CourseGroupDoc,
  sessions: ResolvedSession[],
  requestedWeek: number | null,
): ResolvedSession[] {
  let anchor = 0;
  // The week maths throws RangeError on an unusable start date, which is a
  // legitimate half-authored state rather than an error. Guarded on the
  // RESOLVED date, since a group's pacing override can be half-authored
  // exactly as a run's can.
  if (isValidDateKey(resolveCalendar(run, group).startDate)) {
    anchor = memberCurrentWeek(run, group).anchorWeekNumber;
  }
  const first = sessions[0]?.weekNumber ?? 0;
  const upTo = Math.max(anchor, requestedWeek ?? 0, first);
  return sessions.filter((s) => s.weekNumber <= upTo);
}

/** The body shape all three write paths parse out of a request. */
type SessionTarget = { weekNumber: number; occurrence: number };

function parseSessionTarget(
  body: Record<string, unknown>,
): { ok: true; value: SessionTarget } | { ok: false; error: string } {
  const weekNumber = body.weekNumber;
  if (
    typeof weekNumber !== "number" ||
    !Number.isInteger(weekNumber) ||
    weekNumber < 1 ||
    weekNumber > MAX_WEEK_NUMBER
  ) {
    return {
      ok: false,
      error: `weekNumber must be a whole number between 1 and ${MAX_WEEK_NUMBER}.`,
    };
  }
  const raw = body.occurrence;
  // ABSENT MEANS THE WEEK'S FIRST SESSION, which is what every client that
  // predates the occurrence dimension means by "week N".
  const occurrence = raw === undefined || raw === null ? 1 : raw;
  if (
    typeof occurrence !== "number" ||
    !Number.isInteger(occurrence) ||
    occurrence < 1 ||
    occurrence > MAX_OCCURRENCE
  ) {
    return {
      ok: false,
      error: `occurrence must be a whole number between 1 and ${MAX_OCCURRENCE}.`,
    };
  }
  return { ok: true, value: { weekNumber, occurrence } };
}

type IncomingMark = { uid?: unknown; status?: unknown };

/**
 * The marks a write path is asking for, deduplicated by uid, LAST WINS. One
 * cell, one outcome, and the count that comes back is the number of cells that
 * actually changed hands rather than the length of the array.
 */
function parseMarks(
  raw: unknown,
): { ok: true; value: Map<string, AttendanceStatus | null> } | { ok: false; error: string } {
  const wanted = new Map<string, AttendanceStatus | null>();
  if (raw === undefined || raw === null) return { ok: true, value: wanted };
  if (!Array.isArray(raw)) return { ok: false, error: "marks must be a list." };
  if (raw.length > ATTENDANCE_LIMITS.maxRecords) {
    return {
      ok: false,
      error: `That's too many marks at once (maximum ${ATTENDANCE_LIMITS.maxRecords}).`,
    };
  }
  for (const entry of raw as IncomingMark[]) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: "That mark looks malformed." };
    }
    const uid = entry.uid;
    if (typeof uid !== "string" || !uid) {
      return { ok: false, error: "That mark looks malformed." };
    }
    const status = entry.status;
    // `null` is the CLEAR instruction, and the only non-status value accepted.
    if (status !== null && !ATTENDANCE_STATUSES.includes(status as AttendanceStatus)) {
      return {
        ok: false,
        error: `status must be null or one of: ${ATTENDANCE_STATUSES.join(", ")}.`,
      };
    }
    wanted.set(uid, (status as AttendanceStatus | null) ?? null);
  }
  return { ok: true, value: wanted };
}

/**
 * Every uid must be an ACTIVE member of THIS group, and no mark may land
 * before the week they joined. Unknown uids are REFUSED, not silently dropped:
 * a register that quietly ignored half a batch would read as "marked" to the
 * facilitator who sent it.
 *
 * Clearing is exempt from the joined-week floor: a mark stranded there by an
 * edited `joinedWeekNumber` must stay removable.
 */
function checkMarksAgainstRoster(
  marks: Map<string, AttendanceStatus | null>,
  members: RegisterMember[],
  weekNumber: number,
): string | null {
  const byUid = new Map(members.map((m) => [m.uid, m]));
  for (const [uid, status] of marks) {
    const member = byUid.get(uid);
    if (!member) return "Someone in that batch isn't an active member of this group.";
    if (status !== null && weekNumber < member.joinedWeekNumber) {
      return `${member.displayName} hadn't joined the group in week ${weekNumber}.`;
    }
  }
  return null;
}

/** Free-text session note, bounded and collapsed to what the doc will hold. */
function parseNotes(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "The session note must be text." };
  const text = raw.trim();
  if (text.length > ATTENDANCE_LIMITS.notes) {
    return {
      ok: false,
      error: `That note is too long (maximum ${ATTENDANCE_LIMITS.notes} characters).`,
    };
  }
  return { ok: true, value: text };
}

// ---------------------------------------------------------------------------
// Shared setup for the two write verbs
// ---------------------------------------------------------------------------

type WriteContext = {
  actor: Awaited<ReturnType<typeof getCurrentUser>> & object;
  db: FirebaseFirestore.Firestore;
  group: CourseGroupDoc;
  run: CourseRunDoc;
  runId: string;
  isAdmin: boolean;
  sessions: ResolvedSession[];
  session: ResolvedSession;
  members: RegisterMember[];
  body: Record<string, unknown>;
};

/**
 * Everything both write paths need, in the order that keeps an unauthorized
 * caller from learning the API's shape: gate first, body second.
 *
 * Validating first is how an unauthorized caller gets told "maximum 40 marks"
 * instead of the uniform 403. Payload-shape errors are a description of the
 * API, and someone who may not read this register is not owed one.
 */
async function prepareWrite(
  groupId: string,
  req: Request,
): Promise<{ ok: true; ctx: WriteContext } | { ok: false; response: NextResponse }> {
  const fail = (error: string, status: number) => ({
    ok: false as const,
    response: NextResponse.json({ error }, { status }),
  });

  if (!isAddressableId(groupId)) return fail("Group not found", 404);

  const actor = await getCurrentUser();
  if (!actor) return fail("Not signed in", 401);

  const db = getAdminDb();
  if (!db) return fail("Server not configured", 500);

  const gated = await gateGroupRegister(groupId, actor, db);
  if (!gated.ok) return fail(gated.error, gated.status);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("Invalid JSON body", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("Expected a JSON object body.", 400);
  }

  const target = parseSessionTarget(body);
  if (!target.ok) return fail(target.error, 400);

  const [runSnap, members] = await Promise.all([
    db.collection("courseRuns").doc(gated.runId).get(),
    loadRegisterMembers(db, gated.runId, groupId),
  ]);
  if (!runSnap.exists) return fail("Run not found", 404);
  const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});

  // SESSION VALIDITY IS RECOMPUTED, never trusted: the session must be one
  // THIS GROUP holds. A break has no session to attend, and a week number
  // outside the plan would mint a register for a session that does not exist.
  const sessions = resolveSessions(run, gated.group);
  const session = sessions.find(
    (s) =>
      s.weekNumber === target.value.weekNumber &&
      s.occurrence === target.value.occurrence,
  );
  if (!session) {
    return fail(
      `Week ${target.value.weekNumber} isn't a taught session of this group's schedule.`,
      400,
    );
  }

  return {
    ok: true,
    ctx: {
      actor,
      db,
      group: gated.group,
      run,
      runId: gated.runId,
      isAdmin: gated.isAdmin,
      sessions,
      session,
      members,
      body,
    },
  };
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
  // nothing: the same 404 the P8 routes give before their own gate.
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

  const gated = await gateGroupRegister(groupId, actor, db);
  if (!gated.ok) {
    return NextResponse.json({ error: gated.error }, { status: gated.status });
  }
  const { group, runId } = gated;

  const [runSnap, members] = await Promise.all([
    db.collection("courseRuns").doc(runId).get(),
    loadRegisterMembers(db, runId, groupId),
  ]);
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});
  const columns = columnsFor(run, group, resolveSessions(run, group), requestedWeek);

  // Three `getAll`s, one round trip: the canonical week docs (titles only),
  // this group's forked copies of the same weeks, and the registers
  // themselves. All addressed, so no queries, no indexes, and the register ids
  // are `attendanceDocId`, which is construct-only by contract. The two week
  // reads are deduplicated because two sessions of one week share a week doc.
  const weekCollection = db.collection("courseRuns").doc(runId).collection("weeks");
  const forkCollection = db.collection("courseGroups").doc(groupId).collection("weeks");
  const weekIds = [...new Set(columns.map((c) => c.weekId))].filter(isAddressableId);
  const [weekDocs, forkDocs, registerDocs] = await Promise.all([
    weekIds.length
      ? db.getAll(...weekIds.map((id) => weekCollection.doc(id)))
      : Promise.resolve([]),
    weekIds.length
      ? db.getAll(...weekIds.map((id) => forkCollection.doc(id)))
      : Promise.resolve([]),
    columns.length
      ? db.getAll(
          ...columns.map((c) =>
            db
              .collection("courseAttendance")
              .doc(attendanceDocId(runId, groupId, c.weekNumber, c.occurrence)),
          ),
        )
      : Promise.resolve([]),
  ]);

  // Canonical first, the group's fork laid over it: the same overlay the
  // overview route applies to the rail, so staff and members read one title.
  const titleByWeekId = new Map<string, string>();
  for (const doc of [...weekDocs, ...forkDocs]) {
    if (doc.exists) {
      titleByWeekId.set(doc.id, normalizeCourseWeek(doc.id, doc.data() ?? {}).title);
    }
  }

  // Columns keyed by DOC ID rather than by array position: `getAll` does
  // answer in request order, but a register landing under the wrong session's
  // column is a silent, plausible-looking lie, and `attendanceDocId` makes the
  // id to session map free.
  const sessionByDocId = new Map(
    columns.map((c) => [
      attendanceDocId(runId, groupId, c.weekNumber, c.occurrence),
      c,
    ]),
  );
  const memberUids = new Set(members.map((m) => m.uid));
  const records: AttendancePayload["records"] = {};
  const participantNotes: AttendancePayload["participantNotes"] = {};
  const stateByKey = new Map<string, { held: boolean; notes: string; pushedAt: string | null }>();

  for (const snap of registerDocs) {
    const column = sessionByDocId.get(snap.id);
    if (!snap.exists || !column) continue;
    const data = snap.data() ?? {};
    const raw = (data.records ?? {}) as Record<string, unknown>;
    const week: Record<string, AttendanceStatus> = {};
    for (const [uid, status] of Object.entries(raw)) {
      // THE ROSTER IS THE FILTER: a mark left behind by someone since removed
      // from the group has no row to sit in, and shipping their uid would hand
      // out an identifier for a person no longer in this facilitator's group.
      if (!memberUids.has(uid)) continue;
      if (!ATTENDANCE_STATUSES.includes(status as AttendanceStatus)) continue;
      week[uid] = status as AttendanceStatus;
    }
    if (Object.keys(week).length > 0) records[column.sessionKey] = week;

    const rawNotes = (data.participantNotes ?? {}) as Record<string, unknown>;
    const notes: Record<string, string> = {};
    for (const [uid, note] of Object.entries(rawNotes)) {
      if (!memberUids.has(uid)) continue;
      if (typeof note !== "string" || !note) continue;
      notes[uid] = note.slice(0, ATTENDANCE_LIMITS.participantNote);
    }
    if (Object.keys(notes).length > 0) participantNotes[column.sessionKey] = notes;

    const pushedAt = data.pushedAt as { toDate?: () => Date } | undefined;
    stateByKey.set(column.sessionKey, {
      held: data.held !== false,
      notes: typeof data.notes === "string" ? data.notes : "",
      pushedAt:
        pushedAt && typeof pushedAt.toDate === "function"
          ? pushedAt.toDate().toISOString()
          : null,
    });
  }

  const payload: AttendancePayload = {
    group: { id: group.id, name: group.name },
    sessions: columns.map((c) => {
      const state = stateByKey.get(c.sessionKey);
      return {
        weekNumber: c.weekNumber,
        occurrence: c.occurrence,
        sessionKey: c.sessionKey,
        weekId: c.weekId,
        title: titleByWeekId.get(c.weekId) ?? "",
        dateKey: c.dateKey,
        // A session with no register yet HELD, which is the same default the
        // normaliser applies: nobody has said otherwise.
        held: state?.held ?? true,
        notes: state?.notes ?? "",
        pushedAt: state?.pushedAt ?? null,
      };
    }),
    members,
    records,
    participantNotes,
    canEditPushed: gated.isAdmin,
  };

  return NextResponse.json(payload);
}

// ---------------------------------------------------------------------------
// POST: marking a DRAFT register
// ---------------------------------------------------------------------------

/** Thrown inside a transaction, answered as a status outside it. */
class RegisterFullError extends Error {}
/** POST met a register that has already been pushed. */
class RegisterLockedError extends Error {}
/** PATCH met a session nobody has opened a register for. */
class RegisterMissingError extends Error {}
/** PATCH met a register that is still the facilitator's draft. */
class RegisterUnpushedError extends Error {}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ groupId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { groupId } = await ctx.params;
  const prepared = await prepareWrite(groupId, req);
  if (!prepared.ok) return prepared.response;
  const { actor, db, runId, session, members, body } = prepared.ctx;

  const parsedMarks = parseMarks(body.marks);
  if (!parsedMarks.ok) {
    return NextResponse.json({ error: parsedMarks.error }, { status: 400 });
  }
  const wanted = parsedMarks.value;

  const hasHeld = body.held !== undefined;
  if (hasHeld && typeof body.held !== "boolean") {
    return NextResponse.json({ error: "held must be true or false." }, { status: 400 });
  }
  const hasNotes = body.notes !== undefined;
  let notes = "";
  if (hasNotes) {
    const parsed = parseNotes(body.notes);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    notes = parsed.value;
  }

  if (wanted.size === 0 && !hasHeld && !hasNotes) {
    return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
  }

  const rosterError = checkMarksAgainstRoster(wanted, members, session.weekNumber);
  if (rosterError) return NextResponse.json({ error: rosterError }, { status: 400 });

  const ref = db
    .collection("courseAttendance")
    .doc(attendanceDocId(runId, groupId, session.weekNumber, session.occurrence));
  const { startsAt } = sessionInstants(session);

  try {
    // A TRANSACTION for one document, because the 40-key cap is a property of
    // the MERGED map: two facilitators marking the same session concurrently
    // would each see room and both be right, and the register would end up
    // over the cap that `normalizeCourseAttendance` then silently truncates on
    // read. Raw keys, not the normalised ones, so a doc already over the cap
    // is counted honestly rather than as 40.
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data() ?? {};
      // THE LOCK. A pushed register has already mailed the group and moved the
      // rollups a reviewer reads; a later draft-lane write would leave the two
      // describing different sessions. PATCH is the admin's door.
      if (data.pushedAt) throw new RegisterLockedError();

      const raw = (data.records ?? {}) as Record<string, unknown>;
      const keys = new Set(Object.keys(raw));
      for (const [uid, status] of wanted) {
        if (status === null) keys.delete(uid);
        else keys.add(uid);
      }
      if (keys.size > ATTENDANCE_LIMITS.maxRecords) throw new RegisterFullError();

      // `set(..., { merge: true })` rather than `update()`: it creates the
      // register on the first mark of a session and merges the `records` MAP
      // key by key on every later one, so two facilitators marking different
      // people never overwrite each other. It is also the dot-safe form: with
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
          weekNumber: session.weekNumber,
          occurrence: session.occurrence,
          records,
          markedByUid: actor.uid,
          updatedAt: FieldValue.serverTimestamp(),
          ...(hasHeld ? { held: body.held === true } : {}),
          ...(hasNotes ? { notes } : {}),
          // Only when it resolves: the field is documented as absent
          // otherwise, and a merge must not write `undefined`.
          ...(startsAt ? { sessionAt: startsAt } : {}),
        },
        { merge: true },
      );
    });
  } catch (err) {
    if (err instanceof RegisterLockedError) {
      return NextResponse.json(
        {
          error:
            "This register has been pushed, so it's locked. An admin can still correct it.",
        },
        { status: 409 },
      );
    }
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
    sessionKey: session.sessionKey,
    weekNumber: session.weekNumber,
    occurrence: session.occurrence,
    marked: wanted.size,
    held: hasHeld ? body.held === true : true,
  };
  return NextResponse.json(result);
}

// ---------------------------------------------------------------------------
// PATCH: an admin correcting a LOCKED register
// ---------------------------------------------------------------------------

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ groupId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { groupId } = await ctx.params;
  const prepared = await prepareWrite(groupId, req);
  if (!prepared.ok) return prepared.response;
  const { actor, db, runId, isAdmin, sessions, session, members, body } = prepared.ctx;

  // ADMIN ONLY, and checked before the body is looked at any further. The push
  // is the facilitator's last word on a session; correcting it afterwards is
  // an administrative act with a name attached to it.
  if (!isAdmin) {
    return NextResponse.json(
      { error: "Only an admin can change a register after it has been pushed." },
      { status: 403 },
    );
  }

  const parsedMarks = parseMarks(body.marks);
  if (!parsedMarks.ok) {
    return NextResponse.json({ error: parsedMarks.error }, { status: 400 });
  }
  const wanted = parsedMarks.value;
  const hasHeld = body.held !== undefined;
  if (hasHeld && typeof body.held !== "boolean") {
    return NextResponse.json({ error: "held must be true or false." }, { status: 400 });
  }
  if (wanted.size === 0 && !hasHeld) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  const rosterError = checkMarksAgainstRoster(wanted, members, session.weekNumber);
  if (rosterError) return NextResponse.json({ error: rosterError }, { status: 400 });

  const ref = db
    .collection("courseAttendance")
    .doc(attendanceDocId(runId, groupId, session.weekNumber, session.occurrence));
  const now = new Date();
  const actorName = actor.displayName ?? "";
  const memberName = new Map(members.map((m) => [m.uid, m.displayName]));

  let logged = 0;
  let changed = 0;
  try {
    await db.runTransaction(async (tx) => {
      logged = 0;
      changed = 0;
      const snap = await tx.get(ref);
      if (!snap.exists) throw new RegisterMissingError();
      const data = snap.data() ?? {};
      // PATCH is the LOCKED lane. A draft register is the facilitator's to
      // finish, and letting an admin type into one from a different surface
      // would leave two doors onto one unfinished document.
      if (!data.pushedAt) throw new RegisterUnpushedError();

      const stored = (data.records ?? {}) as Record<string, unknown>;
      const before = new Map<string, AttendanceStatus | null>();
      for (const uid of wanted.keys()) {
        const value = stored[uid];
        before.set(
          uid,
          ATTENDANCE_STATUSES.includes(value as AttendanceStatus)
            ? (value as AttendanceStatus)
            : null,
        );
      }
      const heldBefore = data.held !== false;
      const heldAfter = hasHeld ? body.held === true : heldBefore;

      // Only the marks that actually MOVE are written or logged. An audit row
      // per unchanged cell would bury the one row that matters.
      const moved = [...wanted.entries()].filter(
        ([uid, status]) => (before.get(uid) ?? null) !== status,
      );
      changed = moved.length;

      const keys = new Set(Object.keys(stored));
      for (const [uid, status] of moved) {
        if (status === null) keys.delete(uid);
        else keys.add(uid);
      }
      if (keys.size > ATTENDANCE_LIMITS.maxRecords) throw new RegisterFullError();

      // EVERY READ BEFORE EVERY WRITE. The mirror plan reads the group's other
      // registers and the enrolments, so it has to run before the write below.
      const overrides = new Map<string, RegisterOverride>([
        [
          session.sessionKey,
          {
            marks: new Map(moved),
            held: heldAfter,
            // Already pushed, and staying pushed. Stated so the recompute
            // counts this session whatever the read raced with.
            pushedAt: (data.pushedAt as { toDate?: () => Date })?.toDate?.() ?? now,
          },
        ],
      ]);
      const plan = await readMirrorPlan(tx, db, {
        runId,
        groupId,
        sessions,
        members,
        overrides,
        now,
      });

      if (moved.length > 0 || heldAfter !== heldBefore) {
        const records: Record<string, AttendanceStatus | FieldValue> = {};
        for (const [uid, status] of moved) {
          records[uid] = status === null ? FieldValue.delete() : status;
        }
        tx.set(
          ref,
          {
            records,
            ...(hasHeld ? { held: heldAfter } : {}),
            updatedAt: FieldValue.serverTimestamp(),
            // `markedByUid` is deliberately NOT moved to the admin: it records
            // who ran the session. Who corrected it afterwards is what the
            // audit rows are for.
          },
          { merge: true },
        );
      }

      for (const write of plan.writes) {
        tx.set(write.ref, { attendance: write.rollup }, { merge: true });
      }

      // ONE AUDIT ROW PER CHANGED MARK, with the before and the after in the
      // sentence. A single row saying "the register was edited" would answer
      // none of the questions the log exists for.
      for (const [uid, status] of moved) {
        const from = before.get(uid) ?? null;
        tx.set(db.collection(COURSE_AUDIT_COLLECTION).doc(), {
          kind: "attendance-edit",
          runId,
          groupId,
          subjectUid: uid,
          actorUid: actor.uid,
          actorName,
          targetLabel: `${session.sessionKey} register`,
          detail:
            `${memberName.get(uid) ?? uid}: ` +
            `${from ? ATTENDANCE_STATUS_LABEL[from] : "not marked"} to ` +
            `${status ? ATTENDANCE_STATUS_LABEL[status] : "not marked"}, ` +
            `week ${session.weekNumber} session ${session.occurrence}.`,
          at: FieldValue.serverTimestamp(),
        });
        logged += 1;
      }
      if (heldAfter !== heldBefore) {
        tx.set(db.collection(COURSE_AUDIT_COLLECTION).doc(), {
          kind: "attendance-edit",
          runId,
          groupId,
          subjectUid: null,
          actorUid: actor.uid,
          actorName,
          targetLabel: `${session.sessionKey} register`,
          detail: heldAfter
            ? `Week ${session.weekNumber} session ${session.occurrence} marked as held again, so it counts in everyone's attendance.`
            : `Week ${session.weekNumber} session ${session.occurrence} marked as not held, so it leaves everyone's attendance.`,
          at: FieldValue.serverTimestamp(),
        });
        logged += 1;
      }
    });
  } catch (err) {
    if (err instanceof RegisterMissingError) {
      return NextResponse.json(
        { error: "There's no register for that session yet." },
        { status: 404 },
      );
    }
    if (err instanceof RegisterUnpushedError) {
      return NextResponse.json(
        {
          error:
            "That register hasn't been pushed yet, so it is still the facilitator's to mark.",
        },
        { status: 409 },
      );
    }
    if (err instanceof RegisterFullError) {
      return NextResponse.json(
        {
          error: `This register is full (maximum ${ATTENDANCE_LIMITS.maxRecords} people).`,
        },
        { status: 409 },
      );
    }
    throw err;
  }

  const result: AttendanceEditResult = {
    ok: true,
    sessionKey: session.sessionKey,
    weekNumber: session.weekNumber,
    occurrence: session.occurrence,
    marked: changed,
    held: hasHeld ? body.held === true : true,
    logged,
  };
  return NextResponse.json(result);
}
