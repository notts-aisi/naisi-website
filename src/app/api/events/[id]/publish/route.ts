import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { sendEventAnnouncement } from "@/lib/email/eventAnnouncement";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCurrentUser } from "@/lib/firebase/session";
import { baseUrl } from "@/lib/events/rsvpToken";
import { formatEventWhen } from "@/lib/events/changeSummary";
import { hiddenLocationLacksLabel, publicLocationLine } from "@/lib/events/location";
import { announcementQueueEnabled } from "@/lib/scheduler/announcementQueue";

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
 * ── TWO PATHS OUT OF THAT CLAIM, AND A SWITCH DECIDES WHICH ────────────────
 * The send itself runs inside this request, against `apphosting.yaml`'s
 * `timeoutSeconds: 60`, which is why it carries three ceilings and why
 * docs/notifications.md called that "the known limit". The answer written down
 * there is the `event-announcements` scheduler job, and this route is where
 * the two paths part.
 *
 * The job's switch is read ONCE, before the transaction. A switch flipped
 * during a request is not a case worth a read inside it: the announcement is
 * claimed either way, and whichever path this request chose is the path that
 * delivers it.
 *
 *  - SWITCH OFF (the shipped default, and prod's state, since prod has no
 *    `SCHEDULER_SECRET` and therefore no tick): everything below runs exactly
 *    as it always has. Nothing changes for anybody until an admin flips it.
 *  - SWITCH ON: the same transaction that stamps `announcedAt` also writes
 *    `announcementState: "queued"` and `announcementQueuedAt`, and this route
 *    sends nothing at all. The job picks the event up on the next tick, one
 *    marker per recipient, and writes the result back onto the document for
 *    the editor to read.
 *
 * ── AND A PURE REFUSAL HANDS THE CLAIM BACK ─────────────────────────────────
 * There is one outcome where the trade above buys nothing: the announcement
 * REFUSES, deterministically, before it dispatches anything (the list is over
 * its ceiling). Nothing was sent, nothing can have been half-sent, and yet the
 * claim is spent, `announce` can never be true again, and no supported action
 * gets the announcement out. So that one case clears `announcedAt` and says so
 * in the response: the ceiling can be raised and the event republished. The
 * job applies the same rule to its own refusals.
 *
 * The condition is deliberately narrow: a refusal AND nothing sent, failed or
 * pushed. A THROW is not released: `dispatchSends` can reject after other
 * workers have already delivered, so a retry there would re-mail people. A
 * partial send keeps its claim for the same reason.
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

  // WHICH PATH THIS PUBLISH TAKES, decided once and before the transaction.
  // Through the same helper and the same `enabledByDefault` the tick uses, so
  // the panel's switch and this branch can never mean two different things. A
  // read that fails falls back to the INLINE path, which is the direction that
  // still delivers the announcement.
  let queueIt = false;
  try {
    queueIt = await announcementQueueEnabled(db);
  } catch (err) {
    console.error("[event publish] scheduler switch unreadable, sending inline", id, err);
  }

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
    // The editor checks this before review and the update route refuses it on
    // a live event, but a draft is written client-direct and can reach
    // approval without a label. Every surface fails closed on the state; this
    // is what stops it going live at all.
    if (hiddenLocationLacksLabel(current)) {
      return {
        ok: false as const,
        status: 400,
        error:
          "You've hidden the exact location. Add a fuzzy label to show publicly (e.g. 'somewhere on campus') before publishing.",
      };
    }
    const announce = !current.announcedAt;
    tx.update(ref, {
      status: "published",
      publishedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...(announce ? { announcedAt: FieldValue.serverTimestamp() } : {}),
      // The hand-off, inside the same write as the claim it belongs to. A
      // queue state written afterwards could survive a claim that did not.
      ...(announce && queueIt
        ? {
            announcementState: "queued",
            announcementQueuedAt: FieldValue.serverTimestamp(),
          }
        : {}),
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
  if (queueIt) {
    // Queued, and this request is done. `announced` is false because nobody
    // has been told yet, which is the same word it has always meant here.
    return NextResponse.json({
      ok: true,
      announced: false,
      announcementQueued: true,
    });
  }

  const event = claim.event;
  const membersOnly = event.visibility === "members";
  // The PUBLIC location: this list is not the attendee list, so a hidden
  // location shows its placeholder here and the exact room stays behind a
  // confirmed RSVP. `@/lib/events/location` is the one place that decides.
  const locationLine = publicLocationLine(event);

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
    // Nothing sent, nothing failed, nothing pushed, and a refusal to explain
    // why: the claim bought nothing, so hand it back. See the header.
    const nothingWentOut =
      result.refusal !== null &&
      result.sent === 0 &&
      result.failed === 0 &&
      result.pushed === 0;
    if (nothingWentOut) {
      console.error("[event publish] announcement refused", id, result.refusal);
      try {
        await ref.update({ announcedAt: FieldValue.delete() });
      } catch (err) {
        // The event is published either way. A claim that could not be released
        // is a missing announcement, not a failed publish.
        console.error("[event publish] could not release the announcement claim", id, err);
      }
      return NextResponse.json({
        ok: true,
        announced: false,
        announcementRefused: true,
        announcement: result,
      });
    }
    if (result.refusal) {
      // One leg refused and the other did not: the claim stays spent, because
      // part of the audience has been told.
      console.error("[event publish] announcement partly refused", id, result.refusal);
    }
    // `announced` is whether anybody was actually told, not whether the attempt
    // ran. A publisher reading `true` over an empty send would have no way to
    // learn that nobody heard.
    return NextResponse.json({
      ok: true,
      announced: result.sent > 0 || result.pushed > 0,
      announcement: result,
    });
  } catch (err) {
    // The event is published. A failed announcement is logged and reported, and
    // is never allowed to look like a failed publish. See the header.
    console.error("[event publish] announcement failed", id, err);
    return NextResponse.json({ ok: true, announced: false, announcementFailed: true });
  }
}
