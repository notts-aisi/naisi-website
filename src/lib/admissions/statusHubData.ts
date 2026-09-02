import "server-only";
import { buildStatusRow, sortStatusRows } from "./statusHub";
import type { ApplicationStatusRow } from "./statusTypes";
import { type Db } from "./applicantSession";
import { APPLICATIONS_COLLECTION } from "./applyContext";
import { ROUNDS_COLLECTION, STAGES_SUBCOLLECTION } from "./roundRoutes";
import {
  admissionApplicationId,
  normalizeAdmissionApplication,
} from "@/lib/firestore/admissionApplications";
import {
  normalizeAdmissionRound,
  normalizeAdmissionStage,
  type AdmissionRoundDoc,
  type AdmissionStageDoc,
} from "@/lib/firestore/admissionRounds";

/**
 * The reads behind the applicant status hub, in one module so the two pages
 * and `GET /api/admissions/applications/me` cannot drift into three different
 * ideas of what a caller's applications are.
 *
 * ## Addressed by uid, never by anything a caller sends
 *
 * `admissionApplications` is `allow read, write: if false`, so this is an
 * Admin SDK read with no rule underneath it. The only filter that matters is
 * therefore written here: `where("uid", "==", uid)` with a uid taken from the
 * session, and, on the single-round path, the deterministic document id built
 * from that same uid. There is no code path in this module that reads an
 * application belonging to anybody else, and none may be added: the staff
 * surfaces have their own routes, with their own blinding.
 *
 * ## Deliberately NOT filtered on window state
 *
 * This is the surface that has to survive the deadline. An applicant checking
 * on the Monday after applications closed is the most likely visitor it will
 * ever have, and a hub that hid their row the moment the window shut would be
 * useless exactly when it matters. Rounds that are no longer public objects at
 * all (a draft, or one that has been archived) still show their row, with no
 * link onward: the answers are still the applicant's own, and hiding somebody's
 * application because the team tidied up afterwards is a worse failure than an
 * unlinked card.
 *
 * ## No `orderBy` on the query
 *
 * The house rule (sparse fields drop documents from an ordered query) plus a
 * second reason: ordering wants `updatedAt`, and the rows are joined to their
 * rounds in memory anyway. `sortStatusRows` is the one ordering, applied after
 * the join, so the API and both pages list them identically.
 */

/**
 * Cap on how many of one person's applications the hub will load. Well past
 * anything real (an autumn intake, a facilitator round, a spring intake is
 * three), and there purely so a corrupted or scripted account cannot turn one
 * page render into an unbounded read.
 */
const MAX_ROWS = 50;

type RoundBundle = { round: AdmissionRoundDoc; stages: AdmissionStageDoc[] };

async function loadRoundBundle(db: Db, roundId: string): Promise<RoundBundle | null> {
  const ref = db.collection(ROUNDS_COLLECTION).doc(roundId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const round = normalizeAdmissionRound(snap.id, snap.data() ?? {});
  const stagesSnap = await ref.collection(STAGES_SUBCOLLECTION).get();
  const stages = stagesSnap.docs
    .map((doc) => normalizeAdmissionStage(doc.id, doc.data() ?? {}))
    .sort((a, b) => a.order - b.order);
  return { round, stages };
}

/**
 * Every application this uid has, newest activity first.
 *
 * A row whose round document has gone (a hard-deleted round) is DROPPED rather
 * than half-rendered: the round is what carries the availability geometry, the
 * stage list and the deadline, so without it there is no honest way to say
 * what the application is to. It is logged, because it means a cascade missed
 * a row.
 */
export async function loadStatusRows(
  db: Db,
  uid: string,
  now: Date,
): Promise<ApplicationStatusRow[]> {
  const snap = await db
    .collection(APPLICATIONS_COLLECTION)
    .where("uid", "==", uid)
    .limit(MAX_ROWS)
    .get();
  if (snap.empty) return [];

  const roundIds = [
    ...new Set(
      snap.docs
        .map((doc) => (doc.data() ?? {}).roundId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const bundles = new Map<string, RoundBundle>();
  await Promise.all(
    roundIds.map(async (roundId) => {
      const bundle = await loadRoundBundle(db, roundId);
      if (bundle) bundles.set(roundId, bundle);
    }),
  );

  const rows: ApplicationStatusRow[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() ?? {};
    const roundId = typeof data.roundId === "string" ? data.roundId : "";
    const bundle = bundles.get(roundId);
    if (!bundle) {
      console.warn("[admissions status] application with no round", doc.id, roundId);
      continue;
    }
    const application = normalizeAdmissionApplication(
      doc.id,
      data,
      bundle.round.availabilityGrid,
    );
    rows.push(buildStatusRow(application, bundle.round, bundle.stages, now));
  }
  return sortStatusRows(rows);
}

/**
 * One round's row for this uid, or null when they never applied to it.
 *
 * NULL IS A STATE, not an error: a missing row is what somebody who has not
 * applied yet has, and the detail page renders that as an invitation rather
 * than as a 404. `roundMissing` is the different thing, and the caller draws
 * the distinction: no round at all is a 404, no application is an empty state.
 */
export async function loadStatusRowForRound(
  db: Db,
  uid: string,
  roundId: string,
  now: Date,
): Promise<{ roundMissing: true } | { roundMissing: false; row: ApplicationStatusRow | null }> {
  const bundle = await loadRoundBundle(db, roundId);
  if (!bundle) return { roundMissing: true };

  const snap = await db
    .collection(APPLICATIONS_COLLECTION)
    // Addressed, not queried: the id builder takes the session uid, so this
    // can only ever be the caller's own row.
    .doc(admissionApplicationId(roundId, uid))
    .get();
  if (!snap.exists) return { roundMissing: false, row: null };

  const application = normalizeAdmissionApplication(
    snap.id,
    snap.data() ?? {},
    bundle.round.availabilityGrid,
  );
  return {
    roundMissing: false,
    row: buildStatusRow(application, bundle.round, bundle.stages, now),
  };
}
