import "server-only";
import WorksheetDueSoonEmail from "@/emails/WorksheetDueSoonEmail";
import { COURSE_TZ } from "@/lib/courses/weekPlan";
import { sendEmail } from "./send";

/**
 * The due-soon reminder's send, behind one door.
 *
 * ## Why this is a module and not four lines inside the job
 *
 * Same reason `admissionEmails.ts` exists beside the deadline-reminder job,
 * and it is worth writing down because the alternative looks tidier:
 *
 *  1. A SCHEDULER JOB HAS TO KNOW WHETHER THE SEND HAPPENED. A claimed marker
 *     is stamped `sentAt` only when mail is genuinely on the wire, so this
 *     returns an OUTCOME and swallows its own failure rather than throwing
 *     into a loop whose next step is a stamp. `sendEmail` itself throws.
 *  2. THE REGISTRY IMPORTS EVERY JOB BY VALUE, so anything a job imports is
 *     loaded by anything that loads the registry, the unit suites included.
 *     A `.tsx` template reached directly from the job's own file would put
 *     JSX in the graph of `tests/scheduler-markers.test.mjs`, which transpiles
 *     modules one at a time with no JSX setting. Keeping the template behind
 *     a plain `.ts` door means one stub in a test instead of a JSX pipeline.
 *
 * ## Why it is not `src/lib/worksheets/notify.ts`
 *
 * That module answers a different question: "this circulation event just
 * happened, tell everybody who should hear about it", checking the
 * circulation's own switch and the site-wide kill switch on the way. The job
 * has already decided both, per recipient, and has a claimed marker riding on
 * the answer. Routing through `notifyWorksheetEvent` would hand the job a
 * count rather than an outcome, and would re-read the kill switch once per
 * person.
 *
 * ## Suppression is NOT checked here
 *
 * Unlike `sendAdmissionEmail`, which is called from routes that have no
 * suppression step of their own. Every caller of this function is the
 * scheduler job, which checks the list itself so that a suppressed address is
 * recorded ON THE MARKER as a skip rather than disappearing into a log line.
 * Checking it twice would cost a read per recipient and hide the reason.
 */

export type WorksheetSendOutcome = "sent" | "failed";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://naisi.uk";

/**
 * Where a recipient answers, as a ROOTED PATH.
 *
 * Path form because it has two consumers with different needs: the email
 * button wants an absolute URL (an inbox cannot resolve a relative one) and
 * the push notification wants a path (the service worker resolves it against
 * the app origin and refuses anything absolute). One builder, one place to
 * change when the route moves.
 */
export function worksheetRespondPath(circulationId: string): string {
  return `/worksheets/respond/${encodeURIComponent(circulationId)}`;
}

/**
 * The deadline as a person reads it, in London civil time.
 *
 * `Intl` with an explicit `timeZone` rather than `toLocaleString` on the
 * server's own clock: a Cloud Run container runs in UTC, so an unqualified
 * format would tell a recipient their worksheet is due at 23:00 on the day
 * before it actually is, for half the year.
 */
export function formatWorksheetDue(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: COURSE_TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/**
 * How far out this reminder is, as the phrase the email uses.
 *
 * A circulation can carry up to six reminders, so a recipient may get more
 * than one for the same worksheet. Without this line the second one reads as
 * a duplicate of the first, and a reader who thinks a reminder is a mistake
 * stops reading reminders. With it, each says which nudge it is and, by
 * implication, that there is a schedule rather than a loop.
 *
 * Deliberately NOT imported by the scheduler job. The job hands over a number
 * and this module turns it into words, so the two suites that stub this
 * module (this feature's and the admissions one, which loads the whole job
 * registry) do not have to grow an export apiece every time the copy changes.
 */
export function worksheetLeadLabel(daysBefore: number): string {
  const days = Math.max(0, Math.round(daysBefore));
  if (days === 0) return "the due date itself";
  return `${days} ${days === 1 ? "day" : "days"} before the due date`;
}

export type WorksheetDueSoonEmailOptions = {
  to: string;
  /** Resolved display name, already falling back before it gets here. */
  name: string;
  circulationId: string;
  worksheetTitle: string;
  dueDate: Date;
  /**
   * Which of the circulation's reminder slots this send is, as its days
   * before the due date. 0 is the due day itself.
   */
  daysBefore: number;
  /** The recipient whose reminder this is, logged as the send's actor. */
  uid: string;
};

/** The subject, computed where the template computes it, so the two agree. */
export function worksheetDueSoonSubject(worksheetTitle: string): string {
  return `Due soon: ${worksheetTitle}`;
}

/**
 * One reminder. NEVER THROWS: the caller is holding a claimed marker, and an
 * exception between the claim and the stamp is the shape that turns one
 * missed email into a duplicate on a later tick.
 */
export async function sendWorksheetDueSoonEmail(
  opts: WorksheetDueSoonEmailOptions,
): Promise<WorksheetSendOutcome> {
  try {
    const subject = worksheetDueSoonSubject(opts.worksheetTitle);
    await sendEmail({
      to: opts.to,
      subject,
      fromName: "NAISI Worksheets",
      // The task kind, because a worksheet reminder is a task notification:
      // it rides the same kill switch, the same deliverability log and the
      // same push preference as everything else the task pipeline sends.
      kind: "task",
      actorUid: opts.uid,
      referenceId: opts.circulationId,
      react: WorksheetDueSoonEmail({
        recipientName: opts.name || "there",
        worksheetTitle: opts.worksheetTitle,
        dueLabel: formatWorksheetDue(opts.dueDate),
        leadLabel: worksheetLeadLabel(opts.daysBefore),
        respondLink: `${APP_URL}${worksheetRespondPath(opts.circulationId)}`,
      }),
    });
    return "sent";
  } catch (err) {
    console.error("[worksheet due-soon email] send failed", opts.circulationId, opts.uid, err);
    return "failed";
  }
}
