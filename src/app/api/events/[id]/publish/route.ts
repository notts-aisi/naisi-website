import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { sendEventAnnouncement } from "@/lib/email/eventAnnouncement";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { baseUrl } from "@/lib/events/rsvpToken";
import { formatEventWhen } from "@/lib/events/changeSummary";

/**
 * Server-only transition from "approved" to "published". Firestore rules block
 * clients from writing status == "published" directly (mirrors the newsletter
 * "sent" gate). Gated to approvers + admins.
 *
 * ── AND THE ONE MOMENT THE `events` ROW SENDS ANYTHING ──────────────────────
 * Publishing is what the notification grid's events row has always promised
 * ("a short email when we publish a new event") and what nothing has ever
 * delivered. It sends here, once per event, to the events row on both columns:
 * by email to the `subscriptions` junction the way the newsletter sends, and by
 * push to members whose events push cell is on. `sendEventAnnouncement` owns
 * both audiences and the whole argument for them.
 *
 * ── ONCE PER EVENT, UNDER A CLAIM ───────────────────────────────────────────
 * `announcedAt` is stamped on the event document INSIDE the transaction that
 * publishes it, so two requests racing to publish the same event cannot both
 * come out holding the announcement: one wins the status transition and the
 * loser sees a status that is no longer "approved". The stamp also survives a
 * later republish (an event pulled back to approved and pushed live again is
 * not news twice), which the status check alone would not catch.
 *
 * The claim is made BEFORE the send rather than after it, and that is a real
 * trade: an announcement that fails after the stamp is not retried, and the
 * event is live with nobody told. The other way round is worse, because it
 * fails in the direction of mailing the whole list twice. The failure is logged
 * and counted in the response so a publisher can see it happened.
 *
 * ── PUBLISHING NEVER FAILS BECAUSE THE ANNOUNCEMENT FAILED ──────────────────
 * The write is committed first and the send is best effort inside a try/catch,
 * exactly as the stage-release job treats its push. An event that went live
 * without its email is a missing email; an announcement that turned a publish
 * into a 500 would be an event that IS live on a page saying it failed to save.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const actor = await getCurrentUser();
  if (!actor) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const allowed = actor.role === "admin" || actor.permissions.approveEvent;
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 });
  }

  const ref = db.collection("events").doc(id);

  // The status transition and the announcement claim in ONE write. See the
  // header: the claim is what makes the announcement once-per-event.
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      return { ok: false as const, status: 404, error: "Event not found" };
    }
    const current = snap.data() ?? {};
    if (current.status !== "approved") {
      return {
        ok: false as const,
        status: 400,
        error: `Can only publish from "approved", not "${current.status}"`,
      };
    }
    const announce = !current.announcedAt;
    tx.update(ref, {
      status: "published",
      publishedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...(announce ? { announcedAt: FieldValue.serverTimestamp() } : {}),
    });
    return { ok: true as const, announce, event: current };
  });

  if (!claim.ok) {
    return NextResponse.json({ error: claim.error }, { status: claim.status });
  }
  if (!claim.announce) {
    // Already announced on an earlier publish. The event is live either way.
    return NextResponse.json({ ok: true, announced: false });
  }

  const event = claim.event;
  const membersOnly = event.visibility === "members";
  // The PUBLIC location: this list is not the attendee list, so a hidden
  // location shows its placeholder here and the exact room stays behind an
  // approved RSVP.
  const locationLine = event.locationHidden
    ? ((event.locationPublicText as string | null | undefined) ??
      "Location shared with attendees")
    : ((event.location as string | null | undefined) || "Location to be confirmed");

  try {
    const result = await sendEventAnnouncement(db, {
      eventId: id,
      title: (event.title ?? "NAISI event").toString(),
      whenLine: formatEventWhen(
        event.startAt?.toDate?.() ?? null,
        event.endAt?.toDate?.() ?? null,
      ),
      locationLine,
      eventUrl: `${baseUrl()}/events/${id}`,
      coverImageUrl: (event.posterUrl as string | null | undefined) ?? null,
      membersOnly,
      actorUid: actor.uid,
    });
    if (result.refusal) {
      console.error("[event publish] announcement refused", id, result.refusal);
    }
    return NextResponse.json({ ok: true, announced: true, announcement: result });
  } catch (err) {
    // The event is published. A failed announcement is logged and reported, and
    // is never allowed to look like a failed publish. See the header.
    console.error("[event publish] announcement failed", id, err);
    return NextResponse.json({ ok: true, announced: false, announcementFailed: true });
  }
}
