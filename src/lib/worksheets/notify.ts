import "server-only";
import type { ReactElement } from "react";
import type { Firestore } from "firebase-admin/firestore";
import TaskMembershipEmail from "@/emails/TaskMembershipEmail";
import TaskReviewRequestEmail from "@/emails/TaskReviewRequestEmail";
import WorksheetFeedbackEmail from "@/emails/WorksheetFeedbackEmail";
import WorksheetUpdatedEmail from "@/emails/WorksheetUpdatedEmail";
import { sendEmail } from "@/lib/email/send";
import { resolveTaskUsers, type ResolvedUser } from "@/lib/email/taskMembership";
import { isTaskEmailEnabled } from "@/lib/firestore/taskEmailConfig";
import type { CirculationDoc, NotificationEvent } from "@/lib/firestore/circulations";
import { mirrorTaskEmailToPush } from "@/lib/push/taskNotifications";

/**
 * Every message a circulation sends, behind one function.
 *
 * ── THREE GATES, IN THIS ORDER ──────────────────────────────────────────────
 *  1. is there anybody to tell (free);
 *  2. is this circulation's switch for this event on (free, already loaded);
 *  3. is the site-wide task-email kill switch on (one Firestore read).
 * Cheapest first, so a sender who turned `copyEdited` off does not pay a read
 * every time they fix a typo. All three answer with a NAMED skip rather than a
 * silent zero, because "nobody was emailed" has four different causes and the
 * caller's log line is the only place they can be told apart.
 *
 * ── PUSH MIRRORS EMAIL, NEVER LEADS IT ──────────────────────────────────────
 * The push is sent only after its email has gone, and only when the event's
 * `push` switch is on. That is the task system's existing policy (see
 * `mirrorTaskEmailToPush`) and keeps two useful properties for free: the kill
 * switch covers push as well, and a member's volume is bounded by an email
 * budget that already exists. The consequence is worth stating: turning an
 * event's EMAIL off turns its push off too. A push-only channel would need its
 * own preference axis and its own kill switch, and nobody has asked for one.
 *
 * ── IT NEVER THROWS ─────────────────────────────────────────────────────────
 * A send that fails must not undo a circulation that was created, a response
 * that was submitted, or a batch of tasks that already exist. Every recipient
 * is attempted inside its own try/catch, and the whole dispatch sits inside
 * one more, so the worst outcome is a counted failure and a line in the logs.
 * Callers report the counts; they do not branch on them.
 *
 * ── WHAT THIS MODULE DOES NOT SEND ──────────────────────────────────────────
 * `dueSoon` alone. The due-soon reminder exists, but it is sent by the
 * scheduler job (`src/lib/scheduler/jobs/worksheetDueReminders.ts`, which ships dark
 * until an admin arms it from Site status) on its own lane, with its own
 * template (`src/emails/WorksheetDueSoonEmail.tsx`) and its own once-per-recipient
 * stamp. A caller here must never send it too, or a recipient gets the
 * reminder twice, so the case in the switch below refuses with
 * `skipped: "not-built"` rather than falling to a `default`; adding a sixth
 * event to `NotificationEvent` still fails to typecheck here until somebody
 * decides what it says and who reads it.
 *
 * ── WHERE EACH MESSAGE POINTS ───────────────────────────────────────────────
 * Three of the four built events open the RESPOND page and one opens the
 * circulation, and the split is simply who is being written to: a recipient is
 * being asked to do something with their own copy, a reviewer is being asked to
 * look at everybody's. `feedbackReturned` therefore points at the respond page
 * even though staff caused it, because the person reading it is the recipient.
 */

/** Why nothing was sent. `error` is the only one that means something broke. */
export type WorksheetNotifySkip =
  | "no-recipients"
  | "switched-off"
  | "task-emails-disabled"
  | "not-built"
  | "error";

export type WorksheetNotifyResult = {
  /** People who got the email (and the push, when that switch is on). */
  sent: number;
  /** People who could not be reached: no user document, no address, a throw. */
  failed: number;
  skipped?: WorksheetNotifySkip;
};

export type WorksheetNotifyArgs = {
  circulation: CirculationDoc;
  circulationId: string;
  event: NotificationEvent;
  /** Who to tell. De-duplicated here; the caller decides who belongs. */
  recipientUids: string[];
  /** Who caused the message. Named in the review request, logged on every send. */
  actor: { uid: string; displayName: string };
  /**
   * The task each message is ABOUT, keyed by the person RECEIVING the message:
   * for `assigned` that is their own new task, for `submitted` it is the task
   * belonging to the person whose work is now waiting. Optional because it only
   * feeds the push notification's board fallback, which is unreachable while
   * every call below passes an explicit `url` (see the push call itself).
   */
  taskIds?: Record<string, string>;
};

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://naisi.uk";

/** Where a recipient answers. Path form: also the push destination. */
function respondPath(circulationId: string): string {
  return `/worksheets/respond/${encodeURIComponent(circulationId)}`;
}

/** Where staff watch a circulation. Path form: also the push destination. */
function circulationPath(worksheetId: string, circulationId: string): string {
  return `/worksheets/${encodeURIComponent(worksheetId)}/circulations/${encodeURIComponent(circulationId)}`;
}

function uniqueUids(uids: string[]): string[] {
  const out: string[] = [];
  for (const uid of uids) {
    if (typeof uid !== "string" || !uid) continue;
    if (!out.includes(uid)) out.push(uid);
  }
  return out;
}

/**
 * One message per person, counted. The email is awaited before the push so a
 * transport failure stops both rather than pushing about mail that never went.
 */
async function sendEach(args: {
  recipients: string[];
  users: Map<string, ResolvedUser>;
  circulationId: string;
  actorUid: string;
  push: boolean;
  taskIds?: Record<string, string>;
  /** Path the email button and the push both open. Rooted, same origin. */
  path: string;
  subject: string;
  pushBody: string;
  react: (user: ResolvedUser) => ReactElement;
}): Promise<WorksheetNotifyResult> {
  let sent = 0;
  let failed = 0;
  for (const uid of args.recipients) {
    const user = args.users.get(uid);
    // No user document, or one with no address on it. Counted rather than
    // thrown: the other recipients still deserve their message.
    if (!user) {
      failed += 1;
      continue;
    }
    try {
      await sendEmail({
        to: user.email,
        subject: args.subject,
        fromName: "NAISI Worksheets",
        kind: "task",
        actorUid: args.actorUid,
        referenceId: args.circulationId,
        react: args.react(user),
      });
      if (args.push) {
        await mirrorTaskEmailToPush(uid, {
          title: args.subject,
          body: args.pushBody,
          // `taskId` feeds only the board fallback inside the mirror, and the
          // rooted `url` below always wins it, so the circulation id standing
          // in for an unknown task id can never become a link anybody follows.
          taskId: args.taskIds?.[uid] ?? args.circulationId,
          url: args.path,
        });
      }
      sent += 1;
    } catch (err) {
      console.error("[worksheets notify] send failed", args.circulationId, uid, err);
      failed += 1;
    }
  }
  return { sent, failed };
}

async function dispatch(
  db: Firestore,
  args: WorksheetNotifyArgs,
): Promise<WorksheetNotifyResult> {
  const { circulation, circulationId, event, actor, taskIds } = args;
  const recipients = uniqueUids(args.recipientUids);
  if (recipients.length === 0) return { sent: 0, failed: 0, skipped: "no-recipients" };
  if (!circulation.notifications[event].email) {
    return { sent: 0, failed: 0, skipped: "switched-off" };
  }
  if (!(await isTaskEmailEnabled(db))) {
    return { sent: 0, failed: 0, skipped: "task-emails-disabled" };
  }

  const push = circulation.notifications[event].push;
  const title = circulation.title;

  switch (event) {
    case "assigned": {
      const users = await resolveTaskUsers(db, recipients);
      const path = respondPath(circulationId);
      // The subject the template computes for itself. Passing a different one
      // would put a header on the message that disagrees with the heading
      // inside it, which is how a legitimate email starts looking like a
      // forgery in a preview pane.
      const subject = `You've been added to "${title}"`;
      return sendEach({
        recipients,
        users,
        circulationId,
        actorUid: actor.uid,
        push,
        taskIds,
        path,
        subject,
        pushBody: "Open it to start answering.",
        react: (user) =>
          TaskMembershipEmail({
            recipientName: user.displayName || "there",
            taskTitle: title,
            // Straight to the worksheet, not to the board. The task card is a
            // pointer to a document they would then have to find.
            taskLink: `${APP_URL}${path}`,
            // A worksheet task carries no subtasks and one completer, so both
            // personalisation slices of this reused template are empty by
            // construction rather than by omission.
            preassignments: [],
            otherCompleterNames: [],
          }),
      });
    }
    case "submitted": {
      const users = await resolveTaskUsers(db, recipients);
      const path = circulationPath(circulation.worksheetId, circulationId);
      const subject = `Review requested: ${title}`;
      return sendEach({
        recipients,
        users,
        circulationId,
        actorUid: actor.uid,
        push,
        taskIds,
        path,
        subject,
        pushBody: `${actor.displayName} has submitted their answers.`,
        react: (user) =>
          TaskReviewRequestEmail({
            recipientName: user.displayName || "there",
            requesterName: actor.displayName,
            taskTitle: title,
            taskLink: `${APP_URL}${path}`,
          }),
      });
    }
    case "feedbackReturned": {
      const users = await resolveTaskUsers(db, recipients);
      const path = respondPath(circulationId);
      // The template computes the same sentence for its heading. A subject that
      // disagreed with the heading inside the message is how a legitimate email
      // starts looking like a forgery in a preview pane.
      const subject = `Feedback on "${title}"`;
      return sendEach({
        recipients,
        users,
        circulationId,
        actorUid: actor.uid,
        push,
        taskIds,
        path,
        subject,
        // No feedback in the push either, for the reason the template gives:
        // a judgement about somebody's work is written for them and not for
        // whoever is looking over their shoulder at a lock screen.
        pushBody: `${actor.displayName} has written back on your answers.`,
        react: (user) =>
          WorksheetFeedbackEmail({
            recipientName: user.displayName || "there",
            worksheetTitle: title,
            reviewerName: actor.displayName,
            link: `${APP_URL}${path}`,
          }),
      });
    }
    case "copyEdited": {
      const users = await resolveTaskUsers(db, recipients);
      const path = respondPath(circulationId);
      const subject = `"${title}" has changed`;
      return sendEach({
        recipients,
        users,
        circulationId,
        actorUid: actor.uid,
        push,
        taskIds,
        path,
        subject,
        pushBody: `${actor.displayName} has changed the questions. Your answers are still there.`,
        react: (user) =>
          WorksheetUpdatedEmail({
            recipientName: user.displayName || "there",
            worksheetTitle: title,
            editorName: actor.displayName,
            link: `${APP_URL}${path}`,
          }),
      });
    }
    case "dueSoon":
      // Not sent from here. See the module comment: the scheduler job owns
      // this reminder and its once-per-recipient stamp, and a case here is
      // what stops a caller sending a second copy.
      return { sent: 0, failed: 0, skipped: "not-built" };
  }
}

export async function notifyWorksheetEvent(
  db: Firestore,
  args: WorksheetNotifyArgs,
): Promise<WorksheetNotifyResult> {
  try {
    return await dispatch(db, args);
  } catch (err) {
    // Reached when something OUTSIDE a single send fails: the kill-switch read,
    // the user lookup. The work the caller had already committed stands.
    console.error("[worksheets notify] dispatch failed", args.event, args.circulationId, err);
    return { sent: 0, failed: uniqueUids(args.recipientUids).length, skipped: "error" };
  }
}
