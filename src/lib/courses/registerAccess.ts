import "server-only";
import type { Firestore } from "firebase-admin/firestore";
import type { SessionUser } from "@/lib/firebase/session";
import {
  ENROLMENT_STATUSES,
  normalizeCourseEnrolment,
} from "@/lib/firestore/courseEnrolments";
import { normalizeCourseGroup, type CourseGroupDoc } from "@/lib/firestore/courseGroups";

/**
 * WHO MAY TOUCH A GROUP'S REGISTER, in one place.
 *
 * There are now four doors onto the same documents: the register itself
 * (GET and POST), the admin's post-push edit (PATCH), PUSH ATTENDANCE, and the
 * participant-note drawer. They are four verbs on ONE act, running a session,
 * and they were three copies of one predicate away from disagreeing about it.
 * The exercises route was fixed for exactly that drift; this module is the
 * fix applied before the drift.
 *
 * ── THE PREDICATE ───────────────────────────────────────────────────────────
 * A facilitator of THIS group, while it is LIVE (`courseGroups.facilitatorUids`
 * on a group that is not archived) union admins. That is the whole list.
 *  · ARCHIVING A GROUP UNSTAFFS IT. One rule, stated identically in
 *    `runAccess.ts`, the exercises queue, the review route and the page gates.
 *    Admins bypass it: an archived cohort is exactly what an admin is asked to
 *    go back and look at.
 *  · Plain members get 403. Attendance is a roster-wide record, and "who else
 *    missed last week" is not a member's to read even about their own group. A
 *    member's OWN attendance travels on the run overview instead.
 *  · Another group's facilitator, an admissions reviewer and a track lead all
 *    get 403. Admissions is a SEPARATE LANE from the cohort, and staffing a
 *    run is not facilitating a group, which is why the run doc is not
 *    consulted for access at all.
 *
 * ── AUTHORIZATION BEFORE EXISTENCE ──────────────────────────────────────────
 * A missing group, an ARCHIVED group and a group you do not facilitate all
 * collapse onto the SAME 403, so probing group ids tells you nothing about
 * which ones exist. The honest 404/400 answers below the gate are reachable
 * only by an admin, who could read those documents anyway.
 *
 * ── PII: NAMES ONLY ─────────────────────────────────────────────────────────
 * `displayNameOf` never returns an email. A register is a list of people who
 * did or did not turn up; it must not double as a mailing list. Anything that
 * needs to reach these people goes through the group email route, which
 * resolves addresses server-side and never hands them out.
 */

/** Roster read cap, the same number the roster and exercises routes use. */
export const MAX_REGISTER_MEMBERS = 100;

/**
 * Dynamic segments arrive URL-DECODED, so a `%2F` reaches a route as a real
 * path separator and `doc()` would throw. Same guard as `runAccess.ts`,
 * deliberately identical so the gate and the routes agree on what counts as
 * addressable.
 */
export function isAddressableId(value: string): boolean {
  return Boolean(value) && !value.includes("/") && value !== "." && value !== "..";
}

/**
 * Display-name fallback chain: preferred name, then account name, then a
 * neutral placeholder. NEVER an email address, which is what makes this safe
 * for a facilitator-facing register.
 */
export function displayNameOf(data: Record<string, unknown>): string {
  const profile = (data.profile as Record<string, unknown> | undefined) ?? {};
  const preferred = profile.preferredName;
  const display = data.displayName;
  return (
    (typeof preferred === "string" && preferred.trim()) ||
    (typeof display === "string" && display.trim()) ||
    "NAISI member"
  );
}

export type RegisterGate =
  | { ok: true; group: CourseGroupDoc; runId: string; isAdmin: boolean }
  /** Map straight onto a `NextResponse.json({ error }, { status })`. */
  | { ok: false; status: number; error: string };

/**
 * Resolve the group and decide access, off ONE document read. Returns a plain
 * status and sentence rather than a `NextResponse` so this module stays free
 * of `next/server`; each route renders its own response.
 */
export async function gateGroupRegister(
  groupId: string,
  actor: SessionUser,
  db: Firestore,
): Promise<RegisterGate> {
  const groupSnap = await db.collection("courseGroups").doc(groupId).get();
  const group = groupSnap.exists
    ? normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {})
    : null;

  const isAdmin = actor.role === "admin";
  const facilitatesLiveGroup = Boolean(
    group && !group.archived && group.facilitatorUids.includes(actor.uid),
  );
  if (!isAdmin && !facilitatesLiveGroup) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  // Reachable only by an admin: every other caller is already past the gate on
  // a group that exists, so this discloses nothing they could not read anyway.
  if (!group) return { ok: false, status: 404, error: "Group not found" };
  if (!group.runId || !isAddressableId(group.runId)) {
    return { ok: false, status: 400, error: "Group is not attached to a run" };
  }
  return { ok: true, group, runId: group.runId, isAdmin };
}

/**
 * The least a rollup recompute needs to know about a person: who they are, and
 * the week their record starts at. `RegisterMember` is this plus a name.
 */
export type MirrorMember = {
  uid: string;
  joinedWeekNumber: number;
};

/** One row of the register: a person, and the week their record starts at. */
export type RegisterMember = MirrorMember & {
  displayName: string;
};

/**
 * EVERY ENROLMENT ON THE GROUP WHOSE ATTENDANCE IS READ DOWNSTREAM, for the
 * rollup recompute. Not the register's rows: those are the ACTIVE members,
 * because they are who a facilitator can mark.
 *
 * All four statuses are included, and each one is here for a reason rather
 * than by default:
 *  · `active` is the room.
 *  · `completed` is the finished cohort, and its figures are exactly what a
 *    reviewer reads months later.
 *  · `withdrawn` and `removed` still carry an `attendance` rollup that the
 *    admin surfaces and the member's own run overview render.
 * Filtering any of them out would freeze that person's figures at whatever
 * they were before an admin's correction, which is the one moment the numbers
 * were known to be wrong. Nothing is excluded, so there is nothing to name.
 *
 * `status in [...]` rather than dropping the filter: it is the same
 * (runId, groupId, status) composite index the roster and the register query
 * already use, so this needs no new index.
 *
 * NO NAMES ARE RESOLVED. The mirror never renders anybody, so this skips the
 * `users` read the register's own loader does.
 */
export async function loadMirrorMembers(
  db: Firestore,
  runId: string,
  groupId: string,
): Promise<MirrorMember[]> {
  const snap = await db
    .collection("courseEnrolments")
    .where("runId", "==", runId)
    .where("groupId", "==", groupId)
    .where("status", "in", ENROLMENT_STATUSES)
    .limit(MAX_REGISTER_MEMBERS)
    .get();

  const byUid = new Map<string, MirrorMember>();
  for (const d of snap.docs) {
    const e = normalizeCourseEnrolment(d.id, d.data() ?? {});
    if (e.uid && !byUid.has(e.uid)) {
      byUid.set(e.uid, { uid: e.uid, joinedWeekNumber: e.joinedWeekNumber });
    }
  }
  return [...byUid.values()];
}

/**
 * The group's ACTIVE members, name-sorted, with the joined week that scopes
 * their row. Scoped by the GROUP's own `runId`, never a caller parameter, so
 * it is an exact match for the existing (runId, groupId, status) composite
 * index, the same query the roster and exercises routes run.
 */
export async function loadRegisterMembers(
  db: Firestore,
  runId: string,
  groupId: string,
): Promise<RegisterMember[]> {
  const memberSnap = await db
    .collection("courseEnrolments")
    .where("runId", "==", runId)
    .where("groupId", "==", groupId)
    .where("status", "==", "active")
    .limit(MAX_REGISTER_MEMBERS)
    .get();

  // Deduplicated by uid. `courseEnrolmentId` binds (run, uid), so a second row
  // for the same person is structurally impossible, but a duplicate here would
  // become a duplicate React key and a second row in the register, and the Map
  // costs nothing.
  const byUid = new Map<string, ReturnType<typeof normalizeCourseEnrolment>>();
  for (const d of memberSnap.docs) {
    const e = normalizeCourseEnrolment(d.id, d.data() ?? {});
    if (e.uid && !byUid.has(e.uid)) byUid.set(e.uid, e);
  }

  const uids = [...byUid.keys()];
  const userDocs = uids.length
    ? await db.getAll(...uids.map((uid) => db.collection("users").doc(uid)))
    : [];
  const nameByUid = new Map<string, string>();
  for (const doc of userDocs) {
    if (doc.exists) nameByUid.set(doc.id, displayNameOf(doc.data() ?? {}));
  }

  return [...byUid.values()]
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
