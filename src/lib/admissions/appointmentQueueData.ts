import "server-only";
import type { Firestore, Query } from "firebase-admin/firestore";
import {
  APPOINTABLE_RUN_STATUSES,
  buildAppointmentQueueRow,
  eligibleAppointmentRuns,
  sortAppointmentRows,
  type AppointmentQueueRow,
  type AppointmentRunOption,
} from "./appointmentQueue";
import { ROUNDS_COLLECTION, STAGES_SUBCOLLECTION } from "./roundRoutes";
import { isStageReleased } from "./stageRelease";
import {
  APPLICATIONS_COLLECTION,
  normalizeAdmissionApplication,
} from "@/lib/firestore/admissionApplications";
import {
  normalizeAdmissionRound,
  normalizeAdmissionStage,
  type AdmissionRoundDoc,
  type AdmissionStageDoc,
} from "@/lib/firestore/admissionRounds";
import { normalizeCourseRun } from "@/lib/firestore/courses";
import type { SessionUser } from "@/lib/firebase/session";

/**
 * The reads behind the appointment queue, in one module so the page and any
 * later route cannot drift into two ideas of what the queue is.
 *
 * ## Nothing here can reach the private sibling collection
 *
 * The access-requirements answer lives in the private sibling of this
 * collection, and the privacy notice promises every read of it is recorded.
 * This surface records nothing, so it must be structurally unable to read it,
 * and "unable" is meant structurally rather than as a habit: the collection
 * name comes from `@/lib/firestore/admissionApplications`, a leaf that knows a
 * shape and an id and holds no database handle, rather than from the apply
 * tree's shared context module, which exports the two helpers that address the
 * private sibling on a caller's behalf. Do not import that module here for a
 * constant: move the constant instead. The same rule, and the same reason, as
 * `statusHubData.ts`.
 *
 * ## Admin SDK, and the gate is the caller's job
 *
 * `admissionApplications` and `admissionRounds` are both
 * `allow read, write: if false`, so this is an unguarded read with no rule
 * underneath it. `canDecideAppointments` and `canViewAppointmentQueue` below
 * are the decision, and the page applies them before it calls the loader.
 */

/** Cap on one round's queue. A facilitator round is a few dozen at most. */
const MAX_ROWS = 200;

/** Cap on the runs offered in the appoint Select. */
const MAX_RUNS = 200;

/**
 * What a capped read left out, or null when it left nothing out.
 *
 * `shown` is what came back and `total` is what the same filter matches, from
 * a count aggregate that only runs when the cap was actually reached. A page
 * that silently shows the first 200 of 214 applications is a page that has
 * quietly dropped fourteen people from a queue whose whole job is deciding on
 * every one of them, so the number is read and said out loud.
 */
export type QueueTruncation = { shown: number; total: number } | null;

export type AppointmentQueueBundle = {
  rows: AppointmentQueueRow[];
  runs: AppointmentRunOption[];
  /** Applications on this round that did not fit the cap. */
  rowsTruncated: QueueTruncation;
  /** Runs that did not fit the cap, counted before the archived filter. */
  runsTruncated: QueueTruncation;
};

/**
 * May this caller DECIDE on this round?
 *
 * The round's own final decider, or an admin. A reviewer appointed to the
 * round may read the queue and may not press either button: appointing
 * somebody to run a group is a commitment the society makes, and the round
 * names exactly one person who makes it. The page says this in words rather
 * than only hiding the buttons.
 */
export function canDecideAppointments(
  user: SessionUser,
  round: Pick<AdmissionRoundDoc, "finalDeciderUid">,
): boolean {
  if (user.role === "admin") return true;
  return round.finalDeciderUid === user.uid;
}

/** May this caller READ the queue? The deciders, plus the round's reviewers. */
export function canViewAppointmentQueue(
  user: SessionUser,
  round: Pick<AdmissionRoundDoc, "finalDeciderUid" | "reviewerUids">,
): boolean {
  if (canDecideAppointments(user, round)) return true;
  return round.reviewerUids.includes(user.uid);
}

/**
 * One round, and nothing else.
 *
 * Split from the queue read so the caller can apply
 * `canViewAppointmentQueue` BEFORE anything else is read: the queue join
 * includes every applicant's user document, which is member PII, and reading
 * it and then deciding the reader may not see it is the wrong order to do
 * those two things in.
 */
export async function loadAppointmentRound(
  db: Firestore,
  roundId: string,
): Promise<AdmissionRoundDoc | null> {
  const snap = await db.collection(ROUNDS_COLLECTION).doc(roundId).get();
  if (!snap.exists) return null;
  return normalizeAdmissionRound(snap.id, snap.data() ?? {});
}

/**
 * One round's stages in order, and which of them have been released.
 *
 * ONE CLOCK READING for the whole page, taken by the caller and passed down,
 * so two stages cannot land on opposite sides of the same release instant
 * within one render. Both come off the same read: the release question is
 * asked per stage, not per document fetch.
 */
async function loadStages(
  db: Firestore,
  round: AdmissionRoundDoc,
  now: Date,
): Promise<{ stages: AdmissionStageDoc[]; releasedIds: Set<string> }> {
  const snap = await db
    .collection(ROUNDS_COLLECTION)
    .doc(round.id)
    .collection(STAGES_SUBCOLLECTION)
    .get();
  const stages = snap.docs
    .map((doc) => normalizeAdmissionStage(doc.id, doc.data() ?? {}))
    .sort((a, b) => a.order - b.order);
  const releasedIds = new Set<string>();
  for (const stage of stages) {
    if (isStageReleased(stage, round, now)) releasedIds.add(stage.id);
  }
  return { stages, releasedIds };
}

/**
 * One round's queue.
 *
 * TAKES THE ROUND, does not read it. The caller has already read it and
 * already applied `canViewAppointmentQueue` to it, which is the point: nothing
 * below this line runs for somebody who may not see it, and the join two
 * paragraphs down reads every applicant's user document.
 *
 * ## Why the query has no `orderBy`
 *
 * The house rule (Firestore drops documents missing the ordered field) plus a
 * second reason: the ordering wants "undecided first", which is a property of
 * `outcome.decision`, a field a draft row does not carry at all. So the query
 * filters and `sortAppointmentRows` orders, once, after the join.
 *
 * ## Only submitted and decided rows
 *
 * A DRAFT IS NOT AN APPLICATION and never appears here. Somebody halfway
 * through writing one has not asked for anything, and listing them alongside
 * people who pressed submit is how a queue ends up mailing an appointment to
 * somebody who never applied. Withdrawn rows are out for the same reason.
 */
export async function loadAppointmentQueue(
  db: Firestore,
  round: AdmissionRoundDoc,
  now: Date = new Date(),
): Promise<AppointmentQueueBundle> {
  const roundId = round.id;
  const applicationQuery = db
    .collection(APPLICATIONS_COLLECTION)
    .where("roundId", "==", roundId);
  // FOUR STATUSES, not the whole collection. A finished or called-off run
  // cannot take a facilitator, and the filter that says so belongs on the
  // query rather than on the two hundred documents it would otherwise have
  // read. `archived` is deliberately not in the query: see
  // APPOINTABLE_RUN_STATUSES.
  const runQuery = db
    .collection("courseRuns")
    .where("status", "in", [...APPOINTABLE_RUN_STATUSES]);

  const [{ stages, releasedIds }, appsSnap, runsSnap] = await Promise.all([
    loadStages(db, round, now),
    applicationQuery.limit(MAX_ROWS).get(),
    runQuery.limit(MAX_RUNS).get(),
  ]);

  // THE COUNT ONLY RUNS WHEN THE CAP WAS REACHED, so the ordinary queue of a
  // dozen applicants pays nothing for a line it will never show.
  const [rowsTruncated, runsTruncated] = await Promise.all([
    countIfCapped(applicationQuery, appsSnap.size, MAX_ROWS),
    countIfCapped(runQuery, runsSnap.size, MAX_RUNS),
  ]);

  const applications = appsSnap.docs
    .map((doc) =>
      normalizeAdmissionApplication(doc.id, doc.data() ?? {}, round.availabilityGrid),
    )
    .filter((application) => application.status !== "draft" && application.status !== "withdrawn");

  // ONE getAll for the profiles rather than a read per row: a preferred name
  // and a university address are two fields, and a queue of forty applicants
  // must not be forty sequential round trips on the page's critical path.
  const uids = [...new Set(applications.map((a) => a.uid).filter(Boolean))];
  const profiles = new Map<string, { preferredName?: string; universityEmail?: string }>();
  if (uids.length > 0) {
    const docs = await db.getAll(...uids.map((uid) => db.collection("users").doc(uid)));
    for (const doc of docs) {
      if (!doc.exists) continue;
      const profile = ((doc.data() ?? {}).profile ?? {}) as Record<string, unknown>;
      profiles.set(doc.id, {
        preferredName:
          typeof profile.preferredName === "string" ? profile.preferredName : undefined,
        universityEmail:
          typeof profile.universityEmail === "string"
            ? profile.universityEmail
            : undefined,
      });
    }
  }

  const rows = applications.map((application) =>
    buildAppointmentQueueRow(
      application,
      stages,
      round.availabilityGrid,
      profiles.get(application.uid) ?? null,
      releasedIds,
    ),
  );

  const runs = eligibleAppointmentRuns(
    runsSnap.docs.map((doc) => normalizeCourseRun(doc.id, doc.data() ?? {})),
  );

  return { rows: sortAppointmentRows(rows), runs, rowsTruncated, runsTruncated };
}

/**
 * How many documents that query really matches, but only when the read came
 * back exactly at its cap. Below the cap the answer is already known and an
 * aggregate would be a read for nothing; at the cap the page has to be able to
 * say what it left out.
 *
 * A count that fails answers null: a missing "showing the first N" line is a
 * worse page, and a queue that would not render at all because a courtesy
 * aggregate threw is a worse one still.
 */
async function countIfCapped(
  query: Query,
  shown: number,
  cap: number,
): Promise<QueueTruncation> {
  if (shown < cap) return null;
  try {
    const agg = await query.count().get();
    const total = agg.data().count;
    return total > shown ? { shown, total } : null;
  } catch (err) {
    console.warn("[appointment queue] count failed", err);
    return null;
  }
}
