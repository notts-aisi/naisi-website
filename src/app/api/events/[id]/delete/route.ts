import { NextResponse } from "next/server";
import { getAdminDb, getAdminStorage } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";

type Ctx = RouteContext<"/api/events/[id]/delete">;

/**
 * Cascade-delete an event: its RSVPs, its Storage images, then the doc itself.
 *
 * Deleting an event used to be a bare client-side `deleteDoc` (eventMutations.ts)
 * with no cascade at all. `eventRsvps` rules lock client writes to `false`, so
 * the attendee rows could not be removed from the client even in principle —
 * they simply stayed. A forensic scan on 2026-08-02 found 6 orphan RSVP rows and
 * 6 orphan images on production belonging to events that no longer exist, each
 * still holding an attendee's name, email and free-text answers (dietary
 * requirements among them) with no event left to justify keeping them. Under UK
 * GDPR that is personal data retained past its purpose.
 *
 * So deletion moves server-side, exactly like the task cascade and the account
 * cascade before it, and the client `allow delete` on `events` is withdrawn —
 * otherwise a client could still delete just the doc and strand the rest.
 *
 * Ordering mirrors deleteAccountCascade: the PII goes first and is FATAL on
 * failure (a surviving RSVP row is the whole point of this route), Storage is
 * best-effort (blobs are not personal data and a failure must not block the
 * teardown), and the event doc goes last so a mid-way failure leaves the event
 * visible and retryable rather than a dangling set of orphans with no parent.
 */
export async function POST(_req: Request, ctx: Ctx) {
  const { id: eventId } = await ctx.params;

  const viewer = await getCurrentUser();
  if (!viewer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const eventRef = db.collection("events").doc(eventId);
  const snap = await eventRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  const event = snap.data() ?? {};

  // Mirror what firestore.rules used to allow, so withdrawing the client rule
  // takes nothing away: admins always; otherwise the author, holding
  // `draftEvent`, on an event that was never published. A published event has
  // attendees who were told it exists — it gets cancelled, not deleted.
  const isAuthor = event.authorUid === viewer.uid;
  const canDraft = viewer.role === "admin" || viewer.permissions?.draftEvent === true;
  const canDelete =
    viewer.role === "admin" || (canDraft && isAuthor && event.status !== "published");
  if (!canDelete) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // 1. Attendee PII. FATAL on failure — this is the reason the route exists.
  let rsvpsDeleted = 0;
  try {
    const rsvps = await db.collection("eventRsvps").where("eventId", "==", eventId).get();
    // Firestore caps a WriteBatch at 500 operations; chunk rather than assume
    // an event never drew more attendees than that.
    for (let i = 0; i < rsvps.docs.length; i += 400) {
      const batch = db.batch();
      for (const d of rsvps.docs.slice(i, i + 400)) batch.delete(d.ref);
      await batch.commit();
    }
    rsvpsDeleted = rsvps.size;
  } catch (err) {
    console.error("[events/delete] RSVP delete failed:", eventId, err);
    return NextResponse.json(
      { error: "Couldn't remove this event's RSVPs; nothing else was deleted." },
      { status: 500 },
    );
  }

  // 2. Storage images. Best-effort. The prefix is derived from the event id
  //    here rather than read from a stored field — the task-delete routes took
  //    a client-written path and that turned into arbitrary object deletion.
  let imagesDeleted = 0;
  let storageWarning: string | undefined;
  const storage = getAdminStorage();
  if (storage) {
    try {
      const [files] = await storage.bucket().getFiles({ prefix: `event-images/${eventId}/` });
      await Promise.all(files.map((f) => f.delete({ ignoreNotFound: true })));
      imagesDeleted = files.length;
    } catch (err) {
      console.error("[events/delete] image cleanup failed (best-effort):", eventId, err);
      storageWarning = "The event was deleted but its images could not be removed.";
    }
  }

  // 3. The event itself, last.
  try {
    await eventRef.delete();
  } catch (err) {
    console.error("[events/delete] event doc delete failed:", eventId, err);
    return NextResponse.json(
      { error: "The event's RSVPs were removed but the event itself could not be deleted." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    rsvpsDeleted,
    imagesDeleted,
    ...(storageWarning ? { warning: storageWarning } : {}),
  });
}
