import "server-only";

/**
 * `event-announcements`: the "we have published a new event" announcement,
 * taken off the publish request.
 *
 * ## WHAT THIS IS FOR
 *
 * `POST /api/events/[id]/publish` has always sent the announcement inline,
 * inside the request that publishes, against App Hosting's 60s timeout. That
 * bought three ceilings (500 junction rows read, 200 messages sent, 500 device
 * rows) and docs/notifications.md has called it "the known limit" ever since,
 * with the answer written down: a list that outgrows those numbers needs the
 * send taken off the request path, as a scheduler job. This is that job.
 *
 * ## TWO PATHS, AND THE SWITCH DECIDES WHICH ONE A PUBLISH TAKES
 *
 * The publish route reads THIS job's switch once, before its transaction. Off
 * (the shipped default, and prod's state, because prod has no
 * `SCHEDULER_SECRET` and therefore no tick at all) it sends inline exactly as
 * it always has, ceilings and all, and nothing about a publish changes. On, it
 * stamps `announcedAt` as usual and writes `announcementState: "queued"` in
 * the same transaction instead of sending, and this job does the work.
 *
 * SO THIS JOB SHIPS DARK, AND MUST STAY DARK WHERE THE TICK IS NOT ARMED.
 * Switching it on where no scheduler calls `/api/scheduler/tick` would take
 * every publish off the inline path and queue announcements nobody ever
 * delivers, which is worse than the ceiling it replaces. Dev is armed today;
 * prod is not.
 *
 * ## THE CLAIM IS STILL ONCE PER EVENT, AND IT IS STILL `announcedAt`
 *
 * Nothing about the once-per-event claim moves. The publish transaction stamps
 * `announcedAt` before anything is queued, so two racing publishes still
 * produce one announcement and a republish is still not news twice. What the
 * queue adds is a SECOND layer underneath it: one marker per recipient per
 * leg, so exactly-once survives a tick that runs out of budget half way down
 * the list, a container that dies mid-send, and two ticks overlapping (which
 * the re-arm makes ordinary, see the tick route's header).
 *
 * A consequence worth stating: nothing here claims the EVENT. Two ticks may
 * both pick up the same queued event and both walk its audience; the markers
 * make that harmless, where an event-level claim would need its own expiry
 * rule and its own way of going wrong. `announcementState: "sending"` is a
 * progress note, not a lock.
 *
 * ## ONE UNIT OF WORK IS ONE RECIPIENT
 *
 * Email: one recipient, all of their addresses (a member with two verified
 * addresses is one unit and two messages, because the unsubscribe token and
 * the marker are per person). Push: one uid. Between units the tick's budget
 * and `maxPerTick` are both checked, and either one stops the run with
 * `hasMore: true`, leaving the event `sending` for the next tick to resume.
 *
 * THE REQUEST PATH'S MESSAGE CEILING DOES NOT APPLY HERE. That is the whole
 * point of the move. What survives is a sanity ceiling on each of the two
 * READS, because neither is paged: `MAX_QUEUED_ANNOUNCEMENT_ROWS` (5000) on
 * the junction and {@link MAX_QUEUED_PUSH_ROWS} (5000) on the devices. Both
 * refuse whole rather than truncating.
 *
 * ## STALE IS MEASURED AGAINST THE EVENT, NOT AGAINST THE QUEUE
 *
 * A queued announcement that is a day late is still worth sending: an event
 * page that went live stays news until the event itself has happened. So there
 * is no lateness bound on the queue at all. What IS refused is an announcement
 * for an event whose `startAt` has passed, because "come to this" about
 * something that already happened is worse than silence.
 *
 * `maxLateHours` is therefore not the ordinary bound, and it is not decoration
 * either: it is the fallback for an event with NO `startAt` (the normaliser
 * produces one from a document whose timestamp is missing or malformed), which
 * would otherwise sit in the queue for ever with nothing able to rule on it.
 *
 * A stale refusal RELEASES NOTHING. `announcedAt` stays stamped, because there
 * is no later moment at which this announcement becomes worth sending and
 * handing the claim back would invite a republish to try again.
 *
 * ## A PURE REFUSAL HANDS THE CLAIM BACK, EXACTLY AS THE INLINE PATH DOES
 *
 * If both audience reads refuse and this event has never had a single message
 * or notification out of it, `announcedAt` is cleared along with the queue
 * state, so raising the ceiling and publishing again re-queues the whole
 * thing. The totals it checks are the ACCUMULATED ones on the document, not
 * this tick's, so an event that sent forty emails on Monday and hit a
 * refusal on Tuesday keeps its claim.
 *
 * ## LOGGING
 *
 * By event id and by uid or audience key. Never an address: the log is not the
 * place a mailing list accumulates, and the marker ids are hashed for the same
 * reason (see `announcementRecipientKey`).
 */

import { FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  announcementRecipientKey,
  resolveAnnouncementAudience,
  sendAnnouncementToRecipient,
  MAX_QUEUED_ANNOUNCEMENT_ROWS,
  type AnnouncementRecipient,
  type EventAnnouncementInput,
} from "@/lib/email/eventAnnouncement";
import { formatEventWhen } from "@/lib/events/changeSummary";
import { baseUrl } from "@/lib/events/rsvpToken";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  normalizeEvent,
  type EventAnnouncementResultDoc,
  type EventDoc,
} from "@/lib/firestore/events";
import { filterSuppressed } from "@/lib/firestore/suppression";
import { wantsPushFor } from "@/lib/push/preferences";
import { rowPushOwners } from "@/lib/push/rowAudience";
import { sendPushToUid } from "@/lib/push/send";
import {
  claim,
  errorText,
  eventAnnouncementMarker,
  stampError,
  stampSent,
  stampSkipped,
} from "@/lib/scheduler/markers";
import type { JobContext, JobRegistration, JobResult } from "../registry";

export const EVENT_ANNOUNCEMENTS_JOB_ID = "event-announcements";

/** The bracketed prefix every line this job logs carries. */
const LOG_TAG = "event announcement job";

/**
 * The states a queued announcement can be in while it still owes work.
 *
 * ONE `in` FILTER ON ONE FIELD, no `orderBy` and no second clause, which is
 * what keeps this off `firestore.indexes.json`: `in` is an equality operator
 * (`tests/firestore-indexes.test.mjs`, IN_IS_EQUALITY) and a single equality
 * field at collection scope is served by the automatic single-field index. The
 * ordering that matters, oldest queued first, is done in code below, because
 * an `orderBy("announcementQueuedAt")` would both need a composite index and
 * drop every event that somehow lacks the field.
 */
export const PENDING_ANNOUNCEMENT_STATES = ["queued", "sending"] as const;

/**
 * How many queued events one tick will look at.
 *
 * A cap rather than a full scan, for the reason the worksheet job gives: a
 * runaway read is the one way a job eats a tick that other jobs are waiting
 * behind. Twenty is far above the real shape of this queue, which is normally
 * zero or one: an announcement is only queued by a publish, publishes are a
 * handful a term, and each one leaves the queue within a tick or two.
 *
 * WHAT THE CAP COSTS: the scan is not paged, so a twenty-first queued event is
 * invisible until one of the twenty leaves. Since events leave the queue by
 * being finished, and the run reports `hasMore` while any of them still owes
 * work, that is a delay of one tick rather than a permanent hole.
 */
export const EVENT_SCAN_CAP = 20;

/**
 * The job path's ceiling on the DEVICE scan, and why it is ten times the
 * request path's `MAX_PUSH_ROWS`.
 *
 * The 500 in `rowAudience.ts` is sized against a 60s REQUEST: it is the number
 * of owners one bounded dispatch loop can notify before Cloud Run kills the
 * container. This job has no such loop. Its unit is one owner under one
 * marker, it checks the budget between units, and it resumes on the next tick,
 * so the number of owners it can notify is unbounded in exactly the way the
 * number of emails it can send is.
 *
 * What is still bounded is the READ, which is not paged: one `.get()` over
 * `pushSubscriptions`, re-run on each tick that works on this event. 5000
 * device rows is a comfortable single read and far above any shape this
 * society plans; over it the push leg refuses whole rather than notifying an
 * arbitrary prefix. Paging that scan is the fix if it is ever approached, and
 * it would need a stable order to page on, which the collection has no index
 * for today.
 */
export const MAX_QUEUED_PUSH_ROWS = 5000;

/** The skip reason on a recipient whose only address the platform may not use. */
export const SUPPRESSED_REASON = "suppressed";

/** The skip reason on an account whose events push cell is off. */
export const PUSH_CELL_OFF_REASON = "push-cell-off";

/** The skip reason on an account whose cell is on but whose devices are gone. */
export const NO_DEVICE_REASON = "no-device";

/**
 * The skip reason when the suppression list itself could not be read. Failing
 * open would mail an address a mailbox has already bounced or complained
 * about, which is a deliverability problem that outlives this send.
 */
export const SUPPRESSION_UNREADABLE_REASON = "suppression-unreadable";

export type EventAnnouncementsRunSummary = {
  /** Recipients this run actually put a message or a notification out to. */
  sent: number;
  /** Recipients seen, claimed, and consciously not reached. */
  skipped: number;
  /** Accounts handed a notification. Counted inside `sent` as well. */
  pushed: number;
  /** Events this run moved to `done`. */
  finished: number;
  /** Events refused: an unreadable audience, or a start time already past. */
  refused: number;
  /**
   * What went wrong, per unit of work. Nothing in the per-recipient path is
   * allowed to throw out of the handler. `who` is a uid or an audience key
   * when there is a recipient behind the failure, and `event:{id}` when there
   * is not.
   */
  failures: Array<{ who: string; error: string }>;
};

function emptySummary(): EventAnnouncementsRunSummary {
  return { sent: 0, skipped: 0, pushed: 0, finished: 0, refused: 0, failures: [] };
}

export type EventAnnouncementsRun = {
  result: JobResult;
  summary: EventAnnouncementsRunSummary;
};

/** The running totals as the document holds them before anything has run. */
function emptyTotals(): EventAnnouncementResultDoc {
  return {
    sent: 0,
    skipped: 0,
    suppressed: 0,
    failed: 0,
    pushed: 0,
    refusal: null,
    pushRefusal: null,
    finishedAt: null,
  };
}

/**
 * The events with an announcement still owing.
 *
 * Sorted in code, oldest queued first, so a backlog goes out in the order it
 * was published rather than in whatever order Firestore returns. An event with
 * no `announcementQueuedAt` sorts last rather than being dropped: it should
 * not exist, and being served late is a better answer than never.
 */
async function pendingAnnouncements(
  db: Firestore,
  ctx: JobContext,
): Promise<EventDoc[]> {
  const snap = await db
    .collection("events")
    .where("announcementState", "in", [...PENDING_ANNOUNCEMENT_STATES])
    .limit(EVENT_SCAN_CAP)
    .get();
  const events = snap.docs.map((doc) => normalizeEvent(doc.id, doc.data()));
  ctx.log("queued announcements found", { count: events.length });
  return events.sort((a, b) => {
    const left = a.announcementQueuedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const right = b.announcementQueuedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    return left - right;
  });
}

/** Everything the announcement's copy needs, rebuilt from the stored event. */
function announcementInputFor(event: EventDoc): EventAnnouncementInput {
  // The PUBLIC location: this list is not the attendee list, so a hidden
  // location shows its placeholder here and the exact room stays behind an
  // approved RSVP. Same rule the publish route applies inline.
  const locationLine = event.locationHidden
    ? (event.locationPublicText ?? "Location shared with attendees")
    : event.location || "Location to be confirmed";
  return {
    eventId: event.id,
    title: event.title || "NAISI event",
    whenLine: formatEventWhen(event.startAt, event.endAt),
    locationLine,
    eventUrl: `${baseUrl()}/events/${event.id}`,
    coverImageUrl: event.posterUrl ?? null,
    membersOnly: event.visibility === "members",
    // The announcement was claimed by whoever published, and the receipt says
    // so. The job is the hand that sends it, not the actor behind it.
    actorUid: event.authorUid,
  };
}

/**
 * Is this queued announcement past the point of being worth sending?
 *
 * See the header. The bound is the EVENT's own start, not the age of the
 * queue entry; `maxLateHours` is only the fallback for an event with no start
 * time at all.
 */
export function announcementIsStale(
  event: EventDoc,
  now: Date,
  maxLateHours: number,
): string | null {
  if (event.startAt !== null) {
    if (event.startAt.getTime() <= now.getTime()) {
      return "The event had already started by the time the announcement was sent, so it was not sent.";
    }
    return null;
  }
  const queuedAt = event.announcementQueuedAt;
  if (queuedAt === null || queuedAt === undefined) return null;
  const lateMs = now.getTime() - queuedAt.getTime();
  if (lateMs > maxLateHours * 3_600_000) {
    return (
      "This event carries no start time, and the announcement sat in the queue " +
      `longer than ${maxLateHours} hours, so it was not sent.`
    );
  }
  return null;
}

/**
 * The handler's body, exported so the unit suite can run it against a fake
 * Firestore without going through the registry.
 */
export async function runEventAnnouncements(
  ctx: JobContext,
): Promise<EventAnnouncementsRun> {
  const summary = emptySummary();
  const db = getAdminDb();
  if (!db) {
    return {
      result: { processed: 0, hasMore: false, note: "admin sdk unavailable" },
      summary,
    };
  }

  let events: EventDoc[];
  try {
    events = await pendingAnnouncements(db, ctx);
  } catch (err) {
    // Nothing has been claimed, so nothing is lost but latency.
    const error = errorText(err, 200);
    summary.failures.push({ who: "event:scan", error });
    ctx.log("could not read the queued announcements", { error });
    return {
      result: { processed: 0, hasMore: true, note: `scan failed: ${error}` },
      summary,
    };
  }

  let hasMore = false;
  for (const event of events) {
    if (ctx.budget.expired() || summary.sent + summary.skipped >= ctx.maxPerTick) {
      // Out of time or out of units before this event was started. It is still
      // in the queue, so say so and let the re-arm come back to it.
      hasMore = true;
      break;
    }
    try {
      const outcome = await announceOneEvent(db, ctx, event, summary);
      if (outcome.hasMore) hasMore = true;
    } catch (err) {
      // One event's bad luck is not every other event's. Nothing above the
      // per-recipient loop writes anything a retry cannot repeat, so the event
      // stays in the queue and the next tick tries again.
      const error = errorText(err, 200);
      summary.failures.push({ who: `event:${event.id}`, error });
      ctx.log("an announcement run did not finish", { eventId: event.id, error });
      hasMore = true;
    }
  }

  const note =
    `sent ${summary.sent}, skipped ${summary.skipped}, pushed ${summary.pushed}, ` +
    `finished ${summary.finished}, refused ${summary.refused}` +
    (summary.failures.length > 0 ? `, failed ${summary.failures.length}` : "");
  return {
    result: {
      // What this job DID, in recipients settled. An event finished or refused
      // is not itself a unit of work: it is the verdict on the units under it.
      processed: summary.sent + summary.skipped,
      hasMore,
      note,
    },
    summary,
  };
}

/**
 * One event's announcement, as far as this tick's budget allows.
 *
 * NOTHING IN HERE THROWS for a per-recipient failure. An audience read that
 * rejects does propagate to the caller, which records it against the event and
 * leaves it in the queue.
 */
async function announceOneEvent(
  db: Firestore,
  ctx: JobContext,
  event: EventDoc,
  summary: EventAnnouncementsRunSummary,
): Promise<{ hasMore: boolean }> {
  const ref = db.collection("events").doc(event.id);
  const totals = event.announcementResult ?? emptyTotals();

  // THE STALE RULE, BEFORE ANY AUDIENCE IS READ. An announcement nobody should
  // receive costs no reads at all, and the verdict is terminal, so this is
  // decided once rather than re-derived on every tick for ever.
  const stale = announcementIsStale(event, ctx.now, ctx.maxLateHours);
  if (stale !== null) {
    // NOTHING IS RELEASED. There is no later moment at which this becomes
    // worth sending, so handing `announcedAt` back would only invite a
    // republish to queue the same refusal again.
    await ref.update({
      announcementState: "refused",
      announcementResult: { ...totals, refusal: stale, finishedAt: ctx.now },
      updatedAt: FieldValue.serverTimestamp(),
    });
    summary.refused += 1;
    ctx.log("a queued announcement was refused as stale", {
      eventId: event.id,
      startAt: event.startAt?.toISOString() ?? null,
    });
    return { hasMore: false };
  }

  // FIRST TOUCH: the state moves to `sending` so the editor can say the
  // announcement is under way. Not a lock (see the header): two ticks that
  // both write it write the same thing, and the markers below are what stop
  // them sending twice.
  if (event.announcementState !== "sending") {
    await ref.update({
      announcementState: "sending",
      announcementStartedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  const input = announcementInputFor(event);

  // BOTH AUDIENCES, RESOLVED BEFORE ANYTHING IS CLAIMED. They are two answers
  // to two questions and they refuse independently: an events list too large
  // to read says nothing about whether the phones can be notified.
  const audience = await resolveAnnouncementAudience(db, input, {
    maxRows: MAX_QUEUED_ANNOUNCEMENT_ROWS,
  });
  const owners = await rowPushOwners(
    db,
    { tag: LOG_TAG, reference: event.id },
    { maxRows: MAX_QUEUED_PUSH_ROWS },
  );

  totals.skipped += audience.skipped;
  totals.refusal = audience.refusal;
  totals.pushRefusal = owners.refusal;

  // A PURE REFUSAL, JUDGED ON THE ACCUMULATED TOTALS. Both legs refused and
  // nothing has ever gone out of this event, on this tick or any earlier one,
  // so the claim bought nothing and is handed back: raising the ceiling and
  // publishing again re-queues the whole announcement. A partly delivered
  // announcement keeps its claim, because releasing it would re-mail the
  // people who already have it.
  const nothingWentOut =
    audience.refusal !== null &&
    owners.refusal !== null &&
    totals.sent === 0 &&
    totals.failed === 0 &&
    totals.pushed === 0;
  if (nothingWentOut) {
    await ref.update({
      announcementState: "refused",
      announcementResult: { ...totals, finishedAt: ctx.now },
      announcedAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    summary.refused += 1;
    ctx.log("a queued announcement was refused whole and its claim released", {
      eventId: event.id,
      refusal: audience.refusal,
      pushRefusal: owners.refusal,
    });
    return { hasMore: false };
  }

  let stopped = false;
  for (const recipient of audience.recipients) {
    if (ctx.budget.expired() || summary.sent + summary.skipped >= ctx.maxPerTick) {
      stopped = true;
      break;
    }
    await announceToRecipient(db, ctx, { input, recipient, totals, summary });
  }

  if (!stopped) {
    for (const uid of owners.uids) {
      if (ctx.budget.expired() || summary.sent + summary.skipped >= ctx.maxPerTick) {
        stopped = true;
        break;
      }
      await notifyOwner(db, ctx, { input, uid, totals, summary });
    }
  }

  // THE TOTALS ARE PERSISTED WHETHER OR NOT THE RUN FINISHED, so a result is
  // never lost to a tick boundary: an event that took four ticks reports what
  // all four of them did.
  if (stopped) {
    await ref.update({
      announcementResult: { ...totals },
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { hasMore: true };
  }

  await ref.update({
    announcementState: "done",
    announcementResult: { ...totals, finishedAt: ctx.now },
    updatedAt: FieldValue.serverTimestamp(),
  });
  summary.finished += 1;
  ctx.log("a queued announcement finished", {
    eventId: event.id,
    sent: totals.sent,
    pushed: totals.pushed,
    failed: totals.failed,
  });
  return { hasMore: false };
}

/** Claim, decide, send, stamp: one recipient's email. */
async function announceToRecipient(
  db: Firestore,
  ctx: JobContext,
  args: {
    input: EventAnnouncementInput;
    recipient: AnnouncementRecipient;
    totals: EventAnnouncementResultDoc;
    summary: EventAnnouncementsRunSummary;
  },
): Promise<void> {
  const { input, recipient, totals, summary } = args;
  const who = recipient.uid || announcementRecipientKey(recipient);

  try {
    const marker = eventAnnouncementMarker(
      input.eventId,
      "email",
      announcementRecipientKey(recipient),
    );
    const claimed = await claim(db, marker, {
      job: EVENT_ANNOUNCEMENTS_JOB_ID,
      policy: ctx.policy,
    });
    // Not ours: already sent on an earlier tick, already settled, in flight on
    // an overlapping tick, or out of attempts. This is the ordinary case on
    // every tick after the first, and it is exactly what makes the job
    // resumable with no cursor of its own.
    if (!claimed.claimed) return;

    // PER RECIPIENT, not per list: the unit of work is this person, and a
    // list-wide suppression read would be work thrown away the moment the
    // budget ran out.
    let suppressedSet: Set<string>;
    try {
      const { suppressed } = await filterSuppressed(db, recipient.addresses);
      suppressedSet = new Set(suppressed.map((a) => a.toLowerCase()));
    } catch {
      // A read that fails is a reason not to send and a reason to say so on
      // the marker, never a reason to mail a suppressed address.
      await stampSkipped(db, marker.id, SUPPRESSION_UNREADABLE_REASON, ctx.now);
      totals.skipped += 1;
      summary.skipped += 1;
      return;
    }

    const counts = await sendAnnouncementToRecipient(input, recipient, suppressedSet);
    totals.sent += counts.sent;
    totals.suppressed += counts.suppressed;
    totals.failed += counts.failed;

    if (counts.sent === 0 && counts.failed === 0) {
      // Every address suppressed. Seen, claimed, and consciously not sent: the
      // marker is the record that this person was CONSIDERED, and leaving it
      // unstamped would mean re-deciding the same thing on every tick.
      await stampSkipped(db, marker.id, SUPPRESSED_REASON, ctx.now);
      summary.skipped += 1;
      return;
    }
    if (counts.sent === 0) {
      // Every address failed. `stampError` leaves `sentAt` null, so the marker
      // stays reclaimable and a later tick tries this person again, which is
      // the whole recovery rule.
      const error = "the announcement did not go out";
      summary.failures.push({ who, error });
      await stampError(db, marker.id, error);
      ctx.log("an announcement email did not go out", { eventId: input.eventId, who });
      return;
    }

    // Counted BEFORE the stamp, because the message is on the wire either way
    // and a receipt that under-reports sends is a receipt that lies.
    summary.sent += 1;
    await stampSent(db, marker.id);
  } catch (err) {
    // The claim, the send or a stamp threw. One person's bad luck is not
    // everybody else's.
    const error = errorText(err, 200);
    summary.failures.push({ who, error });
    ctx.log("an announcement email did not go out", {
      eventId: input.eventId,
      who,
      error,
    });
  }
}

/** Claim, decide, push, stamp: one account's notification. */
async function notifyOwner(
  db: Firestore,
  ctx: JobContext,
  args: {
    input: EventAnnouncementInput;
    uid: string;
    totals: EventAnnouncementResultDoc;
    summary: EventAnnouncementsRunSummary;
  },
): Promise<void> {
  const { input, uid, totals, summary } = args;

  try {
    const marker = eventAnnouncementMarker(input.eventId, "push", `u${uid}`);
    const claimed = await claim(db, marker, {
      job: EVENT_ANNOUNCEMENTS_JOB_ID,
      policy: ctx.policy,
    });
    if (!claimed.claimed) return;

    // THE ROW'S PUSH CELL, read per account. It is opt-in on this row (an
    // absent cell resolves OFF, and so does a missing user document), so a
    // scan of every device reaches only the accounts that answered yes.
    if (!(await wantsPushFor(uid, "events"))) {
      await stampSkipped(db, marker.id, PUSH_CELL_OFF_REASON, ctx.now);
      totals.skipped += 1;
      summary.skipped += 1;
      return;
    }

    const counts = await sendPushToUid(uid, {
      title: "New NAISI event",
      body: input.title,
      url: `/events/${encodeURIComponent(input.eventId)}`,
    });
    if (counts.sent === 0) {
      // NOTIFICATIONS, NOT CALLS: an account whose cell is on but whose only
      // device has since been pruned is not somebody who was told.
      await stampSkipped(db, marker.id, NO_DEVICE_REASON, ctx.now);
      totals.skipped += 1;
      summary.skipped += 1;
      return;
    }

    totals.pushed += 1;
    summary.pushed += 1;
    summary.sent += 1;
    await stampSent(db, marker.id);
  } catch (err) {
    const error = errorText(err, 200);
    summary.failures.push({ who: uid, error });
    ctx.log("an announcement notification did not go out", {
      eventId: input.eventId,
      uid,
      error,
    });
  }
}

export const eventAnnouncementsJob: JobRegistration = {
  id: "event-announcements",
  label: "Queued event announcements",
  description:
    "Sends the new-event announcement to the events row on both columns, off the publish request. Only switch it on where the scheduler tick is actually armed: with it on, publishing queues the announcement instead of sending it, so on a backend nobody calls the tick on, nothing would ever go out.",
  /**
   * Recipients per tick, not messages: a member with two verified addresses is
   * one unit and two sends. Sized to sit comfortably inside the tick's 28s job
   * budget alongside the other jobs rather than against a hard limit, since
   * the budget is what actually stops the run and `hasMore` re-arms it. The
   * downstream service is the same Resend transport the request path paces at
   * 200 messages, and 200 recipients over a resumable run is the same
   * neighbourhood without the 60s wall behind it.
   */
  maxPerTick: 200,
  /**
   * NOT the ordinary staleness bound, and the header says why: a queued
   * announcement stays worth sending until the event itself has started, so
   * the bound is `startAt`. This number is the fallback for an event with no
   * start time at all, which nothing else could ever rule on. Three days is
   * long enough that a scheduler outage does not eat a real announcement and
   * short enough that a malformed document does not sit in the queue for a
   * term.
   */
  maxLateHours: 72,
  /**
   * Longer than the worksheet reminder's ten minutes because one unit here can
   * be several messages: a member with two verified addresses takes two sends
   * inside one claim, and the floor exists so a slow-but-healthy send never
   * has a second tick racing it.
   */
  reclaimAfterMinutes: 15,
  /**
   * SHIPS DARK, and twice over. It emails and pushes to a whole list, which on
   * its own is the rule every mailing job here follows; and switching it on
   * also changes what PUBLISHING does, because the publish route reads this
   * switch to decide between the inline path and the queue. On a backend with
   * no armed scheduler tick, that would queue announcements nobody delivers.
   */
  enabledByDefault: false,
  async handler(ctx: JobContext): Promise<JobResult> {
    const { result } = await runEventAnnouncements(ctx);
    return result;
  },
};
