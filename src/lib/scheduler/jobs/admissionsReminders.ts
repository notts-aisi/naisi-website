import "server-only";

/**
 * `admissions-deadline-reminders`: the nudge to everybody still holding an
 * UNSUBMITTED draft on an open round.
 *
 * ## Nothing is scheduled
 *
 * There is no stored due list and no rescheduling step. Every tick reads each
 * open round's `closesAt` and its `reminderOffsets` and derives the due
 * instants again (`src/lib/admissions/reminderSchedule.ts`), so an admin who
 * moves a deadline moves every reminder with it, and a tick that never fired
 * costs latency rather than a send.
 *
 * ## The marker keys on the RESOLVED civil date
 *
 * `remind__{roundId}__{uid}__{dueAtKey}`, where `dueAtKey` is the London
 * civil date the reminder resolved to, never the offset id. Two consequences,
 * both wanted: editing the schedule cannot re-mail a date that has already
 * gone out, and two offsets that resolve to the same day are one email rather
 * than two.
 *
 * ## The order is claim, send, stamp
 *
 * `.create()` the marker BEFORE the send, `stampSent` after it. A crash in
 * between leaves an unstamped marker, which the re-claim rule picks up on a
 * later tick; the reverse order would turn the same crash into a duplicate,
 * and a duplicate deadline email to two hundred freshers is the failure
 * people talk about. `sendAdmissionEmail` returns its outcome for exactly
 * this reason: a send that threw must not be stamped as sent.
 *
 * ## One bad unit of work costs one unit of work
 *
 * Every per-candidate step is inside a try/catch: the claim, the users read,
 * the suppression read, the send and both stamps. A transient Firestore error
 * on applicant four is recorded against applicant four and the run carries
 * on, rather than throwing out of the handler and costing the other hundred
 * and ninety-six their reminder. The one step with a second attempt is the
 * `sentAt` stamp, because that is the only failure that can turn into a
 * DUPLICATE rather than a missed send (see `stampSentOrSettle`).
 *
 * ## Too late is worse than silent
 *
 * `maxLateHours` is 24. A "closes in 7 days" email that lands three days
 * after the deadline is worse than no email, so work older than that is
 * stamped `skippedReason: "stale"` and nobody is mailed. The stale stamp is
 * ONE MARKER PER ROUND AND RESOLVED DATE rather than one per applicant: it is
 * equally honest (the job would classify every applicant on that date
 * identically, and it re-derives the same verdict every tick, so no send can
 * escape it) and it is a single write instead of two per person. The uid
 * component of that marker is {@link STALE_MARKER_UID}, which cannot collide
 * with a real applicant's marker because a Firebase uid is 28 characters.
 *
 * ## Who is skipped, and why the marker still settles
 *
 * A suppressed address, an explicit courses opt-out, or an applicant with no
 * address on file is stamped `skippedReason` rather than left unmarked. The
 * marker is the record that the person was SEEN and consciously not mailed;
 * leaving it unmarked would mean re-deciding the same thing, and re-reading
 * the same documents, on every tick until the deadline passed.
 *
 * ## Concurrency
 *
 * The tick can overlap itself (see the re-arm note in the tick route), so
 * this handler must be safe to run beside itself. It is, because the only
 * thing that authorises a send is winning a `.create()` on that person's
 * marker.
 */

import { type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import {
  admissionApplicationUrl,
  sendAdmissionEmail,
  type AdmissionSendOutcome,
} from "@/lib/email/admissionEmails";
import {
  hasOptedOutOfCourseAnnouncements,
  memberNameOf,
} from "@/lib/email/courseFacilitatorEmails";
import { formatRoundDeadline, isRoundOpen } from "@/lib/admissions/window";
import {
  resolveReminderDueDates,
  type ReminderDue,
} from "@/lib/admissions/reminderSchedule";
import { getAdminDb } from "@/lib/firebase/admin";
import { APPLICATIONS_COLLECTION } from "@/lib/firestore/admissionApplications";
import {
  ROUNDS_COLLECTION,
  normalizeAdmissionRound,
  type AdmissionRoundDoc,
} from "@/lib/firestore/admissionRounds";
import { isSuppressed } from "@/lib/firestore/suppression";
import {
  claim,
  errorText,
  reminderMarker,
  stampError,
  stampSent,
  stampSkipped,
} from "@/lib/scheduler/markers";
import type { JobContext, JobRegistration, JobResult } from "../registry";

export const ADMISSIONS_REMINDERS_JOB_ID = "admissions-deadline-reminders";

/**
 * How many open rounds one tick will look at. A cap rather than a full scan
 * because a runaway read is the one way this job can eat a tick that other
 * jobs are waiting behind. Two or three rounds are open at once in practice
 * (an intake and a facilitator round); twenty is room to be wrong.
 */
export const ROUND_SCAN_CAP = 20;

/** Draft applications fetched per page. Small enough to interleave budget checks. */
export const APPLICATION_PAGE_SIZE = 100;

/**
 * The uid component of a STALE marker, which belongs to no person.
 *
 * A Firebase uid is 28 alphanumeric characters, so this six-character string
 * cannot be one, and the stale marker for a round and date can never be
 * mistaken for (or collide with) a real applicant's marker on the same date.
 */
export const STALE_MARKER_UID = "nobody";

/**
 * The skip reason on a marker whose email WENT OUT but whose `sentAt` stamp
 * could not be written, even on a retry.
 *
 * It is a SKIP rather than a plain error because of what the re-claim rule
 * keys on: `decideMarkerClaim` refuses a marker with `sentAt`, `failedAt` or
 * `skippedReason` set, and on nothing else. `stampError` writes only
 * `lastError`, so a marker left that way is reclaimable and the next tick
 * would send the same person a second copy. Settling it as a skip is
 * deliberately terminal: an oddly-worded marker is cheaper than a duplicate
 * deadline email to a whole round.
 */
export const SENT_UNSTAMPED_REASON = "sent-unstamped";

/**
 * The skip reason when the suppression list itself could not be read.
 *
 * Failing open (mailing anyway) is the one thing that must not happen here:
 * an address on the suppression list is there because a mailbox bounced or a
 * person complained, and mailing it again is a deliverability problem that
 * outlives this send. Failing closed and recording WHY leaves an honest
 * marker and keeps the rest of the run moving.
 */
export const SUPPRESSION_UNREADABLE_REASON = "suppression-unreadable";

export type ReminderRunSummary = {
  /** Emails actually handed to the send pipeline and stamped. */
  sent: number;
  /** Seen, claimed, and consciously not mailed (suppressed, opted out, no address). */
  skipped: number;
  /** Due dates dropped whole for being over `maxLateHours` late. */
  stale: number;
  /**
   * What went wrong, per unit of work. NOTHING in this job's per-candidate
   * path is allowed to throw out of the handler: a claim that fails, a stamp
   * that fails, a page of applicants that fails to read, one bad address, all
   * of them land here and the run carries on.
   *
   * `uid` is the applicant when there is one behind the failure. A failure
   * with no applicant behind it (a page read, a stale stamp) records
   * `date:{dueAtKey}` instead, which cannot be mistaken for a uid.
   */
  failures: Array<{ uid: string; error: string }>;
  /**
   * Rounds this run actually EXAMINED: loaded, still inside their application
   * window, and carrying a schedule to derive due dates from. Deliberately
   * not the number loaded, which would count the archived and shut ones the
   * run skipped without reading a single application.
   */
  rounds: number;
};

function emptySummary(): ReminderRunSummary {
  return { sent: 0, skipped: 0, stale: 0, failures: [], rounds: 0 };
}

export type ReminderRun = {
  result: JobResult;
  summary: ReminderRunSummary;
};

/** The three fields a reminder needs off an application document. */
type Candidate = {
  uid: string;
  email: string | null;
  displayName: string;
};

/**
 * Read a candidate off a raw application document.
 *
 * Deliberately three fields rather than `normalizeAdmissionApplication`: this
 * job never reads an answer, an availability mask or an evidence snapshot,
 * and decoding them for every draft on a round would be work done to throw
 * away. The `uid` is taken from the FIELD rather than parsed out of the doc
 * id, which is construct-only by contract.
 */
function candidateFrom(snap: QueryDocumentSnapshot): Candidate | null {
  const data = snap.data() as Record<string, unknown>;
  const uid = typeof data.uid === "string" ? data.uid : "";
  if (!uid) return null;
  const email = typeof data.email === "string" && data.email ? data.email : null;
  const displayName = typeof data.displayName === "string" ? data.displayName : "";
  return { uid, email, displayName };
}

/** The rounds this run covers: one named round, or every open one. */
async function loadRounds(
  db: Firestore,
  roundId: string | undefined,
): Promise<AdmissionRoundDoc[]> {
  if (roundId) {
    const snap = await db.collection(ROUNDS_COLLECTION).doc(roundId).get();
    if (!snap.exists) return [];
    return [normalizeAdmissionRound(snap.id, snap.data() ?? {})];
  }
  // One equality filter, so no composite index and no `orderBy` on a field a
  // document might be missing.
  const query = await db
    .collection(ROUNDS_COLLECTION)
    .where("status", "==", "open")
    .limit(ROUND_SCAN_CAP)
    .get();
  return query.docs.map((doc) => normalizeAdmissionRound(doc.id, doc.data()));
}

/**
 * Everything one applicant's reminder needs, or a reason not to send it.
 *
 * Split out so the send loop reads as claim / decide / send / stamp rather
 * than as five nested conditions.
 */
async function resolveRecipient(
  db: Firestore,
  candidate: Candidate,
): Promise<{ to: string; name: string } | { skip: string }> {
  let optedOut = false;
  let name = candidate.displayName;
  let accountEmail: string | null = null;
  try {
    const snap = await db.collection("users").doc(candidate.uid).get();
    if (snap.exists) {
      const data = snap.data() as Record<string, unknown>;
      optedOut = hasOptedOutOfCourseAnnouncements(data);
      name = memberNameOf(data) || candidate.displayName;
      accountEmail =
        typeof data.email === "string" && data.email ? data.email : null;
    }
  } catch {
    // A users read that fails is not a reason to refuse a transactional
    // reminder about the reader's own draft; it is a reason to fall back to
    // what the application itself recorded. The opt-out defaults to false
    // here, which matches `hasOptedOutOfCourseAnnouncements`: only an
    // EXPLICIT `categories.courses === false` is a refusal.
  }
  if (optedOut) return { skip: "opted-out" };
  const to = candidate.email ?? accountEmail;
  if (!to) return { skip: "no-address" };
  let suppressed: boolean;
  try {
    suppressed = await isSuppressed(db, to);
  } catch {
    // See SUPPRESSION_UNREADABLE_REASON: a read that fails is a reason not to
    // send, and a reason to say so on the marker, never a reason to abort the
    // run or to mail a suppressed address.
    return { skip: SUPPRESSION_UNREADABLE_REASON };
  }
  if (suppressed) return { skip: "suppressed" };
  return { to, name };
}

/**
 * The handler, callable either from the tick or from the round page's Send
 * now button (`opts.roundId`).
 *
 * ONE implementation for both lanes on purpose. A "send now" that took its
 * own path would be a second route through the only thing on this platform
 * that must not double-send, and it would drift.
 */
export async function runAdmissionsReminders(
  ctx: JobContext,
  opts: { roundId?: string } = {},
): Promise<ReminderRun> {
  const summary = emptySummary();
  const db = getAdminDb();
  if (!db) {
    return {
      result: { processed: 0, hasMore: false, note: "admin sdk unavailable" },
      summary,
    };
  }

  const rounds = await loadRounds(db, opts.roundId);
  let hasMore = false;

  // Set when the send ceiling or the wall clock stops the run. It ends the
  // WHOLE run rather than one round's list: without it the next round would
  // be queried only to refuse every applicant on it, one wasted read per
  // round for nothing.
  let stopped = false;

  for (const round of rounds) {
    if (stopped) break;
    if (ctx.budget.expired()) {
      hasMore = true;
      break;
    }
    // The SHARED window predicate, the one the apply page and the submit
    // route already use, rather than a bare `status === "open"`. A round whose
    // `closesAt` has passed is closed however its status still reads, and
    // mailing "applications close on Sun 4 Oct, 09:00" at noon that day sends
    // the reader to a form that refuses them. `isRoundOpen` also covers the
    // archived and draft cases, and the not-yet-opened one.
    if (!isRoundOpen(round, ctx.now)) continue;
    // A round with no deadline has nothing to count back from. (Null is
    // "no automatic limit" to the window predicate, so it has to be asked
    // separately here.)
    if (round.closesAt === null) continue;
    if (round.reminderOffsets.length === 0) continue;

    // Past every skip: this round is one the run genuinely worked on.
    summary.rounds += 1;

    const deadline = formatRoundDeadline(round.closesAt);
    const applicationUrl = admissionApplicationUrl(round.id, "apply");
    const due = resolveReminderDueDates({
      closesAt: round.closesAt,
      offsets: round.reminderOffsets,
      now: ctx.now,
      maxLateHours: ctx.maxLateHours,
    });

    for (const entry of due) {
      if (entry.state === "pending") continue;
      if (ctx.budget.expired()) {
        hasMore = true;
        break;
      }
      if (entry.state === "stale") {
        try {
          const stamped = await stampStale(db, ctx, round.id, entry);
          if (stamped) summary.stale += 1;
        } catch (err) {
          // A stale stamp is bookkeeping about a date nobody is being mailed
          // on. It is not worth ending the run for, and the next tick derives
          // the same verdict again.
          summary.failures.push({
            uid: `date:${entry.dueAtKey}`,
            error: errorText(err, 200),
          });
        }
        continue;
      }
      const outcome = await sendForDueDate(db, ctx, {
        round,
        entry,
        deadline,
        applicationUrl,
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
    (summary.failures.length > 0 ? `, failed ${summary.failures.length}` : "");
  return {
    result: {
      // What this job DID, so a receipt of 0 means nobody was mailed and
      // nothing was stamped, rather than "the job did not run".
      processed: summary.sent + summary.skipped + summary.stale,
      hasMore,
      note,
    },
    summary,
  };
}

/** Claim and settle the one marker that records a whole date as dropped. */
async function stampStale(
  db: Firestore,
  ctx: JobContext,
  roundId: string,
  entry: ReminderDue,
): Promise<boolean> {
  const marker = reminderMarker(roundId, STALE_MARKER_UID, entry.dueAtKey);
  const claimed = await claim(db, marker, {
    job: ADMISSIONS_REMINDERS_JOB_ID,
    policy: ctx.policy,
  });
  if (!claimed.claimed) return false;
  await stampSkipped(db, marker.id, "stale", ctx.now);
  ctx.log("dropped a due date as stale", {
    roundId,
    dueAtKey: entry.dueAtKey,
    offsets: entry.offsetIds.join(","),
    dueAt: entry.dueAt.toISOString(),
  });
  return true;
}

/**
 * One resolved due date's worth of sending, paged and capped.
 *
 * `stop` means the caller should start no further due date and no further
 * round: either the per-tick send ceiling is reached or the wall clock has
 * run out. `hasMore` is what the receipt reports and what makes the tick
 * re-arm itself.
 *
 * NOTHING IN HERE THROWS. A page that will not read, a claim that will not
 * write, a stamp that will not stick: each is recorded against the unit of
 * work it belongs to and the loop carries on. The failure mode being avoided
 * is a single transient Firestore error on applicant number four costing the
 * other hundred and ninety-six their reminder.
 */
async function sendForDueDate(
  db: Firestore,
  ctx: JobContext,
  args: {
    round: AdmissionRoundDoc;
    entry: ReminderDue;
    deadline: string;
    applicationUrl: string;
    summary: ReminderRunSummary;
  },
): Promise<{ hasMore: boolean; stop: boolean }> {
  const { round, entry, deadline, applicationUrl, summary } = args;
  let cursor: QueryDocumentSnapshot | null = null;

  for (;;) {
    // Two equality filters and no ordering: Firestore serves this from the
    // single-field indexes, and a `submittedAt` order would drop every draft
    // (the field is null until submission) exactly as the sparse-field rule
    // in CLAUDE.md warns.
    //
    // `status == "draft"` is an equality on the STORED value, while
    // `normalizeAdmissionApplication` reads a missing or unrecognised status
    // AS draft. A document written without the field would therefore be in
    // the audience by the normaliser's reckoning and outside this query. That
    // is accepted deliberately, and in the safe direction: the alternative is
    // a not-in filter over every other status, which costs an index and would
    // mail anyone whose status is a typo. Every write path sets the field.
    let query = db
      .collection(APPLICATIONS_COLLECTION)
      .where("roundId", "==", round.id)
      .where("status", "==", "draft")
      .limit(APPLICATION_PAGE_SIZE);
    if (cursor !== null) query = query.startAfter(cursor);

    let page;
    try {
      page = await query.get();
    } catch (err) {
      // Nothing has been claimed, so nothing is lost but latency: report the
      // date as outstanding and let the next tick derive it again.
      const error = errorText(err, 200);
      summary.failures.push({ uid: `date:${entry.dueAtKey}`, error });
      ctx.log("could not read a page of applicants", {
        roundId: round.id,
        dueAtKey: entry.dueAtKey,
        error,
      });
      return { hasMore: true, stop: false };
    }
    if (page.empty) return { hasMore: false, stop: false };

    for (let i = 0; i < page.docs.length; i += 1) {
      // Out of sends, or out of time. There is deliberately no count of what
      // is left: this run has only LOADED a page of the audience and knows
      // nothing about the people behind it, and most of the ones it has
      // loaded may already be stamped from an earlier tick. `hasMore` is the
      // honest answer, and it is the one the receipt gives.
      if (summary.sent >= ctx.maxPerTick || ctx.budget.expired()) {
        return { hasMore: true, stop: true };
      }

      const candidate = candidateFrom(page.docs[i]);
      if (candidate === null) continue;

      try {
        await sendToCandidate(db, ctx, {
          round,
          entry,
          deadline,
          applicationUrl,
          summary,
          candidate,
        });
      } catch (err) {
        // The claim, the recipient lookup or a stamp threw. One person's bad
        // luck is not everybody else's.
        const error = errorText(err, 200);
        summary.failures.push({ uid: candidate.uid, error });
        ctx.log("a reminder did not go out", {
          roundId: round.id,
          dueAtKey: entry.dueAtKey,
          uid: candidate.uid,
          error,
        });
      }
    }

    if (page.docs.length < APPLICATION_PAGE_SIZE) {
      return { hasMore: false, stop: false };
    }
    cursor = page.docs[page.docs.length - 1];
  }
}

/** Claim, decide, send, stamp: one applicant on one due date. */
async function sendToCandidate(
  db: Firestore,
  ctx: JobContext,
  args: {
    round: AdmissionRoundDoc;
    entry: ReminderDue;
    deadline: string;
    applicationUrl: string;
    summary: ReminderRunSummary;
    candidate: Candidate;
  },
): Promise<void> {
  const { round, entry, deadline, applicationUrl, summary, candidate } = args;

  const marker = reminderMarker(round.id, candidate.uid, entry.dueAtKey);
  const claimed = await claim(db, marker, {
    job: ADMISSIONS_REMINDERS_JOB_ID,
    policy: ctx.policy,
  });
  // Not ours: already sent, already settled, in flight on another tick, or
  // out of attempts. Every one of those is somebody else's business.
  if (!claimed.claimed) return;

  const resolved = await resolveRecipient(db, candidate);
  if ("skip" in resolved) {
    await stampSkipped(db, marker.id, resolved.skip, ctx.now);
    summary.skipped += 1;
    return;
  }

  let outcome: AdmissionSendOutcome;
  let failure: string | null = null;
  try {
    outcome = await sendAdmissionEmail({
      kind: "deadline-reminder",
      to: resolved.to,
      name: resolved.name,
      roundLabel: round.label,
      // The audience holds DRAFTS, so the link goes back to the form.
      applicationUrl,
      deadline,
      uid: candidate.uid,
      roundId: round.id,
    });
  } catch (err) {
    // `sendAdmissionEmail` swallows its own failures, so this is belt and
    // braces.
    outcome = "failed";
    failure = errorText(err, 200);
  }

  if (outcome === "sent") {
    // Counted BEFORE the stamp, because the mail is on the wire either way
    // and a receipt that under-reports sends is a receipt that lies.
    summary.sent += 1;
    await stampSentOrSettle(db, ctx, marker.id, {
      roundId: round.id,
      dueAtKey: entry.dueAtKey,
      uid: candidate.uid,
    });
    return;
  }

  if (outcome === "suppressed") {
    await stampSkipped(db, marker.id, "suppressed", ctx.now);
    summary.skipped += 1;
    return;
  }

  // Left RECLAIMABLE on purpose: `stampError` writes only `lastError`, so an
  // unsent marker older than the re-claim window is picked up by a later
  // tick, which is the whole recovery rule. Stamping it terminally either way
  // would be silent non-delivery.
  const error = failure ?? "the send did not go out";
  summary.failures.push({ uid: candidate.uid, error });
  await stampError(db, marker.id, error);
  ctx.log("a reminder did not go out", {
    roundId: round.id,
    dueAtKey: entry.dueAtKey,
    markerId: marker.id,
    error,
  });
}

/**
 * Stamp a marker whose email HAS gone out, and make sure it stays stamped.
 *
 * The stamp is the only thing between a delivered email and a second copy of
 * it. `decideMarkerClaim` refuses a marker with `sentAt`, `failedAt` or
 * `skippedReason` set and nothing else, so a claimed marker left unstamped is
 * reclaimable: a later tick re-derives this person, wins the re-claim, and
 * mails them again.
 *
 * So the stamp gets a second attempt, and if that fails too the marker is
 * settled a way the re-claim rule will not touch. See
 * {@link SENT_UNSTAMPED_REASON}. A stamp that never lands leaves an
 * odd-looking marker; a re-claim leaves a duplicate deadline email to a whole
 * round, which is the failure people talk about.
 */
async function stampSentOrSettle(
  db: Firestore,
  ctx: JobContext,
  markerId: string,
  where: { roundId: string; dueAtKey: string; uid: string },
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
      "The email WAS sent. Its marker could not be stamped, so it is settled " +
      `as ${SENT_UNSTAMPED_REASON} to stop a later tick sending it again: ` +
      errorText(second, 120);
    // Terminal write first: it is the one that prevents the duplicate.
    await stampSkipped(db, markerId, SENT_UNSTAMPED_REASON, ctx.now);
    await stampError(db, markerId, error);
    ctx.log("a sent reminder could not be stamped", {
      ...where,
      markerId,
      error,
    });
  }
}

export const admissionsRemindersJob: JobRegistration = {
  id: "admissions-deadline-reminders",
  label: "Application deadline reminders",
  description:
    "Emails anyone still holding an unsubmitted draft on an open round, on the dates that round's reminder schedule works out from its deadline. One email per person per date, whatever the tick does.",
  maxPerTick: 200,
  maxLateHours: 24,
  reclaimAfterMinutes: 20,
  /**
   * SHIPS DARK. This job emails applicants, and `config/scheduler` treats a
   * missing row as the job's own default, so without this line the job would
   * be armed on whatever data an environment held the moment it deployed.
   * The owner switches it on from Site status once the round is open and a
   * run has been proven on dev (docs/courses-ops.md). Send now refuses while
   * it is off, so the manual lane cannot bypass the dark period by accident.
   */
  enabledByDefault: false,
  async handler(ctx: JobContext): Promise<JobResult> {
    const { result } = await runAdmissionsReminders(ctx);
    return result;
  },
};
