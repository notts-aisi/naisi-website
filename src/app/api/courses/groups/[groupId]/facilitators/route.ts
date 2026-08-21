import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { asUidList } from "@/lib/firestore/events";
import { GROUP_FIELD_LIMITS } from "@/lib/firestore/courseGroups";
import { courseEnrolmentId } from "@/lib/firestore/courseEnrolments";

/**
 * Staff a group. `courseGroups.facilitatorUids` is server-owned (pinned in
 * rules) because assigning it does TWO things that must not drift apart:
 *
 *  1. it grants the facilitator read/edit access to the group (rules resolve
 *     `isGroupFacilitator()` off this array), and
 *  2. it upserts a `role: "facilitator"` enrolment for the run, which is what
 *     makes the group appear on that person's /learn hub ("every run you
 *     touch" is one query over enrolments).
 *
 * Gated to admins and the parent run's track leads — the people who staff a
 * run. Facilitators cannot add each other.
 */

const ELIGIBLE_ROLES = ["member", "committee", "admin"] as const;

/**
 * Approved members, committee and admins — the eligible facilitator pool.
 * Requested uids are intersected with this set so a forged or since-rejected
 * uid can never be written. (Same shape as the run roles route's candidate
 * load; kept local because route handlers don't import from one another.)
 */
async function loadEligibleUids(db: Firestore): Promise<Set<string>> {
  const snap = await db
    .collection("users")
    .where("role", "in", [...ELIGIBLE_ROLES])
    .get();
  return new Set(snap.docs.map((d) => d.id));
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { uids?: unknown };
  try {
    body = (await req.json()) as { uids?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const groupRef = db.collection("courseGroups").doc(groupId);
  const groupSnap = await groupRef.get();
  if (!groupSnap.exists) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }
  const group = groupSnap.data() ?? {};
  const runId = typeof group.runId === "string" ? group.runId : "";
  const courseId = typeof group.courseId === "string" ? group.courseId : "";
  if (!runId) {
    return NextResponse.json({ error: "Group is not attached to a run" }, { status: 400 });
  }

  const runSnap = await db.collection("courseRuns").doc(runId).get();
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = runSnap.data() ?? {};

  const isTrackLead = asUidList(run.trackLeadUids).includes(actor.uid);
  if (!(actor.role === "admin" || isTrackLead)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const eligible = await loadEligibleUids(db);
  const requested = asUidList(body.uids);
  if (requested.length > GROUP_FIELD_LIMITS.maxFacilitators) {
    return NextResponse.json(
      { error: `A group can have at most ${GROUP_FIELD_LIMITS.maxFacilitators} facilitators.` },
      { status: 400 },
    );
  }
  const next = requested
    .filter((uid) => eligible.has(uid))
    .slice(0, GROUP_FIELD_LIMITS.maxFacilitators);

  const current = asUidList(group.facilitatorUids);
  const nextSet = new Set(next);
  const currentSet = new Set(current);
  const added = next.filter((uid) => !currentSet.has(uid));
  const removed = current.filter((uid) => !nextSet.has(uid));

  // Read every enrolment we might touch up front — Firestore batches are
  // write-only, so the add/retire decisions are made from these snapshots.
  const touched = [...added, ...removed];
  const enrolmentRefs = touched.map((uid) =>
    db.collection("courseEnrolments").doc(courseEnrolmentId(runId, uid)),
  );
  const enrolments = enrolmentRefs.length ? await db.getAll(...enrolmentRefs) : [];
  const enrolmentByUid = new Map(
    touched.map((uid, i) => [uid, enrolments[i]] as const),
  );

  const batch = db.batch();
  batch.update(groupRef, {
    facilitatorUids: next,
    updatedAt: FieldValue.serverTimestamp(),
  });

  for (const uid of added) {
    const snap = enrolmentByUid.get(uid);
    const ref = db.collection("courseEnrolments").doc(courseEnrolmentId(runId, uid));
    if (!snap?.exists) {
      batch.set(ref, {
        runId,
        courseId,
        uid,
        // Facilitators carry a null `groupId` on purpose: that scalar is the
        // LEARNER allocation invariant (one placement per person per run).
        // Which group someone facilitates is `courseGroups.facilitatorUids`,
        // which is also what lets one person facilitate two groups.
        groupId: null,
        status: "active",
        role: "facilitator",
        applicationId: null,
        // Facilitators aren't paced or scored, so week 1 is the neutral
        // anchor — `joinedWeekNumber` only scopes learner percentages.
        joinedWeekNumber: 1,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      continue;
    }
    const existing = snap.data() ?? {};
    // A learner enrolment is never overwritten: flipping its role would
    // discard their group placement and their learner history on this run.
    // They still get facilitator access via `facilitatorUids` above.
    if (existing.role === "facilitator") {
      batch.update(ref, { status: "active", updatedAt: FieldValue.serverTimestamp() });
    }
  }

  for (const uid of removed) {
    const snap = enrolmentByUid.get(uid);
    if (!snap?.exists) continue;
    const existing = snap.data() ?? {};
    // Retire rather than delete, and only ever a facilitator row: a learner
    // enrolment for the same (run, uid) shares this doc id, and someone who
    // learned on the run before facilitating it must keep that history.
    // "removed" (not a delete) also keeps the audit trail of who staffed what.
    if (existing.role === "facilitator") {
      const ref = db.collection("courseEnrolments").doc(courseEnrolmentId(runId, uid));
      batch.update(ref, { status: "removed", updatedAt: FieldValue.serverTimestamp() });
    }
  }

  await batch.commit();

  return NextResponse.json({ ok: true, facilitatorUids: next });
}
