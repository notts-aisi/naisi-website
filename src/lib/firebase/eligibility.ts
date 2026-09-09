import "server-only";
import type { Role, SessionUser } from "@/lib/firebase/session";
import {
  canCirculateWorksheet,
  isEligibleAdmissionsReviewer,
} from "@/lib/firestore/users";

/**
 * BEING NAMED IS NOT A STANDING GRANT.
 *
 * A dozen documents in this database carry an array of uids that decides what
 * the people in it may do: a run's `trackLeadUids`, a round's `reviewerUids`,
 * a circulation's `staffUids`, a worksheet's `authorUid`. Every one of those
 * arrays is written behind a bar — the run roles route intersects with the
 * approved accounts, the round roles route runs `isEligibleAdmissionsReviewer`
 * against each candidate's live user document, a worksheet can only be created
 * by a committee member — and until this module existed not one of them was
 * checked again when the authority was USED.
 *
 * The consequence is that revoking somebody's standing revoked nothing. An
 * admin who demoted a committee member to `member`, or cleared `suRecognised`,
 * or rejected the account outright, changed one field on one user document and
 * touched no round, no run, no circulation and no worksheet. The person kept
 * every door their name was still on. There is no session to expire either:
 * `getCurrentUser` re-reads the live role on every request, so the role in
 * hand is always correct — it was simply never consulted, and
 * `POST /api/auth/session` will mint a fresh cookie for any role anyway.
 *
 * So the check moves to the point of USE, where the live session already is.
 * `firestore.rules` says the same thing in its own dialect and says why:
 *
 *     // AUTHORSHIP IS NOT A STANDING GRANT. The role test is inside this
 *     // helper rather than beside its callers because the author branch is
 *     // the one branch of read, update and delete that no other clause
 *     // re-tests
 *
 * ── HOW TO USE IT ───────────────────────────────────────────────────────────
 *
 * A gate that used to read
 *
 *     const isTrackLead = run.trackLeadUids.includes(actor.uid);
 *
 * reads
 *
 *     const isTrackLead = isNamedWithStanding(
 *       actor, "courseRuns.trackLeadUids", run.trackLeadUids,
 *     );
 *
 * and the admin branch stays where it was. Admins are deliberately NOT folded
 * in here: they are resource-independent (`isAdmin()` in the rules matches the
 * whole collection whatever the document says), every gate already writes that
 * branch, and hiding it inside a predicate named for an array would make an
 * admin look like a track lead in a stack trace.
 *
 * `tests/authority-at-use.test.mjs` walks the tree for the raw comparison and
 * fails on one that is not registered as something other than a gate, so a new
 * route that reads an authority array against its caller's own uid is covered
 * without anybody remembering that this module exists.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 *
 * It is not per-document authorisation: it answers "does this person still
 * meet the bar their appointment required", not "are they on this document".
 * Both halves are needed and `isNamedWithStanding` is the one that takes both,
 * which is why it is the function the gates call and `holdsStanding` is
 * exported mostly for the guard to execute.
 *
 * It is not a replacement for `firestore.rules`, and it is not a substitute
 * for one either. Every array below is pinned against client WRITES, but the
 * READ side is a separate question and the rules answered it with
 * `isSignedIn()` and a membership test on four of the five collections here:
 * only `worksheets` carried the role half, inside `isAuthor()`. A route that
 * refuses a rejected account is worth nothing if the browser can read the same
 * document directly, so the rules gained `isApprovedAccount()` in the same
 * change, applied inside `isCompleter()`, `isReviewer()`, `isStaff()`,
 * `isParentStaff()`, `isCollaborator()`, `isOwnEvent()`,
 * `isCourseCollaborator()`, `isOwnCourse()` and `hasPerm()`. This module is
 * the half for the routes that use the Admin SDK and therefore see no rules at
 * all; the two halves have to be read together.
 *
 * It does not clear stale membership. A demoted person stays listed in the
 * array they were appointed to, and a surface that renders the list will still
 * show their name. Removing them is an admin's act on the run or the round;
 * refusing them is this module's, and refusing is the half that has to be
 * right when nobody remembers to tidy up.
 */

/**
 * An approved account: on the roster and not waiting or refused. The floor
 * under every authority below, and the whole bar for the arrays an admin fills
 * from the approved-accounts query rather than from a narrower one.
 */
const APPROVED_ROLES: readonly Role[] = ["member", "committee", "admin"];

function isApprovedAccount(user: Pick<SessionUser, "role">): boolean {
  return APPROVED_ROLES.includes(user.role);
}

/** The library tier: `isLibraryUser()` in `firestore.rules`, in TypeScript. */
function isLibraryUser(user: Pick<SessionUser, "role">): boolean {
  return user.role === "committee" || user.role === "admin";
}

type StandingBar = {
  /** `collection.field`, exactly as the guard's scanner names it. */
  readonly field: string;
  /** The file that WRITES the array, and the bar it applies at that moment. */
  readonly appointedBy: string;
  /** The same bar, re-asked of the live session. */
  readonly test: (user: SessionUser) => boolean;
  /** Why the bar is this one and not a looser or a stricter one. */
  readonly why: string;
};

/**
 * Every stored authority a route or a server page reads against its caller's
 * own uid, with the bar that put the uid there.
 *
 * The rule for a new entry: the bar here is the bar the APPOINTMENT applies,
 * not a bar somebody would like it to be. When the two differ the appointment
 * is the bug, because a person who could be appointed today and refused
 * tomorrow is a support ticket rather than a security boundary. Where the
 * appointment bar is genuinely wide, `why` says so out loud rather than
 * pretending the narrow one is enforced somewhere else.
 */
export const AUTHORITY: Record<string, StandingBar> = {
  // ── Admission rounds ──────────────────────────────────────────────────────
  // The strictest bar in the file, and the only one where the appointment
  // route already ran a live check the use-time gates did not.
  "admissionRounds.reviewerUids": {
    field: "admissionRounds.reviewerUids",
    appointedBy:
      "src/app/api/admissions/rounds/[roundId]/roles/route.ts, via isEligibleAdmissionsReviewer",
    test: (user) => isEligibleAdmissionsReviewer(user),
    why:
      "Reviewers read applications, which are member PII plus free text about an applicant's " +
      "circumstances, so the bar is the trust boundary that already gates the users collection " +
      "and the committee task board. The roles route checks it against the candidate's live user " +
      "document; nothing clears the array when that document changes, so it is asked again here.",
  },
  "admissionRounds.finalDeciderUid": {
    field: "admissionRounds.finalDeciderUid",
    appointedBy:
      "src/app/api/admissions/rounds/[roundId]/roles/route.ts, via isEligibleAdmissionsReviewer",
    test: (user) => isEligibleAdmissionsReviewer(user),
    why:
      "The decider appoints facilitators onto a course run and mails applicants their outcome, " +
      "which is strictly more than a reviewer does, so it cannot be a looser bar than the " +
      "reviewer one it is appointed alongside.",
  },

  // ── Course runs and groups ────────────────────────────────────────────────
  // A DELIBERATELY WIDE BAR. The run roles route offers every approved account
  // and documents why ("Approved members, committee and admins - the only
  // people who may hold a course role"), so a plain member holding a run role
  // is a shipped product decision and not a hole. What was never decided is
  // that the role should survive the account: a track lead who is later
  // rejected kept the allocation board, the admissions queue, the run's
  // content, its groups and its mailing tools. That is what these entries
  // close. Raising any of the three to the SU-recognised bar is one edit to
  // `test` here plus the matching one in the roles route's candidate query.
  "courseRuns.admissionsReviewerUids": {
    field: "courseRuns.admissionsReviewerUids",
    appointedBy: "src/app/api/courses/runs/[runId]/roles/route.ts, via ELIGIBLE_ROLES",
    test: isApprovedAccount,
    why:
      "The roles route intersects the requested list with a query for role in " +
      "[member, committee, admin], so an approved account is exactly what appointment required.",
  },
  "courseRuns.trackLeadUids": {
    field: "courseRuns.trackLeadUids",
    appointedBy: "src/app/api/courses/runs/[runId]/roles/route.ts, via ELIGIBLE_ROLES",
    test: isApprovedAccount,
    why: "Same array, same route, same intersection with the approved accounts.",
  },
  "courseRuns.runFacilitatorUids": {
    field: "courseRuns.runFacilitatorUids",
    appointedBy:
      "src/app/api/courses/runs/[runId]/roles/route.ts, via ELIGIBLE_ROLES; also " +
      "src/app/api/admissions/rounds/[roundId]/decide/route.ts, which arrayUnions an " +
      "appointed applicant",
    test: isApprovedAccount,
    why:
      "The decide route adds an applicant the round appointed, and that applicant was an " +
      "approved account when they applied; the roles route applies the same intersection.",
  },
  // THE ENROLMENT IS AN AUTHORITY TOO, and it is the one the facilitators
  // route writes ALONGSIDE `courseGroups.facilitatorUids` (a `role:
  // "facilitator"` row, so that "every run you touch" is one query). The run
  // routes read it as the first of three paths to access and called it "the
  // usual one", so a floor on the other two and not on this one would be a
  // floor on the rare paths only.
  "courseEnrolments.uid": {
    field: "courseEnrolments.uid",
    appointedBy:
      "src/app/api/courses/runs/[runId]/allocation/publish/route.ts for a learner, " +
      "src/app/api/courses/groups/[groupId]/facilitators/route.ts for a facilitator",
    test: isApprovedAccount,
    why:
      "Both writers place an approved account: allocation publishes an accepted applicant, and " +
      "the facilitators route intersects with the same approved-accounts query the array does. " +
      "A withdrawn or removed enrolment already loses access the moment it is written; this is " +
      "the same rule for an account that is removed instead of a row.",
  },
  "courseGroups.facilitatorUids": {
    field: "courseGroups.facilitatorUids",
    appointedBy:
      "src/app/api/courses/groups/[groupId]/facilitators/route.ts, via ELIGIBLE_ROLES",
    test: isApprovedAccount,
    why:
      "The facilitators route intersects with the same approved-accounts query, and staffing a " +
      "group also upserts a facilitator enrolment, so the two must agree about who is eligible.",
  },

  // ── Events ────────────────────────────────────────────────────────────────
  // The bar the broadcast route already chose, applied to the rest of the
  // tree. Its wording is the reason, kept verbatim in spirit: "Being named on
  // an event is a responsibility, not a standing credential. A member demoted
  // off the committee still passes, deliberately: they are still an approved
  // member and still the person responsible for the event their name is on."
  "events.authorUid": {
    field: "events.authorUid",
    appointedBy:
      "src/app/api/events/[id]/... — the author is whoever created the event holding draftEvent",
    test: isApprovedAccount,
    why:
      "An account's name stays on every event it ever authored, and `permissions.draftEvent` is " +
      "not cleared when an account is rejected, so without this the author branch outlived the " +
      "account. Demotion off the committee deliberately does NOT revoke it: an approved member " +
      "is still the person responsible for their own event.",
  },
  "events.collaboratorUids": {
    field: "events.collaboratorUids",
    appointedBy:
      "src/app/api/events/[id]/collaborators/route.ts, intersected with committee and admins",
    test: isApprovedAccount,
    why:
      "Appointment is narrower than this (committee and admins only), but the broadcast route " +
      "settled the use-time bar for the pair on purpose and the two halves of one gate must not " +
      "disagree: a collaborator demoted to member keeps the event they are responsible for, a " +
      "rejected account keeps nothing.",
  },

  // ── Worksheets ────────────────────────────────────────────────────────────
  "worksheets.authorUid": {
    field: "worksheets.authorUid",
    appointedBy: "firestore.rules `allow create: if isLibraryUser() && authorUid == uid`",
    test: isLibraryUser,
    why:
      "The rules put the role test INSIDE isAuthor() so that a demoted or rejected author loses " +
      "read, update and delete of a document the whole committee browses. Delete moved to a route " +
      "and reproduced the authorUid half without the role half; this is that half.",
  },
  "circulations.staffUids": {
    field: "circulations.staffUids",
    appointedBy:
      "src/app/api/worksheets/circulations/route.ts — the sender (canCirculate), the worksheet's " +
      "author, and named reviewers checked with isEligibleRecipient",
    test: (user) => isLibraryUser(user) || canCirculateWorksheet(user),
    why:
      "Staff read every recipient's answers and the reviewer-only scores. Two bars put a uid in " +
      "the array (the library tier for the author and the reviewers, `circulateWorksheet` for the " +
      "sender, which a plain member may hold), so the live bar is the union of the two — " +
      "narrowing it to the library tier would lock a member-sender out of the circulation they " +
      "sent. The approved-account floor in `holdsStanding` is what keeps the permission half of " +
      "that union from admitting a rejected account that still carries the key. The consequence " +
      "worth saying out loud: revoking `circulateWorksheet` from a plain member ends their " +
      "standing on circulations they already sent, not only their ability to send more. The " +
      "circulation is never orphaned by that, because the worksheet's author is always staff and " +
      "is always committee or an admin.",
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────
  "tasks.completerUids": {
    field: "tasks.completerUids",
    appointedBy:
      "the task editor and the templates — anyone approved may be assigned, including plain " +
      "members on an assignees-only task",
    test: isApprovedAccount,
    why:
      "There is no role bar on being assigned a task and there should not be: the visibility " +
      "model puts plain members on their own tasks. The floor is the roster, so an account that " +
      "was rejected stops acting on the tasks its name is still on.",
  },
  "tasks.reviewerUids": {
    field: "tasks.reviewerUids",
    appointedBy: "the task editor and the templates, same as the completers",
    test: isApprovedAccount,
    why:
      "The other half of the same assignment, with the same floor for the same reason: a " +
      "reviewer is picked from the people already on the task rather than from a role, so the " +
      "only thing that has to survive the appointment is the account being on the roster.",
  },
};

export type Authority = keyof typeof AUTHORITY;

/**
 * Does this live session still meet the bar its appointment required?
 *
 * THE FLOOR IS APPLIED HERE, not in each entry. Every bar above is at least an
 * approved account, and two of them say so only implicitly (a `committee` role
 * carries it; a `permissions` key does NOT, because nothing clears the
 * permissions map when an account is rejected). Putting the floor in one place
 * means a new entry written as a bare permission test cannot admit a pending
 * or rejected account by omission.
 *
 * Exported for the guard, which executes each bar against every persona, and
 * for the rare gate that has already established membership some other way
 * (a query by `array-contains`, say) and needs only the standing half.
 */
export function holdsStanding(user: SessionUser, authority: Authority): boolean {
  const bar = AUTHORITY[authority];
  if (!bar) throw new Error(`Unknown authority: ${String(authority)}`);
  if (!isApprovedAccount(user)) return false;
  return bar.test(user);
}

/**
 * Is this caller named on the authority AND still standing?
 *
 * `named` is typed `unknown` on purpose. Half the gates that call this read
 * the field off a normalised document (`run.trackLeadUids`, a `string[]`) and
 * the other half read it straight off a raw snapshot (`task.completerUids`,
 * which on a legacy row may be absent or may not be an array at all). Taking
 * `unknown` and narrowing here means neither kind of call site needs a cast or
 * an `Array.isArray` guard of its own, and a field somebody hand-edited reads
 * as "not named" rather than throwing out of a gate.
 */
export function isNamedWithStanding(
  user: SessionUser,
  authority: Authority,
  named: unknown,
): boolean {
  if (!user.uid) return false;
  const isNamed =
    typeof named === "string"
      ? named === user.uid
      : Array.isArray(named) && named.includes(user.uid);
  if (!isNamed) return false;
  return holdsStanding(user, authority);
}
