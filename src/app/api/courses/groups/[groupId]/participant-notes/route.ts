import { NextResponse } from "next/server";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import {
  gateGroupRegister,
  isAddressableId,
  loadRegisterMembers,
} from "@/lib/courses/registerAccess";
import { resolveSessions } from "@/lib/courses/sessions";
import { getAdminDb } from "@/lib/firebase/admin";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  ATTENDANCE_LIMITS,
  attendanceDocId,
} from "@/lib/firestore/courseAttendance";
import { normalizeCourseRun } from "@/lib/firestore/courses";

/**
 * PARTICIPANT NOTES: what a facilitator wants to remember about ONE person
 * after ONE session.
 *
 * ── THIS IS PERSONAL DATA ABOUT A NAMED STUDENT, WRITTEN BY ANOTHER STUDENT ─
 * Everything about this route follows from that sentence.
 *  · It is DISCLOSABLE. A subject access request reaches these notes, and the
 *    person they are about is entitled to read them. The drawer that writes
 *    them says so on screen, in plain words, above the box: this is not small
 *    print, it is the thing that keeps the notes worth having.
 *  · `courseAttendance` stays `read, write: if false`, so the only readers are
 *    this route's siblings and the staff surfaces they feed. The note never
 *    travels to the cohort and never to the member it is about (their own
 *    surfaces carry attendance, not commentary).
 *  · ACCOUNT DELETION takes them. `clearCourseAttendanceMarks` deletes
 *    `participantNotes.<uid>` by `FieldPath` alongside `records.<uid>`, on the
 *    same document and in the same batch, because the register is SHARED and
 *    deleting the document would erase the group's marks for that session.
 *  · PLAIN TEXT ONLY. It is rendered as a text node by `MemberText`, never as
 *    HTML, on every surface that shows it.
 *
 * ── ITS OWN ROUTE, NOT A FIELD ON THE REGISTER POST ─────────────────────────
 * A note is not a mark. Writing one is a different act with a different
 * audience and a different retention story, and folding it into the marking
 * lane would mean a bulk "rest present" and a sentence about a named person
 * shared one validation path and one audit story. It also keeps the note out
 * of the register's 40-key merge arithmetic.
 *
 * ── NOT LOCKED BY THE PUSH ──────────────────────────────────────────────────
 * Deliberately. The push locks the MARKS, because they are the record the
 * mirrors and the reviewers read. A note is a facilitator's own account of the
 * session and is often written after it, on the walk home. Locking it would
 * mean the more considered version could never be written down.
 */

export type ParticipantNoteResult = {
  ok: true;
  sessionKey: string;
  uid: string;
  /** The stored note after the write. "" when it was cleared. */
  note: string;
};

const MAX_WEEK_NUMBER = 60;
const MAX_OCCURRENCE = 4;

/** The merged `participantNotes` map would pass `ATTENDANCE_LIMITS.maxRecords`. */
class NotesFullError extends Error {}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ groupId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { groupId } = await ctx.params;
  if (!isAddressableId(groupId)) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // AUTHORIZATION BEFORE THE BODY IS PARSED, the register route's ordering.
  const gated = await gateGroupRegister(groupId, actor, db);
  if (!gated.ok) {
    return NextResponse.json({ error: gated.error }, { status: gated.status });
  }
  const { group, runId } = gated;

  let body: {
    weekNumber?: unknown;
    occurrence?: unknown;
    uid?: unknown;
    note?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const weekNumber = body?.weekNumber;
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
  const rawOccurrence = body?.occurrence;
  const occurrence = rawOccurrence === undefined || rawOccurrence === null ? 1 : rawOccurrence;
  if (
    typeof occurrence !== "number" ||
    !Number.isInteger(occurrence) ||
    occurrence < 1 ||
    occurrence > MAX_OCCURRENCE
  ) {
    return NextResponse.json(
      { error: `occurrence must be a whole number between 1 and ${MAX_OCCURRENCE}.` },
      { status: 400 },
    );
  }

  const uid = body?.uid;
  if (typeof uid !== "string" || !uid) {
    return NextResponse.json({ error: "That note looks malformed." }, { status: 400 });
  }
  if (typeof body?.note !== "string") {
    return NextResponse.json({ error: "The note must be text." }, { status: 400 });
  }
  const note = body.note.trim();
  if (note.length > ATTENDANCE_LIMITS.participantNote) {
    return NextResponse.json(
      {
        error: `That note is too long (maximum ${ATTENDANCE_LIMITS.participantNote} characters).`,
      },
      { status: 400 },
    );
  }

  const [runSnap, members] = await Promise.all([
    db.collection("courseRuns").doc(runId).get(),
    loadRegisterMembers(db, runId, groupId),
  ]);
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});

  const session = resolveSessions(run, group).find(
    (s) => s.weekNumber === weekNumber && s.occurrence === occurrence,
  );
  if (!session) {
    return NextResponse.json(
      { error: `Week ${weekNumber} isn't a taught session of this group's schedule.` },
      { status: 400 },
    );
  }

  // The note has to be ABOUT somebody in this group. A note keyed on a uid the
  // group does not hold would be personal data with no route to find it again,
  // and no roster row to render it against.
  const member = members.find((m) => m.uid === uid);
  if (!member) {
    return NextResponse.json(
      { error: "That person isn't an active member of this group." },
      { status: 400 },
    );
  }

  const ref = db
    .collection("courseAttendance")
    .doc(attendanceDocId(runId, groupId, session.weekNumber, session.occurrence));

  if (!note) {
    // CLEARING REMOVES THE MAP KEY, never the document: the register is
    // shared, and an empty string stored under a uid is still a note-shaped
    // row about a named person. `FieldPath` rather than a dotted string,
    // because a uid in a dotted path would be reinterpreted as a nested path.
    //
    // `update` refuses a missing document, which is the right answer here: a
    // session nobody has opened has no note to clear.
    try {
      await ref.update(new FieldPath("participantNotes", uid), FieldValue.delete());
    } catch {
      // No register yet, so no note. Reported as done rather than as an error:
      // the caller asked for there to be no note, and there is none.
      return NextResponse.json({
        ok: true,
        sessionKey: session.sessionKey,
        uid,
        note: "",
      } satisfies ParticipantNoteResult);
    }
    return NextResponse.json({
      ok: true,
      sessionKey: session.sessionKey,
      uid,
      note: "",
    } satisfies ParticipantNoteResult);
  }

  // A TRANSACTION, and for the reason the marking lane runs one: the 40-key
  // cap is a property of the MERGED map. Two facilitators writing notes about
  // two different people concurrently would each see room and both be right,
  // and the map would end up over the cap that `normalizeCourseAttendance`
  // then silently truncates on read, losing a note nobody was told was lost.
  // Raw keys, not the normalised ones, so a document already over the cap is
  // counted honestly rather than as 40.
  //
  // `set(..., { merge: true })` creates the register if this note is the first
  // thing written about the session, and merges the map key by key otherwise,
  // so two facilitators writing about two people never overwrite each other.
  // Nested keys in `set()` are literal field names, which is what makes a uid
  // safe to use as one.
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const stored = ((snap.data() ?? {}).participantNotes ?? {}) as Record<
        string,
        unknown
      >;
      const keys = new Set(Object.keys(stored));
      keys.add(uid);
      if (keys.size > ATTENDANCE_LIMITS.maxRecords) throw new NotesFullError();

      tx.set(
        ref,
        {
          runId,
          groupId,
          weekNumber: session.weekNumber,
          occurrence: session.occurrence,
          participantNotes: { [uid]: note },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
  } catch (err) {
    if (err instanceof NotesFullError) {
      return NextResponse.json(
        {
          error: `This session already carries ${ATTENDANCE_LIMITS.maxRecords} notes, which is the most one register holds. Clear one to write another.`,
        },
        { status: 409 },
      );
    }
    throw err;
  }

  return NextResponse.json({
    ok: true,
    sessionKey: session.sessionKey,
    uid,
    note,
  } satisfies ParticipantNoteResult);
}
