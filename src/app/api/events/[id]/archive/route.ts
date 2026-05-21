import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

/**
 * Archive or unarchive an event. Archiving is orthogonal to status — a
 * published event stays published while archived, it just drops out of the
 * normal manage sections into the collapsed "Archived" group. Reversible, so
 * it is low-stakes.
 *
 * Routed through the Admin SDK because Firestore rules block client writes to
 * published events, and the events worth archiving are usually published.
 * Gated to admins and the event's author.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const actor = await getCurrentUser();
  if (!actor) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  let body: { archived?: unknown };
  try {
    body = (await req.json()) as { archived?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.archived !== "boolean") {
    return NextResponse.json(
      { error: "Body needs an 'archived' boolean." },
      { status: 400 },
    );
  }

  const ref = db.collection("events").doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  const event = snap.data() ?? {};

  const isAuthor = event.authorUid === actor.uid;
  if (!(actor.role === "admin" || isAuthor)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await ref.update({
    archived: body.archived,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true, archived: body.archived });
}
