import "server-only";

/**
 * `worksheet-due-reminders`: the nudge to everybody who has a worksheet and
 * has not sent it back yet.
 *
 * Modelled on `admissionsReminders.ts`, which is the job in this repo that has
 * already been argued about. Read its header for the reasoning behind the
 * shape; what follows is only what is DIFFERENT here, plus the one decision
 * this job makes on its own.
 *
 * ## Nothing is scheduled, and the window is the schedule
 *
 * A circulation has one due date and no reminder offsets, so there is nothing
 * to derive: the audience is every OPEN circulation whose `dueDate` falls in
 * the next {@link DUE_SOON_WINDOW_HOURS} hours, read fresh on every tick. A
 * sender who moves the deadline moves the reminder with it, and a tick that
 * never fired costs latency rather than a send.
 *
 * The query is `status == "open"` and `dueDate` inside the window, in that
 * clause order, because that is the order of the ONE composite index this
 * feature declares (`circulations (status ASC, dueDate ASC)` in
 * `firestore.indexes.json`). Equality first, then the range field: writing the
 * chain any other way is the same query to Firestore and a different-looking
 * one to `tests/firestore-indexes.test.mjs`.
 *
 * ## The marker keys on the London civil date of the deadline
 *
 * `wsremind__{circulationId}__{uid}__{dueKey}`. Two consequences, both wanted
 * and both the same as the admissions job's:
 *
 *  1. A tick that runs every quarter of an hour for the two days before a
 *     deadline sends ONE reminder, because every tick after the first finds
 *     the marker.
 *  2. MOVING THE DEADLINE mints a new key, so people who still have not
 *     submitted are reminded about the new date rather than silenced by the
 *     old date's marker. Nudging the TIME on the same day is the same key and
 *     cannot re-send, which is the failure people notice.
 *
 * ## THERE IS NO STALE RULE HERE, AND THAT IS DELIBERATE
 *
 * Every other job in this directory has a scheduled instant it can be late
 * for (a deadline announcement, a stage release, a session that has finished),
 * so `maxLateHours` answers "how late is worse than silent". This job has no
 * such instant. The reminder is not owed AT a moment, it is owed for as long
 * as the deadline is still ahead of the person.
 *
 * An earlier version of this file mapped `maxLateHours` onto the moment the
 * window opened (`dueDate - 48h`) and dropped the whole circulation past it.
 * That arithmetic silenced precisely the reminders that matter most: a
 * deadline less than 24 hours away is, by definition, one whose window opened
 * more than 24 hours ago, so a scheduler that had never missed a tick dropped
 * every same-day worksheet, and dropped everybody added inside the last day
 * with it, while the marker said "stale" about a run that was never late.
 *
 * The only lateness question this job can honestly ask is asked in the query:
 * `dueDate >= now`. A deadline that has passed is out of the audience; a
 * deadline still ahead is worth a nudge however long the scheduler was dark,
 * because the person can still do the work. `maxLateHours` stays on the
 * registration (the type asks for a number and the panel shows one) and the
 * handler derives nothing at all from it.
 *
 * ## THIS JOB MAY PUSH
 *
 * Every other mail this platform sends from a tick is email only. The owner
 * asked for an email switch AND a push switch per circulation event, so
 * `notifications.dueSoon` carries both and this job honours them
 * INDEPENDENTLY: email off with push on is a legitimate setting and sends a
 * push. That is a deliberate divergence from `src/lib/worksheets/notify.ts`,
 * whose policy is that push mirrors email and never leads it. The difference
 * is that this job's unit of work is one person's reminder rather than a
 * broadcast, and the marker records what happened to it either way.
 *
 * What is NOT diverged: the site-wide task-email kill switch
 * (`config/taskEmails`) covers the push as well. It is read once per run,
 * before anything is claimed, and a run under a closed switch does nothing at
 * all rather than pushing what it may not mail.
 *
 * ## One bad recipient costs one recipient
 *
 * Every per-recipient step is inside a try/catch: the claim, the users read,
 * the suppression read, the send and both stamps. The order is the one that
 * cannot duplicate: claim, send, stamp. A crash in the middle leaves an
 * unstamped marker, which a later tick re-claims after
 * `reclaimAfterMinutes`; the reverse order would turn the same crash into a
 * second reminder.
 */

import { type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { londonDateKey } from "@/lib/courses/weekPlan";
import {
  sendWorksheetDueSoonEmail,
  worksheetDueSoonSubject,
  worksheetRespondPath,
  formatWorksheetDue,
  type WorksheetSendOutcome,
} from "@/lib/email/worksheetReminderEmails";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  CIRCULATIONS_COLLECTION,
  RESPONSES_SUBCOLLECTION,
  normalizeCirculation,
  type CirculationDoc,
  type ResponseState,
} from "@/lib/firestore/circulations";
import { isSuppressed } from "@/lib/firestore/suppression";
import { isTaskEmailEnabled } from "@/lib/firestore/taskEmailConfig";
import { mirrorTaskEmailToPush } from "@/lib/push/taskNotifications";
import {
  claim,
  errorText,
  stampError,
  stampSent,
  stampSkipped,
  worksheetReminderMarker,
} from "@/lib/scheduler/markers";
import type { JobContext, JobRegistration, JobResult } from "../registry";

export const WORKSHEET_DUE_REMINDERS_JOB_ID = "worksheet-due-reminders";

/**
 * How far ahead of a deadline the reminder goes out.
 *
 * Two days rather than one because a worksheet is WORK: the thing the reader
 * has to find is an evening, and an evening cannot be found the same afternoon
 * it is needed. It is also the whole schedule, so it is a constant here rather
 * than a per-circulation setting nobody asked for.
 */
export const DUE_SOON_WINDOW_HOURS = 48;

const DUE_SOON_WINDOW_MS = DUE_SOON_WINDOW_HOURS * 3_600_000;

/**
 * How many circulations one tick will look at. A cap rather than a full scan
 * because a runaway read is the one way this job eats a tick that other jobs
 * are waiting behind. A committee runs a handful of worksheets at a time;
 * twenty deadlines inside one 48-hour window is room to be wrong.
 *
 * WHAT THE CAP COSTS, said out loud: the scan is not paged, so a
 * twenty-first circulation in the same window is invisible until one of the
 * twenty leaves it, and by then its deadline may be hours rather than days
 * away. The run
 * deliberately does NOT report `hasMore` for a full page either, because the
 * next tick would run the same unpaged query, find the same twenty stamped,
 * and re-arm on them forever. Raising this number is the fix if a term ever
 * has twenty worksheets due in two days; a cursor would be the fix if it had
 * hundreds.
 */
export const CIRCULATION_SCAN_CAP = 20;

/** Responses fetched per page. Small enough to interleave budget checks. */
export const RESPONSE_PAGE_SIZE = 100;

/**
 * The two states that still owe an answer. A submitted or reviewed response is
 * out of the audience by construction rather than by a check further down, so
 * nobody who has already sent their work can be reminded to send it.
 */
export const PENDING_STATES: readonly ResponseState[] = ["not-opened", "started"];

/**
 * The skip reason on a marker whose reminder WENT OUT but whose `sentAt` stamp
 * could not be written, even on a retry. Terminal on purpose: `stampError`
 * writes only `lastError`, which leaves the marker reclaimable, and a later
 * tick would then send the same person a second reminder. An oddly-worded
 * marker is cheaper than that. See {@link stampSentOrSettle}.
 */
export const SENT_UNSTAMPED_REASON = "sent-unstamped";

/**
 * The skip reason when the suppression list itself could not be read. Failing
 * open would mail an address a mailbox has already bounced or complained
 * about, which is a deliverability problem that outlives this send.
 */
export const SUPPRESSION_UNREADABLE_REASON = "suppression-unreadable";

export type WorksheetReminderRunSummary = {
  /** Reminders actually handed to the send pipeline and stamped. */
  sent: number;
  /** Seen, claimed, and consciously not sent (suppressed, no address). */
  skipped: number;
  /**
   * Reminders that went out as a PUSH ALONE, on a circulation whose sender
   * asked for both channels, because the email leg skipped: a suppressed
   * address, no address on the account, a suppression list that would not
   * read. Counted in `sent` as well, because something did reach the person,
   * and recorded here because nothing else can say so. The marker carries one
   * `sentAt` and no channel, so without this line a mailbox the platform has
   * been told to stop mailing is indistinguishable from a delivered email.
   */
  pushOnly: Array<{ uid: string; reason: string }>;
  /**
   * What went wrong, per unit of work. Nothing in the per-recipient path is
   * allowed to throw out of the handler. `uid` is the recipient when there is
   * one behind the failure; a failure with no recipient behind it records
   * `circulation:{id}` or `config:{doc}`, neither of which can be mistaken for
   * a uid.
   */
  failures: Array<{ uid: string; error: string }>;
  /**
   * Circulations this run actually EXAMINED: open, inside the window, and with
   * at least one due-soon channel switched on. Deliberately not the number
   * loaded, which would count the ones the run skipped without reading a
   * single response.
   */
  circulations: number;
};

function emptySummary(): WorksheetReminderRunSummary {
  return { sent: 0, skipped: 0, pushOnly: [], failures: [], circulations: 0 };
}

export type WorksheetReminderRun = {
  result: JobResult;
  summary: WorksheetReminderRunSummary;
};

/**
 * The circulations whose deadline falls inside the window.
 *
 * ONE equality filter and one range field, in the order the composite index
 * declares them. No `orderBy`: Firestore orders by the range field on its own,
 * and an explicit sort on anything else would need a second index and would
 * drop every document missing the sorted field.
 *
 * That implicit ordering is also what makes the cap safe. `dueDate ASC` means
 * the twenty the run takes are the twenty SOONEST deadlines, so a tick that
 * cannot see every circulation is one that saw the most urgent ones, and the
 * rest are still inside the window on the next tick.
 */
async function dueCirculations(db: Firestore, ctx: JobContext): Promise<CirculationDoc[]> {
  const horizon = new Date(ctx.now.getTime() + DUE_SOON_WINDOW_MS);
  const snap = await db
    .collection(CIRCULATIONS_COLLECTION)
    .where("status", "==", "open")
    .where("dueDate", ">=", ctx.now)
    .where("dueDate", "<=", horizon)
    .limit(CIRCULATION_SCAN_CAP)
    .get();
  return snap.docs.map((doc) => normalizeCirculation(doc.id, doc.data()));
}

/**
 * Everything one reminder's EMAIL needs, or a reason not to send it.
 *
 * Called only when the email switch is on, so a push-only circulation costs no
 * users read and no suppression read at all.
 */
async function resolveRecipient(
  db: Firestore,
  uid: string,
): Promise<{ to: string; name: string } | { skip: string }> {
  const snap = await db.collection("users").doc(uid).get();
  const data = (snap.exists ? snap.data() : null) as Record<string, unknown> | null;
  const email = typeof data?.email === "string" ? data.email : "";
  // The name the recipient chose for themselves, then the account's, then the
  // address. The same ladder `resolveTaskUsers` walks, so a worksheet reminder
  // greets somebody the way every other task email does.
  const profile = (data?.profile ?? null) as Record<string, unknown> | null;
  const preferred = typeof profile?.preferredName === "string" ? profile.preferredName : "";
  const displayName = typeof data?.displayName === "string" ? data.displayName : "";
  const name = preferred || displayName || email.split("@")[0] || "there";
  // No fallback address to try: a worksheet recipient is a member with an
  // account, and their account is the only place an address for them exists.
  if (!email) return { skip: "no-address" };
  let suppressed: boolean;
  try {
    suppressed = await isSuppressed(db, email);
  } catch {
    // See SUPPRESSION_UNREADABLE_REASON: a read that fails is a reason not to
    // send and a reason to say so on the marker, never a reason to abort the
    // run or to mail a suppressed address.
    return { skip: SUPPRESSION_UNREADABLE_REASON };
  }
  if (suppressed) return { skip: "suppressed" };
  return { to: email, name };
}

/**
 * The handler's body, exported so the unit suite can run it against a fake
 * Firestore without going through the registry.
 */
export async function runWorksheetDueReminders(
  ctx: JobContext,
): Promise<WorksheetReminderRun> {
  const summary = emptySummary();
  const db = getAdminDb();
  if (!db) {
    return {
      result: { processed: 0, hasMore: false, note: "admin sdk unavailable" },
      summary,
    };
  }

  // THE KILL SWITCH, ONCE PER RUN AND BEFORE ANYTHING IS CLAIMED. Reading it
  // per recipient would cost one read a person to answer a site-wide
  // question, and claiming markers first would leave a run that mailed nobody
  // looking, on the next tick, like a run that already had.
  let taskEmailsOn: boolean;
  try {
    taskEmailsOn = await isTaskEmailEnabled(db);
  } catch (err) {
    // Fail CLOSED. A transient read failure costs one tick of latency; the
    // alternative is mailing a whole audience out of an environment whose
    // switch may well be off.
    const error = errorText(err, 200);
    summary.failures.push({ uid: "config:taskEmails", error });
    return {
      result: { processed: 0, hasMore: true, note: `task-email switch unreadable: ${error}` },
      summary,
    };
  }
  if (!taskEmailsOn) {
    return {
      result: { processed: 0, hasMore: false, note: "task emails are switched off" },
      summary,
    };
  }

  let circulations: CirculationDoc[];
  try {
    circulations = await dueCirculations(db, ctx);
  } catch (err) {
    // Nothing has been claimed, so nothing is lost but latency.
    const error = errorText(err, 200);
    summary.failures.push({ uid: "circulation:scan", error });
    ctx.log("could not read the due circulations", { error });
    return {
      result: { processed: 0, hasMore: true, note: `scan failed: ${error}` },
      summary,
    };
  }

  let hasMore = false;
  // Set when the send ceiling or the wall clock stops the run. It ends the
  // WHOLE run rather than one circulation's list: without it the next
  // circulation would be queried only to refuse every recipient on it.
  let stopped = false;

  for (const circulation of circulations) {
    if (stopped) break;
    if (ctx.budget.expired()) {
      hasMore = true;
      break;
    }
    const dueDate = circulation.dueDate;
    // The query cannot return one of these, but the normaliser can produce it
    // from a document whose `dueDate` is not a timestamp, and the whole job
    // keys off this value.
    if (!dueDate) continue;
    const toggles = circulation.notifications.dueSoon;
    if (!toggles.email && !toggles.push) continue;

    // Past every skip: this circulation is one the run genuinely worked on.
    summary.circulations += 1;

    // NO LATENESS CHECK, and the header says why at length: the scan's
    // `dueDate >= ctx.now` clause is this job's whole answer to "too late",
    // and anything measured from the window opening drops the deadlines
    // closest to the wire.
    const dueKey = londonDateKey(dueDate);

    const outcome = await remindRecipients(db, ctx, { circulation, dueDate, dueKey, summary });
    if (outcome.hasMore) hasMore = true;
    if (outcome.stop) stopped = true;
  }

  const note =
    `sent ${summary.sent}, skipped ${summary.skipped}` +
    (summary.pushOnly.length > 0 ? `, push-only ${summary.pushOnly.length}` : "") +
    (summary.failures.length > 0 ? `, failed ${summary.failures.length}` : "");
  return {
    result: {
      // What this job DID, so a receipt of 0 means nobody was reminded and
      // nothing was stamped, rather than "the job did not run". Push-only
      // sends are already inside `sent` and are not added again.
      processed: summary.sent + summary.skipped,
      hasMore,
      note,
    },
    summary,
  };
}

/**
 * One circulation's worth of reminding, paged and capped.
 *
 * `stop` means the caller should start no further circulation: either the
 * per-tick ceiling is reached or the wall clock has run out. `hasMore` is what
 * the receipt reports and what makes the tick re-arm itself.
 *
 * NOTHING IN HERE THROWS. A page that will not read, a claim that will not
 * write, a stamp that will not stick: each is recorded against the unit of
 * work it belongs to and the loop carries on.
 */
async function remindRecipients(
  db: Firestore,
  ctx: JobContext,
  args: {
    circulation: CirculationDoc;
    dueDate: Date;
    dueKey: string;
    summary: WorksheetReminderRunSummary;
  },
): Promise<{ hasMore: boolean; stop: boolean }> {
  const { circulation, dueDate, dueKey, summary } = args;
  let cursor: QueryDocumentSnapshot | null = null;

  for (;;) {
    // One `in` filter on a single field, which Firestore serves from the
    // automatic single-field index, and no ordering: `submittedAt` is null on
    // exactly the audience this job wants, and ordering by it would drop every
    // one of them.
    let query = db
      .collection(CIRCULATIONS_COLLECTION)
      .doc(circulation.id)
      .collection(RESPONSES_SUBCOLLECTION)
      .where("state", "in", PENDING_STATES)
      .limit(RESPONSE_PAGE_SIZE);
    if (cursor !== null) query = query.startAfter(cursor);

    let page;
    try {
      page = await query.get();
    } catch (err) {
      const error = errorText(err, 200);
      summary.failures.push({ uid: `circulation:${circulation.id}`, error });
      ctx.log("could not read a page of recipients", {
        circulationId: circulation.id,
        dueKey,
        error,
      });
      return { hasMore: true, stop: false };
    }
    if (page.empty) return { hasMore: false, stop: false };

    for (const doc of page.docs) {
      // Out of sends, or out of time. There is deliberately no count of what
      // is left: most of the loaded recipients may already be stamped from an
      // earlier tick, so `hasMore` is the honest answer.
      if (summary.sent >= ctx.maxPerTick || ctx.budget.expired()) {
        return { hasMore: true, stop: true };
      }

      // THE DOC ID IS THE RECIPIENT'S UID, which is the whole shape of the
      // responses subcollection, so this job never normalises a response: it
      // reads no answer, no progress and no activity, and decoding them for
      // every recipient would be work done to throw away.
      const uid = doc.id;

      try {
        await remindRecipient(db, ctx, { circulation, dueDate, dueKey, summary, uid });
      } catch (err) {
        // The claim, the users read or a stamp threw. One person's bad luck is
        // not everybody else's.
        const error = errorText(err, 200);
        summary.failures.push({ uid, error });
        ctx.log("a due-soon reminder did not go out", {
          circulationId: circulation.id,
          dueKey,
          uid,
          error,
        });
      }
    }

    if (page.docs.length < RESPONSE_PAGE_SIZE) {
      return { hasMore: false, stop: false };
    }
    cursor = page.docs[page.docs.length - 1];
  }
}

/** Claim, decide, send, stamp: one recipient on one deadline. */
async function remindRecipient(
  db: Firestore,
  ctx: JobContext,
  args: {
    circulation: CirculationDoc;
    dueDate: Date;
    dueKey: string;
    summary: WorksheetReminderRunSummary;
    uid: string;
  },
): Promise<void> {
  const { circulation, dueDate, dueKey, summary, uid } = args;

  const marker = worksheetReminderMarker(circulation.id, uid, dueKey);
  const claimed = await claim(db, marker, {
    job: WORKSHEET_DUE_REMINDERS_JOB_ID,
    policy: ctx.policy,
  });
  // Not ours: already sent, already settled, in flight on another tick, or out
  // of attempts. Every one of those is somebody else's business.
  if (!claimed.claimed) return;

  const toggles = circulation.notifications.dueSoon;
  const path = worksheetRespondPath(circulation.id);
  const subject = worksheetDueSoonSubject(circulation.title);

  // EMAIL FIRST, PUSH SECOND, and a failed email sends no push: a notification
  // about mail that never arrived tells somebody to go and read something they
  // have not been sent.
  let emailed = false;
  // The EMAIL leg's verdict when it did not send, and the only place a skip
  // reason can come from. A circulation with both switches off never reaches
  // this function (the loop above drops it before anything is claimed) and the
  // push door does not report, so "no reason" means the email leg was either
  // switched off deliberately or sent.
  let emailSkip: string | null = null;
  if (toggles.email) {
    const resolved = await resolveRecipient(db, uid);
    if ("skip" in resolved) {
      emailSkip = resolved.skip;
    } else {
      let outcome: WorksheetSendOutcome;
      let failure: string | null = null;
      try {
        outcome = await sendWorksheetDueSoonEmail({
          to: resolved.to,
          name: resolved.name,
          circulationId: circulation.id,
          worksheetTitle: circulation.title,
          dueDate,
          uid,
        });
      } catch (err) {
        // `sendWorksheetDueSoonEmail` swallows its own failures, so this is
        // belt and braces.
        outcome = "failed";
        failure = errorText(err, 200);
      }
      if (outcome === "failed") {
        // Left RECLAIMABLE on purpose: `stampError` writes only `lastError`,
        // so an unsent marker older than the re-claim window is picked up by a
        // later tick, which is the whole recovery rule.
        const error = failure ?? "the reminder did not go out";
        summary.failures.push({ uid, error });
        await stampError(db, marker.id, error);
        ctx.log("a due-soon reminder did not go out", {
          circulationId: circulation.id,
          dueKey,
          markerId: marker.id,
          uid,
          error,
        });
        return;
      }
      emailed = true;
    }
  }

  let pushed = false;
  if (toggles.push) {
    // Documented never to throw and never to report: it answers "handed to the
    // push pipeline", not "buzzed a phone". A member with no enabled device,
    // or with the tasks push switched off, costs one read and nothing else.
    await mirrorTaskEmailToPush(uid, {
      title: subject,
      body: `Due ${formatWorksheetDue(dueDate)}. Open it to finish your answers.`,
      // `taskId` feeds only the board fallback inside the mirror, and the
      // rooted `url` always wins it, so the circulation id standing in for the
      // recipient's task id can never become a link anybody follows.
      taskId: circulation.id,
      url: path,
    });
    pushed = true;
  }

  if (!emailed && !pushed) {
    // Seen, claimed, and consciously not sent. The marker is the record that
    // this person was CONSIDERED; leaving it unmarked would mean re-deciding
    // the same thing, and re-reading the same documents, on every tick until
    // the deadline passed.
    //
    // The fallback string is unreachable: the only route to this line is an
    // email leg that skipped, which always names a reason. It is here because
    // the compiler cannot see that argument, and a bare literal is cheaper
    // than a constant advertising a branch nothing can execute.
    await stampSkipped(db, marker.id, emailSkip ?? "not-sent", ctx.now);
    summary.skipped += 1;
    return;
  }

  if (!emailed && emailSkip !== null) {
    // A PUSH ALONE, on a circulation that asked for both. The person was
    // reached, so this is a send; the reason the mail did not go is recorded
    // because the marker cannot hold it (`stampSent` writes one instant and no
    // channel), and a suppressed mailbox that looks like a delivered email is
    // exactly the fact a deliverability review needs.
    summary.pushOnly.push({ uid, reason: emailSkip });
    ctx.log("a due-soon reminder went by push alone", {
      circulationId: circulation.id,
      dueKey,
      uid,
      reason: emailSkip,
    });
  }

  // Counted BEFORE the stamp, because the reminder is on the wire either way
  // and a receipt that under-reports sends is a receipt that lies.
  summary.sent += 1;
  await stampSentOrSettle(db, ctx, marker.id, {
    circulationId: circulation.id,
    dueKey,
    uid,
  });
}

/**
 * Stamp a marker whose reminder HAS gone out, and make sure it stays stamped.
 *
 * The stamp is the only thing between a delivered reminder and a second copy
 * of it: `decideMarkerClaim` refuses a marker with `sentAt`, `failedAt` or
 * `skippedReason` set and nothing else, so a claimed marker left unstamped is
 * reclaimable by a later tick. The stamp therefore gets a second attempt, and
 * if that fails too the marker is settled a way the re-claim rule will not
 * touch. See {@link SENT_UNSTAMPED_REASON}.
 */
async function stampSentOrSettle(
  db: Firestore,
  ctx: JobContext,
  markerId: string,
  where: { circulationId: string; dueKey: string; uid: string },
): Promise<void> {
  try {
    await stampSent(db, markerId);
    return;
  } catch (first) {
    ctx.log("a sent reminder could not be stamped, retrying once", {
      ...where,
      markerId,
      error: errorText(first, 200),
    });
  }

  try {
    await stampSent(db, markerId);
    return;
  } catch (second) {
    const error =
      "The reminder WAS sent. Its marker could not be stamped, so it is settled " +
      `as ${SENT_UNSTAMPED_REASON} to stop a later tick sending it again: ` +
      errorText(second, 120);
    // Terminal write first: it is the one that prevents the duplicate.
    await stampSkipped(db, markerId, SENT_UNSTAMPED_REASON, ctx.now);
    await stampError(db, markerId, error);
    ctx.log("a sent reminder could not be stamped", { ...where, markerId, error });
  }
}

export const worksheetDueRemindersJob: JobRegistration = {
  id: "worksheet-due-reminders",
  label: "Worksheet due-soon reminders",
  description:
    "Reminds anyone who has not submitted their answers, two days before a circulation's due date. One reminder per person per deadline, whatever the tick does.",
  maxPerTick: 200,
  /**
   * CARRIED, NOT USED. `JobRegistration` asks every job for a lateness bound
   * and the panel shows it, but this job has no scheduled instant to be late
   * for: its audience is "the deadline has not passed yet", which the scan's
   * own `dueDate >= ctx.now` clause decides. Mapping this number onto the
   * window opening is what the header warns against, so the handler reads the
   * context's copy of this number nowhere at all (a guard in
   * `tests/worksheet-due-reminders.test.mjs` holds that down).
   */
  maxLateHours: 24,
  /**
   * Shorter than the admissions reminder's twenty minutes because the unit of
   * work is smaller: one email and one push, with no template read and no
   * personalisation pass in front of them. Ten minutes still comfortably
   * exceeds any single send, which is the floor's whole point.
   */
  reclaimAfterMinutes: 10,
  /**
   * SHIPS DARK. This job emails and pushes to people, and `config/scheduler`
   * treats a missing row as the job's own default, so without this line the
   * job would be armed on whatever data an environment held the moment it
   * deployed. The owner switches it on from Site status once a run has been
   * proven on dev, and the circulation page tells admins it is off until then.
   */
  enabledByDefault: false,
  async handler(ctx: JobContext): Promise<JobResult> {
    const { result } = await runWorksheetDueReminders(ctx);
    return result;
  },
};
