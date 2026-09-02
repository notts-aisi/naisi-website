import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import {
  ADMISSION_ROUND_FIELD_LIMITS,
  ADMISSION_ROUND_KINDS,
  DEFAULT_BLIND_SETTINGS,
  DEFAULT_REMINDER_OFFSETS,
  DEFAULT_SCORE_SCALE,
  EMPTY_PROGRAMME_PREFERENCE,
  admissionRoundId,
  admissionStageId,
  normalizeAdmissionRound,
  zeroApplicationCounts,
  type AdmissionRoundKind,
} from "@/lib/firestore/admissionRounds";
import { DEFAULT_AVAILABILITY_GRID } from "@/lib/admissions/availability";
import { slugify } from "@/lib/firestore/slugId";
import { ACADEMIC_YEAR_PATTERN } from "@/lib/firestore/users";
import {
  ROUNDS_COLLECTION,
  STAGES_SUBCOLLECTION,
  canAuthorRounds,
  canSeeRound,
  serialiseRound,
} from "@/lib/admissions/roundRoutes";

/**
 * The rounds INDEX: list the rounds this caller may see, and create a new one.
 *
 * ## Why a route at all
 *
 * `admissionRounds` is `allow read, write: if false`, both halves. The write
 * half is the usual one (counters, role arrays). The read half is the sharper
 * one: the round document carries live `applicationCounts`, so a signed-in
 * read would let any fresher watch a competitive intake's submitted and
 * accepted counters move all through the week their own application is being
 * decided, and it carries `finalDeciderUid`, which names the person deciding
 * it. So there is no client read to fall back on and this list is the only way
 * a staff surface sees a round.
 *
 * ## Who sees what
 *
 * The GET answers for any signed-in caller and filters per round: authors
 * (admin or `approveCourse`) and `draftCourse` holders see every round;
 * everyone else sees only the rounds that name them as a reviewer or as the
 * final decider. A caller on no round gets an empty list rather than a 403,
 * because "there are rounds you cannot see" is itself information about a
 * competitive intake, and because the Admissions nav entry appearing for a
 * reviewer whose round has since ended should show them an empty page, not an
 * error.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  // No orderBy: `createdAt` is stamped by this route, but a round restored by
  // hand or written before the field existed would be DROPPED from an ordered
  // query rather than merely mis-sorted, and a missing round on the console is
  // the one failure nobody would think to look for. Tens of documents, sorted
  // below.
  const snap = await db.collection(ROUNDS_COLLECTION).get();
  const rounds = snap.docs
    .map((d) => normalizeAdmissionRound(d.id, d.data() ?? {}))
    .filter((round) => canSeeRound(user, round));

  rounds.sort((a, b) => {
    const at = a.createdAt?.getTime() ?? 0;
    const bt = b.createdAt?.getTime() ?? 0;
    if (at !== bt) return bt - at;
    return a.label.localeCompare(b.label);
  });

  return NextResponse.json({
    rounds: rounds.map(serialiseRound),
    canAuthor: canAuthorRounds(user),
  });
}

/**
 * Create a round. Admin or `approveCourse`.
 *
 * Everything except the label and the kind is a DEFAULT, and the defaults are
 * the shipped ones rather than empties: the reminder schedule, the score
 * scale, the availability grid and the blind settings all arrive already
 * sensible, so a round that opens without anybody touching those sections is
 * still a round that behaves the way the design says it does. The readiness
 * panel then names the handful of things that genuinely cannot be defaulted:
 * the dates, the questions, the people.
 *
 * A FIRST STAGE is created in the same batch. A round with no stages shows an
 * applicant an empty form, and "add a stage before you add a question" is a
 * step with no meaning to anybody: every round has at least one block of
 * questions, so the object starts with one.
 */
export async function POST(req: Request) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canAuthorRounds(user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { label?: unknown; kind?: unknown; academicYear?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const L = ADMISSION_ROUND_FIELD_LIMITS;
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) {
    return NextResponse.json({ error: "Give the round a name." }, { status: 400 });
  }
  if (label.length > L.label) {
    return NextResponse.json(
      { error: `That name is ${label.length - L.label} characters too long.` },
      { status: 400 },
    );
  }

  const kind = ADMISSION_ROUND_KINDS.includes(body.kind as AdmissionRoundKind)
    ? (body.kind as AdmissionRoundKind)
    : "enrolment";

  const academicYear =
    typeof body.academicYear === "string" ? body.academicYear.trim() : "";
  if (academicYear && !ACADEMIC_YEAR_PATTERN.test(academicYear)) {
    return NextResponse.json(
      { error: "The academic year looks like 2026/27." },
      { status: 400 },
    );
  }

  const id = admissionRoundId(label);
  const stageId = admissionStageId(0);
  const roundRef = db.collection(ROUNDS_COLLECTION).doc(id);
  const stageRef = roundRef.collection(STAGES_SUBCOLLECTION).doc(stageId);

  const batch = db.batch();
  // No `undefined` anywhere: Firestore refuses it outright, and a create is
  // exactly where a half-built object would otherwise be minted.
  batch.create(roundRef, {
    kind,
    label,
    slug: slugify(label, L.slug),
    blurb: "",
    academicYear,
    status: "draft",
    opensAt: null,
    closesAt: null,
    decisionsByDate: null,
    stageIds: [stageId],
    programmePreference: { ...EMPTY_PROGRAMME_PREFERENCE },
    availabilityGrid: { ...DEFAULT_AVAILABILITY_GRID },
    accessRequirementsPrompt:
      "Is there anything we should know so you can take part fully? This is read separately from your application and is never scored.",
    criteria: [],
    scoreScale: { ...DEFAULT_SCORE_SCALE },
    reviewersPerApplication: 2,
    reviewerUids: [],
    finalDeciderUid: null,
    blind: { ...DEFAULT_BLIND_SETTINGS },
    evidenceRunIds: [],
    reminderOffsets: DEFAULT_REMINDER_OFFSETS.map((o) => ({ ...o })),
    outcomeRunIds: [],
    applicationCounts: zeroApplicationCounts(),
    archived: false,
    clonedFromRoundId: null,
    authorUid: user.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.create(stageRef, {
    roundId: id,
    label: "Application",
    intro: "",
    questions: [],
    releaseAt: null,
    releaseTimeLocal: "09:00",
    manualReleasedAt: null,
    closesAt: null,
    locksOnSubmit: false,
    order: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (err) {
    // `slugId` appends eight base36 characters, so a collision here is a
    // retry, not a name clash the author can act on.
    const code = (err as { code?: number | string } | null)?.code;
    if (code === 6 || code === "already-exists") {
      return NextResponse.json(
        { error: "That round id was just taken. Try saving again." },
        { status: 409 },
      );
    }
    throw err;
  }

  return NextResponse.json({ id, stageId }, { status: 201 });
}
