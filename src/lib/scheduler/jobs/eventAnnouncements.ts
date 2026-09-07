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
 * both pick up the same queued event and both walk its audience, where an
 * event-level claim would need its own expiry rule and its own way of going
 * wrong. `announcementState: "sending"` is a progress note, not a lock, and
 * three separate things make the overlap safe rather than one:
 *
 *  - SENDS are exactly-once, through the per-recipient markers: the second
 *    tick's `.create()` on a claimed marker fails with ALREADY_EXISTS.
 *  - COUNTS are increments. Every tick writes its own deltas with
 *    `FieldValue.increment` and never the accumulated totals, so a tick that
 *    read the totals before another tick committed cannot write its work away.
 *  - The STATE TRANSITIONS are transactional. `done` and `refused`, and the
 *    release of `announcedAt` with them, are decided inside a transaction that
 *    re-reads the document and writes only while the announcement is still
 *    pending, so a tick cannot finish an event another tick is still working
 *    on and two ticks cannot both release one claim.
 *
 * ## AN UNSETTLED UNIT KEEPS THE EVENT IN THE QUEUE
 *
 * The scan finds `queued` and `sending` and nothing else, so an event written
 * `done` is an event no later tick will ever look at again. A send that
 * failed, a claim another tick is holding in flight, or anything that threw
 * therefore leaves the event `"sending"` and reports `hasMore`, and the
 * ordinary marker rules take it from there: the re-claim window lets a later
 * tick pick the unit up, and `maxAttempts` ends it. A marker the claim helper
 * gives up on is SETTLED (stamped `failedAt`, counted as a failure), which is
 * what lets an event whose worst recipient cannot be reached still finish
 * rather than re-arming for ever.
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
 * BOTH READS ARE MADE AGAIN ON EVERY TICK that touches an event, which is the
 * price of holding no cursor and is paid deliberately: a stored copy of the
 * list would go stale the moment somebody unsubscribed, and the markers make
 * a re-read cost reads rather than duplicate sends. Two things keep the price
 * honest, and both are the budget rather than a cache. The wall clock is
 * checked immediately after each read, so a tick that has nothing left does
 * not walk into a loop it cannot run; and the device scan is not made at all
 * until the email leg has finished everything it is going to do this tick, so
 * a tick spent on email does not also pay for a 5000-row read it will not
 * use. PAGING THE JUNCTION READ is the fix if a list ever nears its ceiling.
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
 * The rule is the publish route's, word for word: the email audience refused
 * AND nothing was sent, failed or pushed. Not "both legs refused": the push
 * leg answers null when it is dormant or nobody has opted in, and requiring a
 * refusal from it too left an unreadable events list finishing `done` with the
 * claim spent and no supported way to get the announcement out.
 *
 * It is judged on the totals AS STORED, inside the settling transaction, so an
 * event that mailed forty people on Monday and met a refusal on Tuesday keeps
 * its claim, and a stale count cannot release one another tick has spent. An
 * email audience that refused does NOT stop the push leg, because the inline
 * path runs both legs regardless and this path answers the same two questions.
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
  type EventAnnouncementState,
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
  stampSentOrSettle,
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
  /**
   * Recipients seen, CLAIMED, and consciously not reached. Never the
   * audience-level drops (a members-only guest row, an account that is gone):
   * those are re-derived on every tick, so counting them here would count them
   * again on every tick. They are a snapshot in `announcementResult`.
   */
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
    audienceSkipped: 0,
    suppressed: 0,
    failed: 0,
    pushed: 0,
    refusal: null,
    pushRefusal: null,
    released: false,
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
 * The instant an announcement with NO START TIME is aged against.
 *
 * `announcementQueuedAt` is what the publish route writes, so it is the right
 * answer whenever there is one. `announcedAt` is the fallback for a document
 * somebody has edited by hand, which is the only way the first can be missing
 * while the second is not. Null when neither is there, and the caller logs
 * that rather than letting the entry sit in the queue unbounded and unnoticed.
 */
export function announcementStaleAnchor(event: EventDoc): Date | null {
  return event.announcementQueuedAt ?? event.announcedAt ?? null;
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
  const anchor = announcementStaleAnchor(event);
  // NOT stale, and the caller says so in the log. A document carrying no start
  // time, no queued-at and no claim stamp has nothing to age against, so
  // refusing it would be a verdict with no evidence and announcing it silently
  // would be an unbounded queue entry nobody could see.
  if (anchor === null) return null;
  const lateMs = now.getTime() - anchor.getTime();
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
  // Units this TICK has spent, across every event it touches. Kept here rather
  // than per event because `maxPerTick` is a bound on what one tick hands the
  // downstream services, and three queued events each spending it would be
  // three times the load the number describes.
  let spent = 0;
  for (const event of events) {
    if (ctx.budget.expired() || spent >= ctx.maxPerTick) {
      // Out of time or out of units before this event was started. It is still
      // in the queue, so say so and let the re-arm come back to it.
      hasMore = true;
      break;
    }
    try {
      const outcome = await announceOneEvent(db, ctx, event, summary, ctx.maxPerTick - spent);
      spent += outcome.units;
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
 * The DELTAS one tick made to one event, which is what gets written back.
 *
 * Never the accumulated totals. Two ticks overlap by design (the tick route's
 * re-arm makes it ordinary), so a tick that read the totals, added its own
 * work and wrote the sum back would silently discard whatever the other tick
 * had committed in between. Every numeric field goes back as
 * `FieldValue.increment`, and the only absolutes are the ones that are a
 * SNAPSHOT rather than a running total: the refusal strings and the
 * audience-level skip count.
 */
type TickDeltas = {
  sent: number;
  skipped: number;
  suppressed: number;
  failed: number;
  pushed: number;
};

function emptyDeltas(): TickDeltas {
  return { sent: 0, skipped: 0, suppressed: 0, failed: 0, pushed: 0 };
}

/** What one unit of work leaves behind for the loop above it. */
type UnitOutcome = {
  /**
   * This unit is NOT settled and a later tick must come back to it: a send
   * that failed, a claim held in flight by an overlapping tick, or anything
   * that threw. The event stays `"sending"` while any of them is true, which
   * is the whole of the retry story: the scan only ever finds `queued` and
   * `sending`, so an event written `done` with an unstamped marker under it is
   * an announcement that silently never reaches that person.
   */
  retryable: boolean;
  /**
   * Whether this unit consumed one of the tick's `maxPerTick` units. A claim
   * that came back already settled is not work and does not count.
   */
  worked: boolean;
};

const SETTLED: UnitOutcome = { retryable: false, worked: false };
const RETRY: UnitOutcome = { retryable: true, worked: false };
const DID_WORK: UnitOutcome = { retryable: false, worked: true };

/**
 * The claim came back refused. Is that unit finished, or does somebody have to
 * come back to it?
 *
 * `sent`, `skipped` and `failed` are terminal states of the marker, so the
 * unit is done and nothing here owes it anything. `in-flight` and `raced` are
 * NOT: the tick holding that claim may have died between claiming and
 * stamping, and the only thing that will ever notice is a later tick finding
 * the marker past its re-claim window. So the event has to stay in the queue
 * for that to happen.
 */
function outcomeOfRefusedClaim(reason: string): UnitOutcome {
  return reason === "in-flight" || reason === "raced" ? RETRY : SETTLED;
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
  /** What is left of this TICK's unit budget, not this event's. */
  maxUnits: number,
): Promise<{ hasMore: boolean; units: number }> {
  const ref = db.collection("events").doc(event.id);
  const deltas = emptyDeltas();
  /** Set by any unit that a later tick has to come back to. See {@link UnitOutcome}. */
  let retryable = false;
  /** Units spent here, counted against what the TICK had left (`maxUnits`). */
  let units = 0;

  // THE STALE RULE, BEFORE ANY AUDIENCE IS READ. An announcement nobody should
  // receive costs no reads at all, and the verdict is terminal, so this is
  // decided once rather than re-derived on every tick for ever.
  const stale = announcementIsStale(event, ctx.now, ctx.maxLateHours);
  if (stale !== null) {
    // NOTHING IS RELEASED. There is no later moment at which this becomes
    // worth sending, so handing `announcedAt` back would only invite a
    // republish to queue the same refusal again. `released: false` is what the
    // editor reads to tell an approver that republishing will not help.
    await settleAnnouncement(db, ctx, event.id, {
      state: "refused",
      refusal: stale,
      release: false,
    });
    summary.refused += 1;
    ctx.log("a queued announcement was refused as stale", {
      eventId: event.id,
      startAt: event.startAt?.toISOString() ?? null,
    });
    return { hasMore: false, units };
  }
  if (event.startAt === null && announcementStaleAnchor(event) === null) {
    // No start time, no queued-at and no claim stamp: nothing on this document
    // can age, so the fallback bound has nothing to measure from and the entry
    // would sit in the queue for ever. It is still announced, because a
    // hand-edited document is not a reason to withhold somebody's mail, but it
    // is said out loud rather than becoming a silent unbounded entry.
    ctx.log("a queued announcement has no instant to age against", {
      eventId: event.id,
    });
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

  // THE EMAIL AUDIENCE. Re-read on every tick that touches this event: up to
  // MAX_QUEUED_ANNOUNCEMENT_ROWS junction rows plus one `getAll` over the user
  // documents behind them. That is the cost of holding no cursor, and it is
  // paid deliberately, because the alternative is a stored copy of the list
  // that goes stale the moment somebody unsubscribes. PAGING THE JUNCTION READ
  // is the fix if a list ever nears the ceiling; a cache is not, for that same
  // reason.
  const audience = await resolveAnnouncementAudience(db, input, {
    maxRows: MAX_QUEUED_ANNOUNCEMENT_ROWS,
  });
  if (ctx.budget.expired()) {
    // The read alone spent what was left. Nothing has been claimed, so the
    // next tick starts this event again from the top.
    await writeProgress(db, event.id, deltas, {
      refusal: audience.refusal,
      audienceSkipped: audience.skipped,
    });
    return { hasMore: true, units };
  }

  let stopped = false;
  for (const recipient of audience.recipients) {
    if (ctx.budget.expired() || units >= maxUnits) {
      stopped = true;
      break;
    }
    const outcome = await announceToRecipient(db, ctx, {
      input,
      recipient,
      deltas,
      summary,
    });
    if (outcome.retryable) retryable = true;
    if (outcome.worked) units += 1;
  }

  if (stopped) {
    await writeProgress(db, event.id, deltas, {
      refusal: audience.refusal,
      audienceSkipped: audience.skipped,
    });
    return { hasMore: true, units };
  }

  // THE PUSH AUDIENCE, RESOLVED ONLY NOW. A device scan this tick has no
  // budget left to use is a 5000-row read thrown away, so it is not made until
  // the email leg has finished everything it is going to do this tick. An
  // email audience that REFUSED still reaches here, and must: the two legs are
  // two answers to two questions, and the inline path runs both regardless.
  const owners = await rowPushOwners(
    db,
    { tag: LOG_TAG, reference: event.id },
    { maxRows: MAX_QUEUED_PUSH_ROWS },
  );
  const resolutions = {
    refusal: audience.refusal,
    pushRefusal: owners.refusal,
    audienceSkipped: audience.skipped,
  };
  if (ctx.budget.expired()) {
    await writeProgress(db, event.id, deltas, resolutions);
    return { hasMore: true, units };
  }

  for (const uid of owners.uids) {
    if (ctx.budget.expired() || units >= maxUnits) {
      stopped = true;
      break;
    }
    const outcome = await notifyOwner(db, ctx, { input, uid, deltas, summary });
    if (outcome.retryable) retryable = true;
    if (outcome.worked) units += 1;
  }

  // THE DELTAS GO BACK WHETHER OR NOT THE RUN FINISHED, so a result is never
  // lost to a tick boundary: an event that took four ticks reports what all
  // four of them did.
  await writeProgress(db, event.id, deltas, resolutions);

  if (stopped || retryable) {
    // Still owed: either this tick ran out, or some unit under it is unsettled
    // and a later tick has to come back to it. Either way the event stays
    // `"sending"` and `hasMore` re-arms the tick. The cost of the retryable
    // case is one extra pass over the audience per re-arm, bounded by
    // MAX_TICK_DEPTH; the alternative is an event written `done` over an
    // unstamped marker, which is a person who is never told.
    return { hasMore: true, units };
  }

  // EVERY UNIT SETTLED. The state and the release decision go together, in one
  // transaction that re-reads the document, so an overlapping tick cannot
  // write `done` over work another tick is still doing and two ticks finishing
  // together cannot both release the claim.
  const finished = await settleAnnouncement(db, ctx, event.id, { state: "done" });
  if (finished.written && finished.state === "refused") {
    summary.refused += 1;
    ctx.log("a queued announcement reached nobody and its claim was released", {
      eventId: event.id,
      refusal: finished.refusal,
    });
    return { hasMore: false, units };
  }
  if (finished.written) {
    summary.finished += 1;
    ctx.log("a queued announcement finished", {
      eventId: event.id,
      sent: finished.sent,
      pushed: finished.pushed,
      failed: finished.failed,
    });
  }
  return { hasMore: false, units };
}

/**
 * This tick's contribution to the event's result, and nothing else.
 *
 * Numbers by `FieldValue.increment`, on dotted field paths so the map is
 * merged rather than replaced; the refusal strings and `audienceSkipped` are
 * snapshots of the LATEST resolution and are written absolutely. That split is
 * the whole of should-fix 6: `skipped` counts recipients this job actually
 * claimed and consciously did not reach, and would be counted again on every
 * re-resolution if the audience-level drops were folded into it.
 */
async function writeProgress(
  db: Firestore,
  eventId: string,
  deltas: TickDeltas,
  resolutions: {
    refusal: string | null;
    pushRefusal?: string | null;
    audienceSkipped: number;
  },
): Promise<void> {
  const patch: Record<string, unknown> = {
    "announcementResult.sent": FieldValue.increment(deltas.sent),
    "announcementResult.skipped": FieldValue.increment(deltas.skipped),
    "announcementResult.suppressed": FieldValue.increment(deltas.suppressed),
    "announcementResult.failed": FieldValue.increment(deltas.failed),
    "announcementResult.pushed": FieldValue.increment(deltas.pushed),
    "announcementResult.audienceSkipped": resolutions.audienceSkipped,
    "announcementResult.refusal": resolutions.refusal,
    updatedAt: FieldValue.serverTimestamp(),
  };
  // Only when the push audience was actually resolved. A tick that ran out
  // before the device scan knows nothing about the push leg, and writing null
  // there would erase a refusal an earlier tick had recorded.
  if (resolutions.pushRefusal !== undefined) {
    patch["announcementResult.pushRefusal"] = resolutions.pushRefusal;
  }
  await db.collection("events").doc(eventId).update(patch);
}

export type AnnouncementSettlement = {
  /** False when another tick had already finished this event. */
  written: boolean;
  state: EventAnnouncementState;
  refusal: string | null;
  sent: number;
  pushed: number;
  failed: number;
};

/**
 * THE ONE PLACE A QUEUED ANNOUNCEMENT LEAVES THE QUEUE, and the one place
 * `announcedAt` is handed back.
 *
 * In a transaction, for two reasons that are really one: ticks overlap. It
 * re-reads the document and writes nothing unless the announcement is still
 * pending, so a tick cannot write `done` over an announcement another tick has
 * already finished; and it decides the release from the totals AS STORED
 * rather than from a read taken before this tick's own increments, so a stale
 * count cannot release a claim that another tick has already spent on a real
 * send.
 *
 * THE RELEASE RULE IS THE INLINE PATH'S, EXACTLY. `/api/events/[id]/publish`
 * releases when the announcement refused and nothing was sent, failed or
 * pushed. Here the same test is applied to the accumulated totals, so an event
 * that mailed forty people on Monday and met a refusal on Tuesday keeps its
 * claim: releasing it would re-mail those forty. A caller passing `release:
 * false` (the stale verdict) overrides it, because a past event does not
 * become announceable by being republished.
 */
async function settleAnnouncement(
  db: Firestore,
  ctx: JobContext,
  eventId: string,
  args: { state: "done" | "refused"; refusal?: string; release?: boolean },
): Promise<AnnouncementSettlement> {
  const ref = db.collection("events").doc(eventId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = normalizeEvent(eventId, (snap.data() ?? {}) as Record<string, unknown>);
    const stored = current.announcementResult ?? emptyTotals();
    const idle: AnnouncementSettlement = {
      written: false,
      state: current.announcementState ?? "done",
      refusal: stored.refusal,
      sent: stored.sent,
      pushed: stored.pushed,
      failed: stored.failed,
    };
    if (
      current.announcementState !== "queued" &&
      current.announcementState !== "sending"
    ) {
      // Another tick got there first, or a person cleared the queue state by
      // hand. Either way this is not ours to finish.
      return idle;
    }

    const refusal = args.refusal ?? stored.refusal;
    // Nothing reached anybody, and the email audience said why: the claim
    // bought nothing. `args.release === false` is the stale verdict overriding
    // that, and is the only caller that does.
    const releasable =
      refusal !== null && stored.sent === 0 && stored.failed === 0 && stored.pushed === 0;
    const release = args.release === false ? false : releasable;
    const state: EventAnnouncementState =
      args.state === "refused" || releasable ? "refused" : "done";

    tx.update(ref, {
      announcementState: state,
      "announcementResult.refusal": refusal,
      "announcementResult.released": release,
      "announcementResult.finishedAt": ctx.now,
      ...(release ? { announcedAt: FieldValue.delete() } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      written: true,
      state,
      refusal,
      sent: stored.sent,
      pushed: stored.pushed,
      failed: stored.failed,
    };
  });
}

/** Claim, decide, send, stamp: one recipient's email. */
async function announceToRecipient(
  db: Firestore,
  ctx: JobContext,
  args: {
    input: EventAnnouncementInput;
    recipient: AnnouncementRecipient;
    deltas: TickDeltas;
    summary: EventAnnouncementsRunSummary;
  },
): Promise<UnitOutcome> {
  const { input, recipient, deltas, summary } = args;
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
    if (!claimed.claimed) {
      if (claimed.reason === "gave-up") {
        // The claim helper has just stamped `failedAt` after `maxAttempts`
        // claims with no send. That is SETTLED, and it is the thing that lets
        // an event whose worst recipient cannot be reached still finish rather
        // than re-arming for ever. Counted as a failure, once, on the tick
        // that gave up; a later tick sees `failed` and counts nothing.
        deltas.failed += 1;
        summary.failures.push({ who, error: "gave up after the attempt budget" });
        ctx.log("an announcement email gave up", { eventId: input.eventId, who });
        return DID_WORK;
      }
      return outcomeOfRefusedClaim(claimed.reason);
    }

    // PER RECIPIENT, not per list: the unit of work is this person, and a
    // list-wide suppression read would be work thrown away the moment the
    // budget ran out.
    let suppressedSet: Set<string>;
    try {
      const { suppressed } = await filterSuppressed(db, recipient.addresses);
      suppressedSet = new Set(suppressed.map((a) => a.toLowerCase()));
    } catch {
      // A read that fails is a reason not to send and a reason to say so on
      // the marker, never a reason to mail a suppressed address. Terminal:
      // this person was considered, and re-deciding it every tick would cost
      // the same read and reach the same answer.
      await stampSkipped(db, marker.id, SUPPRESSION_UNREADABLE_REASON, ctx.now);
      deltas.skipped += 1;
      summary.skipped += 1;
      return DID_WORK;
    }

    const counts = await sendAnnouncementToRecipient(input, recipient, suppressedSet);
    deltas.sent += counts.sent;
    deltas.suppressed += counts.suppressed;
    deltas.failed += counts.failed;

    if (counts.sent === 0 && counts.failed === 0) {
      // Every address suppressed. Seen, claimed, and consciously not sent: the
      // marker is the record that this person was CONSIDERED, and leaving it
      // unstamped would mean re-deciding the same thing on every tick.
      await stampSkipped(db, marker.id, SUPPRESSED_REASON, ctx.now);
      deltas.skipped += 1;
      summary.skipped += 1;
      return DID_WORK;
    }
    if (counts.sent === 0) {
      // Every address failed. `stampError` leaves `sentAt` null, so the marker
      // stays reclaimable, and RETRY is what keeps the event in the queue for
      // that later tick to find: an event written `done` here would never be
      // scanned again and this person would never be told.
      const error = "the announcement did not go out";
      summary.failures.push({ who, error });
      await stampError(db, marker.id, error);
      ctx.log("an announcement email did not go out", { eventId: input.eventId, who });
      return { retryable: true, worked: true };
    }

    // Counted BEFORE the stamp, because the message is on the wire either way
    // and a receipt that under-reports sends is a receipt that lies.
    summary.sent += 1;
    // The stamp is the only thing between a delivered message and a second
    // copy of it, so it is retried and then settled terminally rather than
    // left for the re-claim rule to pick up. See `stampSentOrSettle`.
    await stampSentOrSettle(db, marker.id, ctx.now);
    return DID_WORK;
  } catch (err) {
    // The claim, the send or a stamp threw. One person's bad luck is not
    // everybody else's, and the event stays in the queue so a later tick can
    // work out what state this person's marker is really in.
    const error = errorText(err, 200);
    summary.failures.push({ who, error });
    ctx.log("an announcement email did not go out", {
      eventId: input.eventId,
      who,
      error,
    });
    return { retryable: true, worked: true };
  }
}

/** Claim, decide, push, stamp: one account's notification. */
async function notifyOwner(
  db: Firestore,
  ctx: JobContext,
  args: {
    input: EventAnnouncementInput;
    uid: string;
    deltas: TickDeltas;
    summary: EventAnnouncementsRunSummary;
  },
): Promise<UnitOutcome> {
  const { input, uid, deltas, summary } = args;

  try {
    const marker = eventAnnouncementMarker(input.eventId, "push", `u${uid}`);
    const claimed = await claim(db, marker, {
      job: EVENT_ANNOUNCEMENTS_JOB_ID,
      policy: ctx.policy,
    });
    if (!claimed.claimed) {
      if (claimed.reason === "gave-up") {
        deltas.failed += 1;
        summary.failures.push({ who: uid, error: "gave up after the attempt budget" });
        ctx.log("an announcement notification gave up", { eventId: input.eventId, uid });
        return DID_WORK;
      }
      return outcomeOfRefusedClaim(claimed.reason);
    }

    // THE ROW'S PUSH CELL, read per account. It is opt-in on this row (an
    // absent cell resolves OFF, and so does a missing user document), so a
    // scan of every device reaches only the accounts that answered yes.
    if (!(await wantsPushFor(uid, "events"))) {
      await stampSkipped(db, marker.id, PUSH_CELL_OFF_REASON, ctx.now);
      deltas.skipped += 1;
      summary.skipped += 1;
      return DID_WORK;
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
      deltas.skipped += 1;
      summary.skipped += 1;
      return DID_WORK;
    }

    deltas.pushed += 1;
    summary.pushed += 1;
    summary.sent += 1;
    await stampSentOrSettle(db, marker.id, ctx.now);
    return DID_WORK;
  } catch (err) {
    const error = errorText(err, 200);
    summary.failures.push({ who: uid, error });
    ctx.log("an announcement notification did not go out", {
      eventId: input.eventId,
      uid,
      error,
    });
    return { retryable: true, worked: true };
  }
}
export const eventAnnouncementsJob: JobRegistration = {
  id: "event-announcements",
  label: "Queued event announcements",
  description:
    "Sends the new-event announcement to the events row on both columns, off the publish request. Only switch it on where the scheduler tick is actually armed: with it on, publishing queues the announcement instead of sending it, so on a backend nobody calls the tick on, nothing would ever go out.",
  /**
   * UNITS per tick, counted separately from anything the summary reports: one
   * per email recipient settled and one per push account settled. A member who
   * is on the list AND holds a device is two units, because they are two
   * claims and two messages; a member with two verified addresses is one unit
   * and two sends, because it is one claim.
   *
   * THE BUDGET IS THE REAL BOUND. `ctx.budget` is what actually stops a run,
   * because a count is not a time bound when one Resend call can take four
   * seconds, and a run it stops resumes on the next tick with everything sent
   * already stamped. This number is a floor under the downstream load instead:
   * an upper bound on how much Resend and web-push traffic one tick can
   * generate, so a queue that has somehow grown large cannot spend a whole
   * tick chain hammering them. 200 is the figure the request path paces to,
   * without the 60s wall behind it.
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
