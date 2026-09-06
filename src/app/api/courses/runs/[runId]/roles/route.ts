import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { asUidList } from "@/lib/firestore/events";
import { COURSE_FIELD_LIMITS } from "@/lib/firestore/courses";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";

/**
 * A run's three server-owned role arrays:
 *
 *  - `admissionsReviewerUids` — members who review applications to this run.
 *  - `trackLeadUids` — the run's leads (may edit run content and staff groups).
 *  - `runFacilitatorUids` — the run-level facilitator pool.
 *
 * Admissions is deliberately a DIFFERENT array from facilitation: reviewing
 * applicants grants no access to the cohort, and facilitating grants no sight
 * of anyone's application. firestore.rules pins all three against client
 * writes, so this route (Admin SDK) is the only way they move.
 *
 * GET  — the pickable candidates plus the current arrays, so the admin picker
 *        can render names. Admin-only, like the POST.
 * POST — replaces any subset of the three arrays. Each requested list is
 *        INTERSECTED with the eligible member set before it is written, so a
 *        stale, forged, or since-rejected uid can never land on a run.
 */

const ELIGIBLE_ROLES = ["member", "committee", "admin"] as const;

type Candidate = {
  uid: string;
  displayName: string;
  photoURL: string | null;
  role: string;
};

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

/**
 * Approved members, committee and admins — the only people who may hold a
 * course role. Pending and rejected accounts are excluded by the query, which
 * is what makes the intersection below a real gate rather than a formality.
 * (Same shape as the events collaborators route's candidate load; kept local
 * because route handlers don't import from one another.)
 */
async function loadCandidates(db: Firestore): Promise<Candidate[]> {
  const snap = await db
    .collection("users")
    .where("role", "in", [...ELIGIBLE_ROLES])
    .get();
  return snap.docs
    .map((d) => {
      const data = d.data() ?? {};
      return {
        uid: d.id,
        displayName: displayNameOf(data),
        photoURL: typeof data.photoURL === "string" ? data.photoURL : null,
        role: typeof data.role === "string" ? data.role : "member",
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const snap = await db.collection("courseRuns").doc(runId).get();
  if (!snap.exists) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  const run = snap.data() ?? {};

  const candidates = await loadCandidates(db);
  return NextResponse.json({
    candidates,
    admissionsReviewerUids: asUidList(run.admissionsReviewerUids),
    trackLeadUids: asUidList(run.trackLeadUids),
    runFacilitatorUids: asUidList(run.runFacilitatorUids),
  });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { runId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  // Assigning who reviews applications and who leads a track is an admin
  // decision — a drafter or approver cannot grant themselves either.
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: {
    admissionsReviewerUids?: unknown;
    trackLeadUids?: unknown;
    runFacilitatorUids?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ref = db.collection("courseRuns").doc(runId);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const eligible = new Set((await loadCandidates(db)).map((c) => c.uid));
  const clean = (raw: unknown, cap: number) =>
    asUidList(raw)
      .filter((uid) => eligible.has(uid))
      .slice(0, cap);

  // Only the keys the caller actually sent are written — omitting a field
  // leaves that role untouched rather than clearing it.
  const patch: Record<string, unknown> = {};
  if (body.admissionsReviewerUids !== undefined) {
    patch.admissionsReviewerUids = clean(
      body.admissionsReviewerUids,
      COURSE_FIELD_LIMITS.maxAdmissionsReviewers,
    );
  }
  if (body.trackLeadUids !== undefined) {
    patch.trackLeadUids = clean(body.trackLeadUids, COURSE_FIELD_LIMITS.maxTrackLeads);
  }
  if (body.runFacilitatorUids !== undefined) {
    patch.runFacilitatorUids = clean(
      body.runFacilitatorUids,
      COURSE_FIELD_LIMITS.maxRunFacilitators,
    );
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No roles supplied" }, { status: 400 });
  }

  patch.updatedAt = FieldValue.serverTimestamp();
  await ref.update(patch);

  return NextResponse.json({ ok: true });
}
