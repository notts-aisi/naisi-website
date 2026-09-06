import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  courseEnrolmentId,
  normalizeCourseEnrolment,
} from "@/lib/firestore/courseEnrolments";
import { normalizeCourseGroup } from "@/lib/firestore/courseGroups";

/**
 * Who is in this group. NAMES ONLY — a locked product decision, not a
 * nicety: a facilitator, and every member of the group, sees who they are
 * sharing a room with and nothing else. No emails, no profiles, no course
 * history. Anything that needs to reach these people by email goes through the
 * group email route, which resolves addresses server-side and never hands them
 * out. Every field added below has to be checked against that line.
 *
 * ENUMERATION-SAFE: the caller passes no uids. The server derives the roster
 * from the group's own enrolment rows, so you only ever learn the names of
 * people already in a group with you.
 *
 * WHO MAY READ: a facilitator of THIS group ∪ its active members ∪ admins.
 * Membership is checked against the caller's own enrolment doc — addressed by
 * construction at `courseEnrolments/{runId}__{uid}`, so there is no way to
 * spell someone else's row — and it must name THIS group: being on the run is
 * not being in the group, and the whole point of small groups is that they are
 * small.
 *
 * `courseGroups` is read-locked to the authoring tier in firestore.rules
 * (group docs carry the meeting link), so this route is the only way a roster
 * reaches a member at all. The meeting link deliberately does NOT travel here
 * — the run overview owns the session card.
 */

// ---------------------------------------------------------------------------
// Wire types (the contract the roster + attendance surfaces render from)
// ---------------------------------------------------------------------------

export type GroupRosterPayload = {
  group: { id: string; name: string };
  /** Names only. */
  facilitators: Array<{ uid: string; displayName: string }>;
  /** Active members only — names only. */
  members: Array<{ uid: string; displayName: string }>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Display-name fallback chain: preferred name, then account name, then a
 * neutral placeholder — NEVER an email address, which is what makes this safe
 * for a member-facing roster. (Same local helper P1/P5/P6 carry; route
 * handlers don't import from one another, so it is duplicated on purpose.)
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

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ groupId: string }> },
) {
  const { groupId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const groupSnap = await db.collection("courseGroups").doc(groupId).get();
  if (!groupSnap.exists) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }
  const group = normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {});
  if (!group.runId) {
    return NextResponse.json({ error: "Group is not attached to a run" }, { status: 400 });
  }

  const isAdmin = actor.role === "admin";
  const isGroupFacilitator = group.facilitatorUids.includes(actor.uid);

  // Membership of THIS group, read from the caller's own enrolment row.
  let isGroupMember = false;
  if (!isAdmin && !isGroupFacilitator) {
    const ownSnap = await db
      .collection("courseEnrolments")
      .doc(courseEnrolmentId(group.runId, actor.uid))
      .get();
    if (ownSnap.exists) {
      const own = normalizeCourseEnrolment(ownSnap.id, ownSnap.data() ?? {});
      isGroupMember = own.status === "active" && own.groupId === groupId;
    }
    if (!isGroupMember) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Scoped by runId as well as groupId — the group's own run, never a caller
  // parameter. That makes the query an exact match for the existing
  // (runId, groupId, status) composite index, and pins the roster to one run
  // even if a future id scheme ever let a group id repeat across runs.
  const memberSnap = await db
    .collection("courseEnrolments")
    .where("runId", "==", group.runId)
    .where("groupId", "==", groupId)
    .where("status", "==", "active")
    .limit(100)
    .get();

  const memberUids = memberSnap.docs
    .map((d) => normalizeCourseEnrolment(d.id, d.data() ?? {}).uid)
    .filter(Boolean);

  // One `getAll` for every name the payload needs — facilitators and members
  // together, de-duplicated (a facilitator's own enrolment carries a null
  // groupId, so the two sets don't normally overlap).
  const uids = [...new Set([...group.facilitatorUids, ...memberUids])];
  const userDocs = uids.length
    ? await db.getAll(...uids.map((uid) => db.collection("users").doc(uid)))
    : [];
  const nameByUid = new Map<string, string>();
  for (const doc of userDocs) {
    if (doc.exists) nameByUid.set(doc.id, displayNameOf(doc.data() ?? {}));
  }

  const named = (uid: string) => ({
    uid,
    displayName: nameByUid.get(uid) ?? "NAISI member",
  });

  const payload: GroupRosterPayload = {
    group: { id: group.id, name: group.name },
    facilitators: group.facilitatorUids.map(named),
    members: memberUids
      .map(named)
      .sort(
        (a, b) => a.displayName.localeCompare(b.displayName) || a.uid.localeCompare(b.uid),
      ),
  };

  return NextResponse.json(payload);
}
