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
 * ## Nothing is scheduled, and the sender's slots are the schedule
 *
 * A circulation carries its own reminder list at
 * `notifications.dueSoon.slots` (see `src/lib/reminders/slots.ts`): up to six
 * entries, each a number of days before `dueDate` and a London wall clock on
 * that day. Nothing is stored as a due list. Every tick reads the due date and
 * the slots and resolves them again from scratch through
 * `resolveReminderSlots`, the SAME resolver the admissions deadline reminders
 * use, so moving a deadline moves every reminder with it and a tick that
 * never fired costs latency rather than a send.
 *
 * A circulation stored before the slots existed reads as the defaults (three
 * days out and the day before, both at 10:00), because `normalizeNotifications`
 * fills them in. The two switches remain the on and off: both off and this job
 * skips the circulation before it reads a single response.
 *
 * ## THE SCAN, AND WHY IT STILL FITS ONE INDEX
 *
 * `status == "open"`, then `dueDate` between the start of TODAY in London and
 * `now + {@link SCAN_HORIZON_DAYS}` days, in that clause order, because that
 * is the order of the ONE composite index this feature declares
 * (`circulations (status ASC, dueDate ASC)` in `firestore.indexes.json`).
 * Equality first, then the range field: writing the chain any other way is the
 * same query to Firestore and a different-looking one to
 * `tests/firestore-indexes.test.mjs`.
 *
 * The two bounds are the two things the arithmetic downstream can prove:
 *
 *  - A slot NEVER resolves past the due date (the resolver drops one that
 *    would), so a circulation with any slot due today has a due date that is
 *    either still ahead or earlier TODAY. Reading from the start of the London
 *    civil day rather than from `now` is what keeps that second case in: a
 *    worksheet due at 09:00 with a nudge set for 08:00 is still owed that
 *    nudge at 08:05, and `dueDate >= now` would have dropped the whole
 *    circulation at 09:01 while the reminder was five minutes late rather than
 *    a day late. Yesterday's deadlines are out, which is the boundary this job
 *    promises: a passed day is a passed deadline.
 *  - A slot at most `REMINDER_SLOT_LIMITS.maxDaysBefore` days out means a due
 *    date beyond that horizon cannot have a reminder due yet, so the horizon
 *    costs nothing and keeps the scan cap (below) spent on the circulations
 *    that might actually send.
 *
 * The filtering that the query cannot do is done in code, on the resolved
 * slots: `pending` is left for a later tick, `stale` is dropped, `due` sends.
 *
 * ## The marker keys on the resolved moment, date AND wall clock
 *
 * `wsremind__{circulationId}__{uid}__{dueKey}` where `dueKey` is the London
 * civil date the slot resolved to with its wall clock appended
 * (`2026-10-04T1000`). Three consequences, all wanted:
 *
 *  1. A tick that runs every quarter of an hour sends ONE reminder per slot,
 *     because every tick after the first finds that slot's marker.
 *  2. TWO SLOTS ON ONE DAY at different times are two reminders, which is what
 *     a sender who set 09:00 and 16:00 on the due day asked for. Two slots
 *     resolving to the same moment are one, because they are one key. (This is
 *     the `"instant"` grouping; admissions groups by DAY, where the audience is
 *     an applicant pool rather than a handful of named people.)
 *  3. MOVING THE DEADLINE re-resolves every slot and mints new keys, so people
 *     who still have not submitted are reminded about the new date rather than
 *     silenced by the old date's markers.
 *
 * ## LATENESS IS MEASURED FROM THE SLOT, NEVER FROM THE WINDOW
 *
 * `maxLateHours` (24) is now honoured, and it is measured from the moment the
 * slot itself resolved to. Read that twice, because the bug this replaced was
 * the other reading: an earlier version had a fixed 48-hour window and mapped
 * `maxLateHours` onto the moment that window OPENED, which silenced precisely
 * the reminders that matter most. A deadline less than 24 hours away is, by
 * definition, one whose 48-hour window opened more than 24 hours ago, so a
 * scheduler that had never missed a tick dropped every same-day worksheet,
 * and dropped everybody added inside the last day with it, while the marker
 * said "stale" about a run that was never late.
 *
 * Measured from the slot, the same number says something true: a nudge set for
 * 10:00 on Tuesday is worth sending at 10:05 and not worth sending on
 * Thursday, whatever the deadline is doing. What that costs, said plainly: a
 * recipient added AFTER the last slot has passed gets no reminder at all,
 * where the old window would have found them. The answer to that is a slot on
 * the due day, which the sender can now add, rather than a job that mails
 * people about a schedule nobody set.
 *
 * A stale slot is dropped in code with NO marker written, and that is a
 * deliberate difference from `admissionsReminders.ts`, which stamps one per
 * stale date. A worksheet's slots are days apart, so on the day-before tick
 * the three-day slot is always stale and always ALREADY SENT: a marker saying
 * "dropped as stale" would be a record of a reminder that went out on time.
 * The arithmetic is free to redo every tick, and the per-recipient markers are
 * the record that matters.
 *
 * ## STALE IS THE ORDINARY END OF A DELIVERED REMINDER, SO IT IS REPORTED ONCE
 *
 * Read that heading before touching {@link STALE_REPORT_WINDOW_HOURS}. A slot
 * stays resolvable for as long as its circulation is in the scan, so a
 * reminder that went out perfectly on Monday is still resolving, still past
 * its moment and still classified `stale` on every tick until Thursday. The
 * first version of this job counted and logged each of those, which on a
 * quarter-hourly tick is the same line about the same non-event roughly a
 * hundred times a day, and put the count into `processed`, so the panel
 * showed the job "doing work" on ticks where it did nothing at all. Neither
 * was a wrong email; both were a health readout that cried wolf.
 *
 * So: a stale entry is reported only while it is FRESHLY stale, meaning it
 * crossed the `maxLateHours` bound within the last
 * {@link STALE_REPORT_WINDOW_HOURS}, and it is NOT counted as work in
 * `processed`. What the counter means afterwards is honest and narrow: "a
 * reminder passed the point of being worth sending during this run's window".
 * It is not, and never was, proof that the reminder was missed. Nothing here
 * can know that without reading the audience's markers, which is exactly the
 * work the stale branch exists to skip. The question "has the scheduler been
 * dark" is answered by the scheduler panel's own last-run time, which is the
 * thing that actually knows.
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
import { londonDateKey, londonWallClockToInstant } from "@/lib/courses/weekPlan";
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
import { resolveReminderSlots } from "@/lib/reminders/schedule";
import { REMINDER_SLOT_LIMITS, type ReminderSlot } from "@/lib/reminders/slots";
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
 * How far ahead the scan looks, in days.
 *
 * Not a schedule: the schedule is each circulation's own slot list. This is
 * the horizon beyond which no slot CAN be due, which is the furthest a slot
 * may be set from its due date, so it is that number rather than a second
 * opinion about it. A due date past this horizon is loaded by nothing and
 * costs nothing.
 */
export const SCAN_HORIZON_DAYS = REMINDER_SLOT_LIMITS.maxDaysBefore;

const SCAN_HORIZON_MS = SCAN_HORIZON_DAYS * 86_400_000;

/**
 * How many circulations one tick will look at. A cap rather than a full scan
 * because a runaway read is the one way this job eats a tick that other jobs
 * are waiting behind. A committee runs a handful of worksheets at a time;
 * twenty deadlines inside one horizon is room to be wrong.
 *
 * WHAT THE CAP COSTS, said out loud: the scan is not paged, so a
 * twenty-first circulation inside the horizon is invisible until one of the
 * twenty leaves it, and by then its deadline may be hours rather than days
 * away. The run deliberately does NOT report `hasMore` for a full page
 * either, because the next tick would run the same unpaged query, find the
 * same twenty stamped, and re-arm on them forever.
 *
 * The implicit `dueDate ASC` ordering makes the cap survivable rather than
 * safe, and the difference matters more than it used to. The window this job
 * scanned before the schedule was configurable was 48 hours, where "the
 * twenty soonest deadlines" and "the twenty most urgent reminders" were the
 * same twenty. Over a SIXTY-DAY horizon they can come apart: a worksheet due
 * in fifty days whose sender set a fifty-day nudge is owed that nudge today
 * and sits behind twenty nearer deadlines that are owed nothing. The
 * committee runs a handful of worksheets a term, so twenty open deadlines
 * inside two months is already generous, and the schedule this cap could
 * starve is one somebody had to set by hand. Raising the number is the fix if
 * a term ever has twenty worksheets open at once; a cursor is the fix if it
 * has hundreds, and ordering by the soonest RESOLVED slot rather than by the
 * deadline is the fix if long-range nudges ever become normal.
 */
export const CIRCULATION_SCAN_CAP = 20;

/** Responses fetched per page. Small enough to interleave budget checks. */
export const RESPONSE_PAGE_SIZE = 100;

/**
 * How long after a slot passes the `maxLateHours` bound it is still worth
 * SAYING that it passed. See the header section of the same name.
 *
 * Two hours, chosen against the tick rather than against the reminder. The
 * tick is armed every few minutes, so any cadence up to hourly meets the
 * crossing at least once inside this window and the fact is recorded; and
 * because the window closes, the same crossing is recorded a handful of times
 * rather than every tick for the rest of the circulation's life. Widening it
 * buys nothing and re-opens the log spam; narrowing it below the tick cadence
 * would let a crossing go unrecorded entirely.
 */
export const STALE_REPORT_WINDOW_HOURS = 2;

const STALE_REPORT_WINDOW_MS = STALE_REPORT_WINDOW_HOURS * 3_600_000;

/**
 * Did this resolved slot cross the lateness bound recently enough to be worth
 * a line in the log and a number on the receipt?
 *
 * `dueAt + maxLateHours` is the moment the entry stopped being sendable. An
 * entry inside {@link STALE_REPORT_WINDOW_HOURS} of that moment is news; one
 * further past it is history, and on this job history is the normal state of
 * a reminder that was delivered on time.
 */
function isFreshlyStale(dueAt: Date, now: Date, maxLateHours: number): boolean {
  const passedAt = dueAt.getTime() + maxLateHours * 3_600_000;
  return now.getTime() - passedAt <= STALE_REPORT_WINDOW_MS;
}

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
   * Resolved reminders dropped for being further past their slot than
   * `maxLateHours`, counted ONLY while they are freshly past it (see
   * {@link STALE_REPORT_WINDOW_HOURS} and the header section it belongs to).
   *
   * Read it as "a reminder passed the point of being worth sending during
   * this run's window", which is all it can honestly mean. It is NOT a count
   * of nudges that went missing: a reminder delivered on time ages into this
   * state as a matter of course, and telling the two apart would take a read
   * of every recipient's marker, which is the work the stale branch exists to
   * skip. A dark scheduler shows up as a stale LAST RUN on the panel, not
   * here. Not folded into `processed` either, for the same reason: declining
   * to send something is not work done.
   */
  stale: number;
  /**
   * Circulations this run actually EXAMINED: open, inside the horizon, with at
   * least one due-soon channel switched on, AND with at least one slot past
   * its moment (sent, or dropped as stale). Deliberately not the number
   * loaded, which would count the ones whose whole schedule is still ahead
   * and whose responses the run never read.
   */
  circulations: number;
};

function emptySummary(): WorksheetReminderRunSummary {
  return { sent: 0, skipped: 0, pushOnly: [], failures: [], stale: 0, circulations: 0 };
}

export type WorksheetReminderRun = {
  result: JobResult;
  summary: WorksheetReminderRunSummary;
};

/**
 * The first instant of the London civil day `now` falls in.
 *
 * Through the same wall-clock helper the slots use, rather than by truncating
 * a UTC timestamp: midnight London is 23:00 the previous day in UTC for half
 * the year, and a lower bound an hour out is a lower bound that drops a real
 * circulation on the two days a year the clocks move.
 */
function londonDayStart(now: Date): Date {
  return londonWallClockToInstant(londonDateKey(now), "00:00");
}

/**
 * The circulations that could have a reminder due: open, and due today or
 * inside the horizon.
 *
 * ONE equality filter and one range field, in the order the composite index
 * declares them. No `orderBy`: Firestore orders by the range field on its own,
 * and an explicit sort on anything else would need a second index and would
 * drop every document missing the sorted field.
 *
 * That implicit ordering is also what makes the cap safe. `dueDate ASC` means
 * the twenty the run takes are the twenty SOONEST deadlines, so a tick that
 * cannot see every circulation is one that saw the most urgent ones, and the
 * rest are still inside the horizon on the next tick.
 */
async function dueCirculations(db: Firestore, ctx: JobContext): Promise<CirculationDoc[]> {
  const horizon = new Date(ctx.now.getTime() + SCAN_HORIZON_MS);
  const snap = await db
    .collection(CIRCULATIONS_COLLECTION)
    .where("status", "==", "open")
    .where("dueDate", ">=", londonDayStart(ctx.now))
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

    // THE SCHEDULE, RESOLVED FRESH. Grouped by instant rather than by day,
    // because a sender who set two times on the due day asked for two
    // reminders; see the header. `maxLateHours` is measured from each slot's
    // own moment, which is the whole correction this rewrite carries.
    const resolved = resolveReminderSlots({
      anchor: dueDate,
      slots: toggles.slots,
      now: ctx.now,
      maxLateHours: ctx.maxLateHours,
      grouping: "instant",
    });
    const due = resolved.filter((entry) => entry.state !== "pending");
    if (due.length === 0) continue;

    // Past every skip: this circulation is one the run genuinely worked on.
    summary.circulations += 1;

    // The days-before of each slot, for the email copy and the log. Two slots
    // that share a key share a moment and therefore share this number, so the
    // first of the group answers for all of them.
    const slotById = new Map<string, ReminderSlot>(
      toggles.slots.map((slot) => [slot.id, slot] as const),
    );

    // ONE PASS OVER THE AUDIENCE PER DUE REMINDER. Two entries in one tick
    // means two scans of the responses, which only happens when a tick caught
    // up on a slot it had missed: in the ordinary case exactly one slot is due
    // and the audience is read once. Reading it once and deciding both slots
    // inside the loop would save nothing, because the claim, the skip reason
    // and the stamp are all per marker anyway.
    for (const entry of due) {
      if (ctx.budget.expired()) {
        hasMore = true;
        break;
      }
      if (entry.state === "stale") {
        // Dropped, left unmarked on purpose, and reported only while the
        // crossing is fresh (see the header). Every tick between now and the
        // deadline resolves this same entry to this same verdict, and on all
        // but the first few the reminder it describes went out on time days
        // ago, so counting and logging it each time would be a hundred lines a
        // day about nothing happening.
        if (isFreshlyStale(entry.dueAt, ctx.now, ctx.maxLateHours)) {
          summary.stale += 1;
          ctx.log("a due-soon reminder passed the point of being worth sending", {
            circulationId: circulation.id,
            dueKey: entry.dueAtKey,
            dueAt: entry.dueAt.toISOString(),
          });
        }
        continue;
      }
      const daysBefore = slotById.get(entry.slotIds[0])?.daysBefore ?? 0;
      const outcome = await remindRecipients(db, ctx, {
        circulation,
        dueDate,
        dueKey: entry.dueAtKey,
        daysBefore,
        summary,
      });
      if (outcome.hasMore) hasMore = true;
      if (outcome.stop) {
        stopped = true;
        break;
      }
    }
  }

  const note =
    `sent ${summary.sent}, skipped ${summary.skipped}, stale ${summary.stale}` +
    (summary.pushOnly.length > 0 ? `, push-only ${summary.pushOnly.length}` : "") +
    (summary.failures.length > 0 ? `, failed ${summary.failures.length}` : "");
  return {
    result: {
      // What this job DID, so a receipt of 0 means nobody was reminded and
      // nothing was stamped, rather than "the job did not run". Push-only
      // sends are already inside `sent` and are not added again. Stale
      // reminders are NOT here: declining to send a reminder whose moment has
      // gone writes nothing and reaches nobody, and folding it in showed the
      // panel a job hard at work on ticks where it touched no document at all.
      processed: summary.sent + summary.skipped,
      hasMore,
      note,
    },
    summary,
  };
}

/**
 * One resolved reminder's worth of reminding, paged and capped.
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
    /** The resolved slot's marker key: its London date and wall clock. */
    dueKey: string;
    /** That slot's distance from the due date, for the email copy. */
    daysBefore: number;
    summary: WorksheetReminderRunSummary;
  },
): Promise<{ hasMore: boolean; stop: boolean }> {
  const { circulation, dueDate, dueKey, daysBefore, summary } = args;
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
        await remindRecipient(db, ctx, {
          circulation,
          dueDate,
          dueKey,
          daysBefore,
          summary,
          uid,
        });
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

/** Claim, decide, send, stamp: one recipient on one scheduled reminder. */
async function remindRecipient(
  db: Firestore,
  ctx: JobContext,
  args: {
    circulation: CirculationDoc;
    dueDate: Date;
    dueKey: string;
    daysBefore: number;
    summary: WorksheetReminderRunSummary;
    uid: string;
  },
): Promise<void> {
  const { circulation, dueDate, dueKey, daysBefore, summary, uid } = args;

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
          // Which of the circulation's reminders this is. A person can get
          // several for one worksheet, and the copy says which so the second
          // does not read as the first sent twice.
          daysBefore,
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
    "Reminds anyone who has not submitted their answers, on the schedule the sender set on the circulation. One reminder per person per scheduled time, whatever the tick does.",
  maxPerTick: 200,
  /**
   * MEASURED FROM THE SLOT, never from a window. A nudge set for 10:00 is
   * worth sending at 10:05 and not worth sending a day later, so this is the
   * bound `resolveReminderSlots` classifies each resolved slot against.
   *
   * The failure this replaced is worth keeping in view: the same number used
   * to be measured from the moment a fixed 48-hour window opened, which
   * silenced every deadline less than 24 hours away on a scheduler that had
   * never missed a tick. `tests/worksheet-due-reminders.test.mjs` pins both
   * the correct measurement and that behaviour.
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
