import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import {
  DestroyBlockedError,
  DestroyPassInFlightError,
  destroyCourseCascade,
} from "@/lib/firestore/courseDeletion";
import { normalizeCourse } from "@/lib/firestore/courses";
import { assertNotImpersonating } from "@/lib/firebase/impersonation";

/**
 * DESTROY a course. Only reachable once every run is gone (each run
 * destroyed individually through its own manifest + typed confirmation —
 * the engine's blockers enforce it), so the cascade is small: audit row +
 * marker, then the course doc. See destroyCourseCascade for the ordering
 * and the orphaned-template-provenance decision.
 *
 * Same contract as the run destroy: admin only, authorization before
 * existence, typed confirmation (`confirmName` must equal the course TITLE
 * by byte equality — and an untitled course is refused outright rather than
 * confirmed by typing nothing), blockers → 409, a 409 while another pass
 * holds the audit row, and `{ ok, deleted, complete, auditId }` with
 * repeat-the-same-call resume semantics. `deleted` is the audit row's
 * ACCUMULATED totals, not this invocation's page.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ courseId: string }> },
) {
  const blocked = await assertNotImpersonating();
  if (blocked) return blocked;

  const { courseId } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { confirmName?: unknown };
  try {
    body = (await req.json()) as { confirmName?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.confirmName !== "string") {
    return NextResponse.json({ error: "confirmName is required" }, { status: 400 });
  }

  const courseSnap = await db.collection("courses").doc(courseId).get();
  if (!courseSnap.exists) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  const course = normalizeCourse(courseSnap.id, courseSnap.data() ?? {});

  // An unnamed thing cannot be confirmed by name: with an empty title the
  // comparison below is "" === "" and the confirmation passes on an empty
  // body. Refused with the fix named (the run destroy's twin).
  if (course.title.length === 0) {
    return NextResponse.json(
      {
        error:
          "This course has no title, so there is nothing to type as confirmation — give it one under Course details before destroying it.",
      },
      { status: 409 },
    );
  }

  // Byte equality against the course TITLE — nothing normalised away.
  if (body.confirmName !== course.title) {
    return NextResponse.json(
      { error: "That doesn't match the course's title. Type it exactly to confirm." },
      { status: 400 },
    );
  }

  try {
    const result = await destroyCourseCascade(db, courseId, {
      actorUid: actor.uid,
      actorName: actor.displayName?.trim() || "NAISI admin",
    });
    return NextResponse.json({
      ok: true,
      deleted: result.deleted,
      complete: result.complete,
      auditId: result.auditId,
    });
  } catch (err) {
    if (err instanceof DestroyBlockedError) {
      return NextResponse.json(
        { error: err.blockers[0], blockers: err.blockers },
        { status: 409 },
      );
    }
    if (err instanceof DestroyPassInFlightError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[destroy-course] cascade failed (resumable):", courseId, err);
    return NextResponse.json(
      { error: "The destroy was interrupted. Run it again to resume." },
      { status: 500 },
    );
  }
}
