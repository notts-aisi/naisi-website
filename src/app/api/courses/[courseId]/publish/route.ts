import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

/**
 * Publish a course to the public catalogue, and choose which run's curriculum
 * the public pages display (`showcaseRunId`, null = published with no
 * curriculum preview yet).
 *
 * Gated to admins and `approveCourse` holders: publication is the two-person
 * half of review, and the public course pages are served by Admin-SDK fetchers
 * that key off `status == "published"` — flipping this bit is what makes a
 * draft world-readable.
 *
 * The showcase run must belong to THIS course. Without that check an admin
 * could point one course's shop window at another course's (possibly draft,
 * possibly unrelated) curriculum, which the public fetchers would then render
 * under the wrong title.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ courseId: string }> },
) {
  const { courseId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!(actor.role === "admin" || actor.permissions.approveCourse)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { showcaseRunId?: unknown };
  try {
    body = (await req.json()) as { showcaseRunId?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = body.showcaseRunId ?? null;
  if (raw !== null && typeof raw !== "string") {
    return NextResponse.json({ error: "showcaseRunId must be a run id or null" }, { status: 400 });
  }
  const showcaseRunId = raw && raw.trim() ? raw.trim() : null;

  const ref = db.collection("courses").doc(courseId);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  if (showcaseRunId) {
    const runSnap = await db.collection("courseRuns").doc(showcaseRunId).get();
    if (!runSnap.exists) {
      return NextResponse.json({ error: "Showcase run not found" }, { status: 404 });
    }
    if ((runSnap.data() ?? {}).courseId !== courseId) {
      return NextResponse.json(
        { error: "That run belongs to a different course." },
        { status: 400 },
      );
    }
  }

  // Publishing from `draft` and re-publishing from `archived` are both real
  // operations (a course comes back for a new year), and re-publishing an
  // already-published course is how the showcase run gets swapped — so there
  // is deliberately no from-status gate here, unlike the events publish route.
  await ref.update({
    status: "published",
    showcaseRunId,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, showcaseRunId });
}
