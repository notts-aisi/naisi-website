import "server-only";

import {
  normaliseNotifications,
  resolveRow,
  wantsCategory,
  type NotificationCategory,
} from "@/lib/firestore/notifications";

/*
 * The server's read of a member's EMAIL switches, and the sibling of
 * `src/lib/push/preferences.ts`.
 *
 * One helper for the whole email column, so the three decisions below are made
 * once rather than per sender. Every grid-class sender calls it at the seam
 * where it already holds the recipient's user document, which is why this one
 * takes a PROFILE rather than a uid: the senders read `users/{uid}` for the
 * address and the display name anyway, and a second read per recipient to ask
 * one boolean would double the cost of every send loop on the platform.
 *
 * IT ANSWERS FOR THE EMAIL COLUMN AND NOTHING ELSE. A row has two cells and
 * they are two answers: a member who switches the email cell off and leaves
 * the push cell on has said "on my phone, not in my inbox". So a caller gates
 * its EMAIL on this and leaves its push leg alone, where `wantsPushFor` reads
 * the other cell. Skipping both on one answer would make the push column of
 * that row mean nothing.
 *
 * ABSENT IS THE DEFAULT, NOT AN ANSWER. `normaliseNotifications` resolves an
 * unwritten map through the one table in `notifications.ts`: the opt-out rows
 * (courses, tasks) come out on, the opt-in rows (newsletter, events) come out
 * off. So a member who has never opened /profile keeps receiving the task and
 * cohort mail they already receive, and is not signed up to bulk mail by
 * having an account.
 *
 * A PROFILE THAT IS NOT THERE, OR NOT AN OBJECT, IS THE ROW DEFAULT. A deleted
 * account, a document written before profiles existed, a string where a map
 * should be: none of those is a preference, and reading junk as an answer
 * would mean a corrupt field could silence somebody permanently.
 *
 * A FAILED READ IS A SEND, and this is the one place where the email column
 * deliberately parts company with the push column.
 *
 * `wantsPushFor` fails CLOSED: if Firestore cannot answer, it does not push,
 * because a dropped push loses nothing (the email it mirrors still goes) while
 * a push to somebody who switched them off is the exact thing the preference
 * exists to prevent. Neither half of that argument holds for email on an
 * OPT-OUT row. The email is not a mirror of anything, so refusing it loses the
 * message itself: a review request, a worksheet deadline, an announcement to a
 * cohort the member is enrolled in. And the member has not refused it, because
 * on an opt-out row only a stored `false` is a refusal and a failed read is not
 * a stored `false`; it is not knowing. Silencing mail somebody never refused,
 * on the strength of a transient Firestore error, is the worse of the two
 * mistakes and it is the one nobody would ever notice.
 *
 * So an unreadable preference resolves to the ROW'S DEFAULT, which sends on
 * courses and tasks and stays silent on newsletter and events. The opt-in rows
 * keep failing closed for free, because their default is off, which is the
 * right answer there for the same reason it is the wrong one on an opt-out
 * row: nobody consents to bulk mail by having their document time out.
 *
 * Today no sender reads a document only for this preference, so the failure is
 * always somebody else's read failing. The two admissions jobs are where that
 * is written down in shipping code: `resolveRecipient` in
 * `admissionsReminders.ts` and `admissionsStageRelease.ts` both catch a failed
 * `users` read and carry on with the opt-out unset, which is this rule applied
 * to the courses row. `tests/admissions-stage-release.test.mjs` pins both.
 */

/**
 * True iff this member wants email for this row, read off the stored profile.
 *
 * Pass `profile` exactly as it comes off the user document
 * (`snap.data()?.profile`). Anything that is not an object, including
 * `undefined`, resolves to the row's default.
 */
export function wantsEmailForProfile(
  profile: unknown,
  row: NotificationCategory,
): boolean {
  if (!profile || typeof profile !== "object") return resolveRow(row, undefined);
  return wantsCategory(
    normaliseNotifications(profile as { notifications?: unknown; newsletter?: unknown }),
    row,
  );
}
