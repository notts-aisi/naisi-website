import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";
import {
  ADMISSION_ROUND_FIELD_LIMITS,
  normalizeAdmissionRound,
} from "@/lib/firestore/admissionRounds";
import { isEligibleAdmissionsReviewer, normalizeUser } from "@/lib/firestore/users";
import {
  ROUNDS_COLLECTION,
  serialiseRound,
} from "@/lib/admissions/roundRoutes";

/**
 * Appoint this round's reviewers and its final decider.
 *
 * ## Admin only, and a tighter gate than the rest of the console
 *
 * Everything else on a round is authoring: dates, wording, criteria. This is
 * an ACCESS GRANT. Membership of `reviewerUids` IS the permission to read
 * applications, which are member PII plus free text about people's
 * circumstances, and `finalDeciderUid` is the person who can accept and reject.
 * A `approveCourse` holder may author the round they will run; they may not
 * decide who reads it.
 *
 * ## Eligibility is checked against the live user document
 *
 * A reviewer must be an admin or SU-recognised committee, which is the same
 * trust boundary that already gates the `users` collection and the committee
 * task board rather than a looser one invented here. That is checked by
 * reading each candidate's user document at request time, never from anything
 * the browser sent: a stale console (or a hand-made request) naming somebody
 * whose recognition was withdrawn last week is refused, and the refusal names
 * them rather than silently dropping them, because a reviewer who vanishes
 * from a saved list is a round that quietly ends up under-staffed.
 *
 * ## Why it also writes `users.admissionsReviewer`
 *
 * The Admissions entry in the sidebar is gated client-side from the `useAuth`
 * snapshot, which is a live listener on the caller's own user document.
 * There is no field behind "this uid appears in some round's reviewerUids", so
 * without a denormalisation the entry either costs an `admissionRounds` query
 * on every authed navigation for every user, or it never appears for exactly
 * the non-admin SU reviewers the reviewer surface exists to serve. So this
 * route stamps a server-owned boolean on everyone it adds, and CLEARS it on
 * everyone it removes who is not still named on another round.
 *
 * The flag is a nav hint and nothing else. Every admissions route re-checks
 * the round's own arrays, so a stale `true` grants nothing and a stale `false`
 * costs a link, not access.
 */
export async function PUT(
  req: Request,
  ctx: { params: Promise<{ roundId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;
  const { roundId } = await ctx.params;

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json(
      {
        error:
          "Only an admin can appoint reviewers. Membership of the reviewer list is what grants access to applications.",
      },
      { status: 403 },
    );
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { reviewerUids?: unknown; finalDeciderUid?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.reviewerUids)) {
    return NextResponse.json({ error: "Reviewers must be a list." }, { status: 400 });
  }
  const reviewerUids: string[] = [];
  for (const raw of body.reviewerUids) {
    if (typeof raw !== "string" || !raw.trim()) {
      return NextResponse.json({ error: "That is not a person." }, { status: 400 });
    }
    const uid = raw.trim();
    if (!reviewerUids.includes(uid)) reviewerUids.push(uid);
  }
  if (reviewerUids.length > ADMISSION_ROUND_FIELD_LIMITS.maxReviewers) {
    return NextResponse.json(
      { error: `A round takes at most ${ADMISSION_ROUND_FIELD_LIMITS.maxReviewers} reviewers.` },
      { status: 400 },
    );
  }

  const rawDecider = body.finalDeciderUid;
  if (rawDecider !== null && typeof rawDecider !== "string") {
    return NextResponse.json(
      { error: "The final decider must be one person, or nobody yet." },
      { status: 400 },
    );
  }
  const finalDeciderUid =
    typeof rawDecider === "string" && rawDecider.trim() ? rawDecider.trim() : null;

  const roundRef = db.collection(ROUNDS_COLLECTION).doc(roundId);
  const roundSnap = await roundRef.get();
  if (!roundSnap.exists) {
    return NextResponse.json({ error: "Round not found" }, { status: 404 });
  }
  const round = normalizeAdmissionRound(roundSnap.id, roundSnap.data() ?? {});

  // Everyone the round will name, so eligibility is read once per person even
  // when the final decider is also a reviewer.
  const named = Array.from(
    new Set([...reviewerUids, ...(finalDeciderUid ? [finalDeciderUid] : [])]),
  );

  const ineligible: string[] = [];
  if (named.length > 0) {
    const docs = await db.getAll(...named.map((uid) => db.collection("users").doc(uid)));
    for (const doc of docs) {
      if (!doc.exists) {
        ineligible.push(doc.id);
        continue;
      }
      const candidate = normalizeUser(doc.id, doc.data() ?? {});
      if (!isEligibleAdmissionsReviewer(candidate)) {
        ineligible.push(candidate.displayName || candidate.email || doc.id);
      }
    }
  }
  if (ineligible.length > 0) {
    return NextResponse.json(
      {
        error: `${ineligible.join(", ")} cannot be appointed here. Reviewers have to be admins or SU-recognised committee, because they read applications.`,
        ineligible,
      },
      { status: 400 },
    );
  }

  const before = new Set([
    ...round.reviewerUids,
    ...(round.finalDeciderUid ? [round.finalDeciderUid] : []),
  ]);
  const after = new Set(named);
  const added = named.filter((uid) => !before.has(uid));
  const removed = Array.from(before).filter((uid) => !after.has(uid));

  /**
   * A removed person keeps the flag if another round still names them. Both
   * queries are single-field, so no composite index is needed, and both
   * exclude THIS round because its new membership is already decided above.
   */
  const stillElsewhere = new Set<string>();
  for (const uid of removed) {
    const asReviewer = await db
      .collection(ROUNDS_COLLECTION)
      .where("reviewerUids", "array-contains", uid)
      .get();
    if (asReviewer.docs.some((d) => d.id !== roundId)) {
      stillElsewhere.add(uid);
      continue;
    }
    const asDecider = await db
      .collection(ROUNDS_COLLECTION)
      .where("finalDeciderUid", "==", uid)
      .get();
    if (asDecider.docs.some((d) => d.id !== roundId)) stillElsewhere.add(uid);
  }

  const batch = db.batch();
  batch.update(roundRef, {
    reviewerUids,
    finalDeciderUid,
    updatedAt: FieldValue.serverTimestamp(),
  });
  for (const uid of added) {
    batch.update(db.collection("users").doc(uid), { admissionsReviewer: true });
  }
  for (const uid of removed) {
    if (stillElsewhere.has(uid)) continue;
    batch.update(db.collection("users").doc(uid), { admissionsReviewer: false });
  }
  await batch.commit();

  const saved = await roundRef.get();
  return NextResponse.json({
    round: serialiseRound(normalizeAdmissionRound(saved.id, saved.data() ?? {})),
    added,
    removed,
  });
}
