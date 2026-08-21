import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { currentWeekFor, isValidDateKey } from "@/lib/courses/weekPlan";
import { courseApplicationId } from "@/lib/firestore/courseApplications";
import {
  courseEnrolmentId,
  normalizeCourseEnrolment,
} from "@/lib/firestore/courseEnrolments";
import { normalizeCourseGroup } from "@/lib/firestore/courseGroups";
import { normalizeCourseRun } from "@/lib/firestore/courses";

/**
 * Place accepted applicants into groups — the write half of the allocation
 * board, and the ONLY writer of learner placements.
 *
 * WHO MAY ALLOCATE: admins ∪ the run's `trackLeadUids` (the people who staff
 * the run). Admissions reviewers decided WHO gets in; this route decides
 * WHERE they sit, and the two powers are deliberately separate.
 *
 * ── WHY THERE IS NO UNIQUENESS SEARCH ───────────────────────────────────────
 * Double-placement is structurally impossible, so nothing here queries for
 * "is this person already in a group". The enrolment doc id is the invariant:
 * `courseEnrolments/{courseEnrolmentId(runId, uid)}` means AT MOST one
 * enrolment can exist per (run, uid) — `tx.create` throws ALREADY_EXISTS on a
 * race rather than duplicating — and the placement itself is `groupId`, a
 * SINGLE SCALAR on that one doc. There is nowhere to store a second
 * placement. Group membership is ALWAYS a query over enrolments
 * (`where("groupId","==",g)`), NEVER a `memberUids` array on the group doc —
 * an array would be a second copy of the truth that could disagree with the
 * scalar. Moving someone is one scalar update plus two counter deltas, atomic
 * in the same transaction, so "everyone placed, no one twice" is true by
 * construction, not by audit.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Placements are processed in chunks of ≤100, each chunk one transaction, so
 * a board-wide "auto-place all" stays inside Firestore's transaction limits
 * while a single drag is still one tiny atomic commit.
 */

type Ctx = { params: Promise<{ runId: string }> };

type Placement = { uid: string; groupId: string | null };

/** Placements per transaction. Reads ~3n docs and writes ≤2n — well inside
 * Firestore's 500-writes-per-transaction limit with room for counter docs. */
const CHUNK_SIZE = 100;

/** Sanity ceiling on one request — matches the board's 500-applicant read cap. */
const MAX_PLACEMENTS = 500;

/**
 * Machine-readable rejection reasons (the board maps them to copy):
 *  - "not-accepted":   no application, or its status isn't "accepted"
 *  - "group-not-found": target group missing or belongs to another run
 *  - "group-archived": target group is archived
 *  - "group-full":     placing would exceed the group's capacity
 */
type Rejection = { uid: string; reason: string };

function parsePlacements(body: unknown): Placement[] | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { placements?: unknown }).placements;
  if (!Array.isArray(raw)) return null;
  const out: Placement[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const { uid, groupId } = entry as { uid?: unknown; groupId?: unknown };
    if (typeof uid !== "string" || !uid) return null;
    if (groupId !== null && (typeof groupId !== "string" || !groupId)) return null;
    out.push({ uid, groupId: groupId ?? null });
  }
  return out;
}

/** Last write wins for a uid listed twice — the board sends latest intent. */
function dedupeByUid(placements: Placement[]): Placement[] {
  const byUid = new Map<string, Placement>();
  for (const p of placements) byUid.set(p.uid, p);
  return [...byUid.values()];
}

export async function POST(req: Request, ctx: Ctx) {
  const { runId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parsePlacements(body);
  if (!parsed) {
    return NextResponse.json({ error: "Malformed placements" }, { status: 400 });
  }
  if (parsed.length > MAX_PLACEMENTS) {
    return NextResponse.json(
      { error: `At most ${MAX_PLACEMENTS} placements per request.` },
      { status: 400 },
    );
  }
  const placements = dedupeByUid(parsed);
  if (placements.length === 0) {
    return NextResponse.json({ ok: true, placed: 0, rejected: [] });
  }

  const runSnap = await db.collection("courseRuns").doc(runId).get();
  if (!runSnap.exists) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = normalizeCourseRun(runSnap.id, runSnap.data() ?? {});

  const isAdmin = actor.role === "admin";
  const isTrackLead = run.trackLeadUids.includes(actor.uid);
  if (!isAdmin && !isTrackLead) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // The cohort week a fresh enrolment joins at. `anchorWeekNumber` is the
  // last taught week that has started (0 before the run — clamp to week 1 so
  // pre-term allocation, the normal case, anchors everyone to the beginning).
  // A draft run with no start date yet also anchors to week 1.
  const joinedWeekNumber = isValidDateKey(run.startDate)
    ? Math.max(1, currentWeekFor(run).anchorWeekNumber)
    : 1;

  let placed = 0;
  const rejected: Rejection[] = [];

  for (let i = 0; i < placements.length; i += CHUNK_SIZE) {
    const chunk = placements.slice(i, i + CHUNK_SIZE);
    let outcome: { placed: number; rejected: Rejection[] };
    try {
      // Accumulators live INSIDE the callback (returned, not captured):
      // Firestore retries a contended transaction, and outer accumulators
      // would double-count the retried attempt.
      outcome = await db.runTransaction(async (tx) => {
        const chunkRejected: Rejection[] = [];
        let chunkPlaced = 0;

        // ── Reads first, ALL of them ──────────────────────────────────────
        // Firestore transactions forbid reads after the first write, so the
        // whole chunk's inputs are gathered up front: enrolments and
        // applications for every uid, plus every distinct TARGET group. The
        // SOURCE groups (where movers currently sit) are only discoverable
        // from the enrolments just read, so they are a second read phase —
        // still strictly before any write.
        const enrolmentRefs = chunk.map((p) =>
          db.collection("courseEnrolments").doc(courseEnrolmentId(runId, p.uid)),
        );
        const applicationRefs = chunk.map((p) =>
          db.collection("courseApplications").doc(courseApplicationId(runId, p.uid)),
        );
        const targetGroupIds = [
          ...new Set(chunk.flatMap((p) => (p.groupId ? [p.groupId] : []))),
        ];
        const targetGroupRefs = targetGroupIds.map((id) =>
          db.collection("courseGroups").doc(id),
        );

        const [enrolmentSnaps, applicationSnaps, targetGroupSnaps] =
          await Promise.all([
            tx.getAll(...enrolmentRefs),
            tx.getAll(...applicationRefs),
            targetGroupRefs.length
              ? tx.getAll(...targetGroupRefs)
              : Promise.resolve([]),
          ]);

        const enrolmentByUid = new Map(
          chunk.map((p, idx) => [p.uid, enrolmentSnaps[idx]] as const),
        );
        const applicationByUid = new Map(
          chunk.map((p, idx) => [p.uid, applicationSnaps[idx]] as const),
        );
        const groupById = new Map(
          targetGroupIds.map((id, idx) => [id, targetGroupSnaps[idx]] as const),
        );

        // Second read phase: source groups not already fetched as targets.
        const sourceGroupIds = new Set<string>();
        for (const snap of enrolmentSnaps) {
          if (!snap.exists) continue;
          const gid = (snap.data() ?? {}).groupId;
          if (typeof gid === "string" && gid && !groupById.has(gid)) {
            sourceGroupIds.add(gid);
          }
        }
        if (sourceGroupIds.size > 0) {
          const refs = [...sourceGroupIds].map((id) =>
            db.collection("courseGroups").doc(id),
          );
          const snaps = await tx.getAll(...refs);
          [...sourceGroupIds].forEach((id, idx) => groupById.set(id, snaps[idx]));
        }

        // ── Decide, then write ────────────────────────────────────────────
        // Counter deltas accumulate per group and are written ONCE per group
        // at the end. `memberCount` counts enrolments that are BOTH active
        // AND grouped — the same definition the remove route decrements by —
        // so a move inside this chunk frees its old seat for a later
        // placement in the same array (capacity checks read the running
        // effective count, not the stored one).
        const deltaByGroup = new Map<string, number>();
        const effectiveCount = (groupId: string): number => {
          const snap = groupById.get(groupId);
          const stored = snap?.exists
            ? normalizeCourseGroup(snap.id, snap.data() ?? {}).memberCount
            : 0;
          return stored + (deltaByGroup.get(groupId) ?? 0);
        };
        const bumpDelta = (groupId: string, by: number) => {
          deltaByGroup.set(groupId, (deltaByGroup.get(groupId) ?? 0) + by);
        };

        for (const placement of chunk) {
          const { uid, groupId } = placement;

          // Only ACCEPTED applicants may be placed — allocation follows
          // admissions, never sidesteps it. (Direct enrolment without an
          // application is a different, future path.)
          const appSnap = applicationByUid.get(uid);
          const appStatus = appSnap?.exists ? (appSnap.data() ?? {}).status : null;
          if (appStatus !== "accepted") {
            chunkRejected.push({ uid, reason: "not-accepted" });
            continue;
          }

          if (groupId) {
            const groupSnap = groupById.get(groupId);
            const group = groupSnap?.exists
              ? normalizeCourseGroup(groupSnap.id, groupSnap.data() ?? {})
              : null;
            if (!group || group.runId !== runId) {
              chunkRejected.push({ uid, reason: "group-not-found" });
              continue;
            }
            if (group.archived) {
              chunkRejected.push({ uid, reason: "group-archived" });
              continue;
            }
          }

          const enrolmentSnap = enrolmentByUid.get(uid);
          const enrolment = enrolmentSnap?.exists
            ? normalizeCourseEnrolment(enrolmentSnap.id, enrolmentSnap.data() ?? {})
            : null;
          const enrolmentRef = db
            .collection("courseEnrolments")
            .doc(courseEnrolmentId(runId, uid));

          // Whether this enrolment currently holds a counted seat.
          const wasCounted =
            enrolment !== null &&
            enrolment.status === "active" &&
            enrolment.groupId !== null;

          // Already exactly where they're being placed — nothing to do. (An
          // inactive enrolment "in" the same group still falls through to be
          // reactivated below.)
          if (
            enrolment &&
            enrolment.groupId === groupId &&
            enrolment.status === "active"
          ) {
            continue;
          }

          // CAPACITY IS HARD here: the in-transaction effective count (stored
          // memberCount adjusted by this chunk's earlier placements) must stay
          // within capacity. The board surfaces a "group-full" rejection;
          // admins raise the cap in the group editor if the group really
          // should take more.
          if (groupId) {
            const group = normalizeCourseGroup(
              groupId,
              groupById.get(groupId)?.data() ?? {},
            );
            // A same-group reactivation adds a seat too, so it is checked the
            // same as any other placement.
            if (group.capacity !== null && effectiveCount(groupId) >= group.capacity) {
              chunkRejected.push({ uid, reason: "group-full" });
              continue;
            }
          }

          if (!enrolment) {
            // Un-placing someone who was never enrolled: nothing to create.
            // (A null placement is only meaningful once an enrolment exists.)
            if (!groupId) continue;

            // First placement = the enrolment's birth. `tx.create` (not set)
            // so a concurrent allocator racing on the same person loses with
            // ALREADY_EXISTS instead of silently overwriting — the doc id is
            // the invariant (see module comment).
            tx.create(enrolmentRef, {
              runId,
              courseId: run.courseId,
              uid,
              groupId,
              status: "active",
              role: "learner",
              applicationId: courseApplicationId(runId, uid),
              joinedWeekNumber,
              createdAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            });
            bumpDelta(groupId, 1);
            chunkPlaced += 1;
            continue;
          }

          // Existing enrolment → MOVE (or un-place, or reactivate): ONE
          // scalar update plus the counter deltas. A "removed" or "withdrawn"
          // enrolment being re-placed flips back to "active" here — the row
          // is the person's whole history on this run (the deterministic id
          // means there can never be a second row), so re-admission is a
          // status flip, not a new doc. Its old seat was already released
          // when it left "active", so only the +1 side applies.
          const patch: Record<string, unknown> = {
            groupId,
            status: "active",
            updatedAt: FieldValue.serverTimestamp(),
          };
          if (enrolment.groupId !== groupId) {
            // The stamp certifies "emailed about their CURRENT group"; a
            // changed placement invalidates it, so the next publish emails
            // them about the new group.
            patch.allocatedEmailAt = FieldValue.delete();
          }
          tx.update(enrolmentRef, patch);
          if (wasCounted && enrolment.groupId) bumpDelta(enrolment.groupId, -1);
          if (groupId) bumpDelta(groupId, 1);
          chunkPlaced += 1;
        }

        // All deltas land once per group per transaction.
        for (const [groupId, delta] of deltaByGroup) {
          if (delta === 0) continue;
          tx.update(db.collection("courseGroups").doc(groupId), {
            memberCount: FieldValue.increment(delta),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        return { placed: chunkPlaced, rejected: chunkRejected };
      });
    } catch (err) {
      // Chunks are independent transactions, so earlier chunks are already
      // committed — say so honestly rather than pretending nothing happened.
      console.error("[courses allocate] transaction failed", runId, err);
      return NextResponse.json(
        {
          error:
            placed > 0
              ? `Some placements failed to save — ${placed} were applied before the error. Reload the board to see the current state.`
              : "Couldn't save those placements.",
          placed,
          rejected,
        },
        { status: 500 },
      );
    }
    placed += outcome.placed;
    rejected.push(...outcome.rejected);
  }

  return NextResponse.json({ ok: true, placed, rejected });
}
