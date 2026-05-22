import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { sanitizeSignupForm } from "@/lib/firestore/events";
import { buildSyntheticRsvp } from "@/lib/events/syntheticRsvps";

/**
 * Admin-only test data. Lets an organiser trial a full signup flow on an
 * unpublished event, without entering RSVPs by hand, then clear them again.
 * Every generated doc is tagged `synthetic: true`.
 *
 *   POST   { count }  create `count` confirmed synthetic RSVPs
 *   DELETE            remove every synthetic RSVP on the event
 *
 * The event editor's delete also calls DELETE so test data never orphans.
 */

const MAX_PER_REQUEST = 60;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  let body: { count?: unknown };
  try {
    body = (await req.json()) as { count?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const count = Math.floor(Number(body.count));
  if (!Number.isFinite(count) || count < 1) {
    return NextResponse.json({ error: "Pick how many to generate." }, { status: 400 });
  }
  if (count > MAX_PER_REQUEST) {
    return NextResponse.json(
      { error: `Generate at most ${MAX_PER_REQUEST} at a time.` },
      { status: 400 },
    );
  }

  const eventRef = db.collection("events").doc(id);
  const snap = await eventRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  const event = snap.data() ?? {};
  if (event.status === "published") {
    return NextResponse.json(
      { error: "Test RSVPs can only be generated on an unpublished event." },
      { status: 400 },
    );
  }

  const questions = sanitizeSignupForm(event.signupForm);
  const col = db.collection("eventRsvps");
  const batch = db.batch();
  for (let i = 0; i < count; i++) {
    const synthetic = buildSyntheticRsvp(questions);
    batch.set(col.doc(), {
      eventId: id,
      uid: null,
      name: synthetic.name,
      email: synthetic.email,
      answers: synthetic.answers,
      // Confirmed so the catering, charts and pizza-helper views populate at once.
      status: "confirmed",
      synthetic: true,
      decisionNote: null,
      decidedBy: actor.uid,
      decidedAt: FieldValue.serverTimestamp(),
      pendingAnswers: null,
      pendingAnswersRequestedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      cancelledAt: null,
    });
  }
  await batch.commit();

  return NextResponse.json({ ok: true, created: count });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const actor = await getCurrentUser();
  if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: "Server not configured" }, { status: 500 });

  const snap = await db.collection("eventRsvps").where("eventId", "==", id).get();
  const synthetic = snap.docs.filter((d) => d.data().synthetic === true);

  // Firestore caps a batch at 500 writes; chunk to stay well under.
  for (let i = 0; i < synthetic.length; i += 400) {
    const batch = db.batch();
    for (const doc of synthetic.slice(i, i + 400)) batch.delete(doc.ref);
    await batch.commit();
  }

  return NextResponse.json({ ok: true, deleted: synthetic.length });
}
