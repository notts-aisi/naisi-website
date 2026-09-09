/**
 * WHO THE SERVER CONTACTS IS THE SERVER'S DECISION, NEVER A LIST THE CALLER
 * WROTE.
 *
 * WHY. On 8 September 2026 the API red team found `POST /api/tasks/[id]/notify`
 * building its recipient list out of `comment.mentions`, read straight off the
 * comment document. `firestore.rules` caps that array at twenty entries and
 * says nothing about WHO may be in it, because the comment's author is the one
 * who writes it. So anybody who could reach any task, a `pending` account on a
 * personal to-do it had just created for itself included, could name twenty
 * arbitrary uids and have the server deliver a NAISI-branded email and a web
 * push carrying their own subject and body to every one of them.
 *
 * Writing this guard found two more of the same shape that the audit did not
 * name, both worse, because a subtask array is capped at nothing:
 * `send-for-review` preferred the reviewer list on the named SUBTASK over the
 * task's own, and `send-review-outcome` added every signoff row's reviewers to
 * its recipient set, both off `task.subtasks`, which sits in the narrow band
 * any completer may write and which a personal task's creator rewrites freely.
 * `send-for-review`'s own comment claimed its caller-supplied filter "stops a
 * malicious caller from emailing someone who isn't on the task at all"; the
 * filter intersected the request against a set the request had also written.
 *
 * The fix is one chokepoint, `src/lib/tasks/recipientScope.ts`, and this guard
 * is what keeps every future send inside the same sentence:
 *
 *  1. THE CHOKEPOINT, executed: the roster is `completerUids ∪ reviewerUids`,
 *     and everything else is dropped silently rather than refused, so no
 *     refusal can be read back as a question about which uids exist.
 *  2. THE THREE ROUTES, executed as an approved member on a personal task it
 *     owns and on a shared one: an off-roster uid named in a comment, in a
 *     subtask's reviewer list, or in a signoff row's reviewer list receives
 *     nothing, while the people actually on the task still do. A `pending`
 *     account is refused a step earlier, by the approved-account floor in
 *     `src/lib/firebase/eligibility.ts`, and that is pinned here too so the
 *     two layers are proved together rather than one assumed.
 *  3. THE TREE: every uid array read in a file that can send is registered
 *     with where the array comes from and, when the caller writes it, the
 *     literal that scopes it. Both directions, per-file per-field counts, a
 *     written reason each. A new recipient list fails here until somebody
 *     writes down why the caller cannot choose who it reaches.
 *
 * `tests/task-email-routes.test.mjs` is the neighbour that asks a different
 * question of the same five routes: whether the three gates that decide
 * WHETHER to send still run. This one asks who the send may reach.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./lib/tsLoader.mjs";
import { assertReadable, stripSource } from "./lib/stripSource.mjs";
import { SEND_DOOR_CALL } from "./lib/sendDoors.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/**
 * The doors a message leaves through, shared with
 * `tests/notification-classification.test.mjs` (see `tests/lib/sendDoors.mjs`).
 * This file kept its own copy until 9 September 2026, and that copy had three
 * doors missing and a fourth spelled wrong, so a route that delivers web push
 * was never opened by this scan at all.
 */
const SEND_DOORS = SEND_DOOR_CALL;

/**
 * A name that reads as "somebody a message is going to". Not `audience`, which
 * in this tree is mostly the `"user" | "guest"` field on a subscription row and
 * costs a dozen entries that answer nothing.
 */
const RECIPIENT_NAME = "mentions|uids|recipients|[a-zA-Z]+Uids|[a-zA-Z]*Emails|[a-zA-Z]*Addresses";

/**
 * FOUR SHAPES, because the first version of this scan read one and a skeptic
 * listed what it therefore could not see: `const { mentions } = comment`,
 * `comment?.mentions`, `snap.data().mentions`, a recipient named singularly in
 * a request body, and a list a route builds for itself. Each of those is one
 * bind away from the shape the routes actually use, and two of them were live
 * and unregistered when the gap was found.
 */
const MEMBER_READ = new RegExp(
  `(?:^|[^\\w.$])([A-Za-z_$][\\w$]*)\\s*\\??\\.\\s*(${RECIPIENT_NAME})\\b`,
  "g",
);
const CALL_RESULT_READ = new RegExp(`\\)\\s*\\??\\.\\s*(${RECIPIENT_NAME})\\b`, "g");
const DESTRUCTURED_READ = /(?:const|let)\s*\{([^}]*)\}\s*=\s*([A-Za-z_$][\w$]*)/g;
/** A recipient the REQUEST names, singularly. `body.uid`, `parsed.email`. */
const BODY_RECIPIENT = /\b(body|payload|parsed|json|raw|input)\s*\??\.\s*(uid|email)\b/g;
/** A list the file assembles for itself, which is where its recipients land. */
const LOCAL_LIST = /(?:const|let)\s+((?:[A-Za-z_$][\w$]*)?[Rr]ecipient[\w$]*)\s*(?::[^=]*)?=/g;

/**
 * Code only: comments gone, string bodies emptied. The string half matters
 * here, because the authority keys the eligibility chokepoint takes are
 * strings that read exactly like a field access (`"tasks.completerUids"`), so
 * a scanner that keeps strings registers a dozen gates that are not reads at
 * all and the registry stops meaning anything. `tests/lib/stripSource.mjs`
 * does it with a tokeniser rather than four regexes, for the reason written
 * out there.
 */
function codeOf(file) {
  return stripSource(readFileSync(file, "utf8"));
}

/**
 * Comment-free source WITH its strings, for checking a literal the registry
 * names. Every filter this registry points at is a call whose argument is a
 * string or a template (`rateLimit(\`resend:email:${email}\`)`), and the
 * scanner's own reading empties exactly those. Comments still go, so a gate
 * mentioned in prose does not count as a gate.
 */
function withStrings(file) {
  return stripSource(readFileSync(file, "utf8"), { keepStrings: true });
}

function* walkTs(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkTs(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

/** Every recipient source in a sending file, with how many times it is read. */
function scanRecipientSources(roots, assert) {
  const found = new Map();
  const bump = (key) => found.set(key, (found.get(key) ?? 0) + 1);
  for (const root of roots) {
    for (const file of walkTs(join(REPO_ROOT, root))) {
      const raw = readFileSync(file, "utf8");
      const source = codeOf(file);
      // A file that reads as nothing is a file this scan silently skips, which
      // is the failure mode the reader was rewritten to remove.
      assertReadable(raw, source, relative(REPO_ROOT, file), assert);
      if (!SEND_DOORS.test(source)) continue;
      const path = relative(REPO_ROOT, file).split("\\").join("/");
      let m;
      MEMBER_READ.lastIndex = 0;
      while ((m = MEMBER_READ.exec(source)) !== null) bump(`${path}#${m[1]}.${m[2]}`);
      CALL_RESULT_READ.lastIndex = 0;
      while ((m = CALL_RESULT_READ.exec(source)) !== null) bump(`${path}#().${m[1]}`);
      DESTRUCTURED_READ.lastIndex = 0;
      while ((m = DESTRUCTURED_READ.exec(source)) !== null) {
        for (const raw of m[1].split(",")) {
          const name = raw.trim().split(":")[0].trim();
          if (new RegExp(`^(?:${RECIPIENT_NAME})$`).test(name)) bump(`${path}#${m[2]}.${name}`);
        }
      }
      BODY_RECIPIENT.lastIndex = 0;
      while ((m = BODY_RECIPIENT.exec(source)) !== null) bump(`${path}#${m[1]}.${m[2]}`);
      LOCAL_LIST.lastIndex = 0;
      while ((m = LOCAL_LIST.exec(source)) !== null) bump(`${path}#local:${m[1]}`);
    }
  }
  return found;
}

/**
 * The markers that say a line is building a recipient set. A `gate` or a
 * `record` entry claims its field reaches none of them, and that claim is
 * checked against the source rather than believed.
 */
const RECIPIENT_MARKERS = [
  "recipientSet",
  "recipientList",
  "recipientUids",
  "resolveUsers(",
  "resolveTaskUsers(",
  "sendEmail(",
  "mirrorTaskEmailToPush(",
  "notifyWorksheetEvent(",
];

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Where each uid array comes from, one entry per `file#object.field`.
 *
 *  - `gate`      the read decides whether the CALLER may act. It is the
 *                authority-at-use question, and `tests/authority-at-use.test.mjs`
 *                owns it; all this file asks is that the array does not also
 *                become a recipient list. Proved by `isNamedWithStanding(` in
 *                the file and by the field reaching no recipient marker.
 *  - `roster`    a uid array on the resource itself, written somewhere the
 *                caller's own claim is not the input. `writtenBy` names that
 *                place, and a `.ts` path there must exist.
 *  - `caller`    the caller wrote it: a request body, or a document field in a
 *                band `firestore.rules` lets them write. `filteredBy` names
 *                the literal that scopes it, and that literal must be in the
 *                file. This is the class the guard exists for.
 *  - `derived`   the output of a filter applied here, or an argument handed
 *                over by a registered caller. `derivedFrom` lists the entry
 *                keys it comes from, each of which must exist.
 *  - `record`    a caller-written array that records who ACTED. It reaches no
 *                recipient set and gates nothing about the caller, and both
 *                halves of that are checked against the source.
 */
const RECIPIENT_SOURCES = new Map([
  [
    "src/app/api/admin/application-emails/send/route.ts#body.uid",
    {
      reads: 1,
      origin: "caller",
      filteredBy: "if (!isAdmin && !isSelfSubmitted)",
      why:
        "The MEMBER whose lifecycle email is being sent, named by uid. Only an admin may name " +
        "somebody else; the one other caller is a pending account naming itself. The " +
        "addresses come off that member's own user document, never off the body.",
    },
  ],
  [
    "src/app/api/admin/application-emails/send/route.ts#local:recipients",
    {
      reads: 1,
      origin: "assembled",
      sourceOutsideScan:
        "The deliverable addresses of the one member the gate above admitted, resolved from " +
        "that member's own user document rather than from the request.",
      why:
        "The deliverable addresses of the one member the gate above admitted, resolved from " +
        "their user document.",
    },
  ],
  [
    "src/app/api/admin/application-emails/send/route.ts#template.recipients",
    {
      reads: 1,
      origin: "record",
      why:
        "Which of that member's own addresses the admin-edited template writes to, personal " +
        "or university. It chooses between addresses already on the user document, and names " +
        "nobody.",
    },
  ],
  [
    "src/app/api/admissions/rounds/[roundId]/decide/route.ts#local:recipient",
    {
      reads: 1,
      origin: "assembled",
      sourceOutsideScan:
        "The uid comes off the `admissionApplications` row named in the request, which the " +
        "decide gate has already checked belongs to this round. Nothing in that path carries " +
        "a recipient-shaped name for the scan to find, and there is no list: it is one person.",
      why:
        "The one applicant whose appointment is being decided, read from the application row " +
        "the decision is about.",
    },
  ],
  [
    "src/app/api/courses/groups/[groupId]/attendance/push/route.ts#local:recipients",
    {
      reads: 1,
      origin: "assembled",
      sourceOutsideScan:
        "Built from the group's own `courseEnrolments` rows by a query this route runs, and " +
        "each uid comes off a document id rather than a recipient-shaped field, so there is " +
        "nothing for the scan to name as its source.",
      why:
        "The members of the group whose register is being taken, resolved from its enrolment " +
        "rows and never from anything the request carried.",
    },
  ],
  [
    "src/app/api/courses/groups/[groupId]/email/route.ts#group.facilitatorUids",
    {
      reads: 1,
      origin: "gate",
      why:
        "Whether the CALLER facilitates this group. The audience is the group's roster, read " +
        "from the enrolment rows.",
    },
  ],
  [
    "src/app/api/courses/groups/[groupId]/email/route.ts#local:recipients",
    {
      reads: 1,
      origin: "assembled",
      sourceOutsideScan:
        "Built from the group's own `courseEnrolments` rows by a query this route runs, with " +
        "each uid coming off a document id rather than off a recipient-shaped field.",
      why:"The group's members, built from its enrolment rows by a query this route runs.",
    },
  ],
  [
    "src/app/api/courses/groups/[groupId]/notice/route.ts#group.facilitatorUids",
    {
      reads: 1,
      origin: "gate",
      why:"The same question about the caller, on the notice lane rather than the ordinary one.",
    },
  ],
  [
    "src/app/api/courses/groups/[groupId]/notice/route.ts#local:recipients",
    {
      reads: 1,
      origin: "assembled",
      sourceOutsideScan:
        "The same enrolment-derived roster as the ordinary group email, on the notice lane, " +
        "built the same way from document ids.",
      why:
        "The same enrolment-derived roster, on the notice lane, under its own visible marker " +
        "and cap.",
    },
  ],
  [
    "src/app/api/courses/runs/[runId]/allocation/publish/route.ts#group.facilitatorUids",
    {
      reads: 2,
      origin: "roster",
      writtenBy: "src/app/api/courses/groups/[groupId]/facilitators/route.ts",
      why:
        "The facilitators of the group an accepted applicant lands in, added to the audience " +
        "so the people running a session are told who is joining it, and named in the email " +
        "body.",
    },
  ],
  [
    "src/app/api/courses/runs/[runId]/allocation/publish/route.ts#run.trackLeadUids",
    {
      reads: 1,
      origin: "gate",
      why:"Whether the CALLER may publish an allocation. Not an audience.",
    },
  ],
  [
    "src/app/api/courses/runs/[runId]/applications/[uid]/decide/route.ts#run.admissionsReviewerUids",
    {
      reads: 1,
      origin: "gate",
      why:
        "Whether the CALLER may decide this application. The applicant is the recipient, and " +
        "they come from the row being decided.",
    },
  ],
  [
    "src/app/api/courses/runs/[runId]/email/route.ts#local:recipients",
    {
      reads: 1,
      origin: "assembled",
      sourceOutsideScan:
        "Resolved by the shared cohort-audience helper from the run's own enrolment rows. The " +
        "uids come off document ids inside that helper, so this file names no source the scan " +
        "can see.",
      why:
        "The run's members, resolved by the shared cohort-audience helper from enrolment " +
        "rows.",
    },
  ],
  [
    "src/app/api/courses/runs/[runId]/enrol/route.ts#data.completerUids",
    {
      reads: 2,
      origin: "record",
      why:
        "Read off an existing mirrored task to ask whether this member is already on it, so a " +
        "re-sync does not duplicate one. Not a recipient list.",
    },
  ],
  [
    "src/app/api/courses/runs/[runId]/nudge/route.ts#local:recipients",
    {
      reads: 1,
      origin: "assembled",
      sourceOutsideScan:
        "The same shared cohort-audience helper as the run email route beside it, over the " +
        "same enrolment rows, with the uids coming off document ids rather than off a field.",
      why:
        "The weekly nudge's audience, resolved the same way from the run's own enrolment " +
        "rows.",
    },
  ],
  [
    "src/app/api/events/[id]/broadcast/route.ts#event.collaboratorUids",
    {
      reads: 2,
      origin: "gate",
      why:
        "Whether the CALLER may broadcast about this event. The audience is a query over " +
        "`eventRsvps`, never this array.",
    },
  ],
  [
    "src/app/api/events/[id]/rsvp/route.ts#payload.email",
    {
      reads: 2,
      origin: "caller",
      filteredBy: "verifyRecaptcha(recaptchaToken)",
      why:
        "A stranger types the address their own confirmation goes to, which is what an RSVP " +
        "is. Until 9 September 2026 nothing stood between that and the send: it now carries a " +
        "per-IP throttle, reCAPTCHA, and a per-address throttle behind the captcha.",
    },
  ],
  [
    "src/app/api/newsletter/[id]/send/route.ts#local:recipients",
    {
      reads: 1,
      origin: "assembled",
      sourceOutsideScan:
        "A query this route runs over `subscriptions` for the confirmed, subscribed rows of " +
        "the newsletter channel. The addresses come off those documents, not off the request.",
      why:
        "The confirmed, subscribed rows of the newsletter channel, from a query this route " +
        "runs over `subscriptions`.",
    },
  ],
  [
    "src/app/api/register/resend/route.ts#body.email",
    {
      reads: 1,
      origin: "caller",
      filteredBy: "rateLimit(`resend:email:${email}`",
      why:
        "The same address again, and no captcha, which is a decision rather than an " +
        "oversight: this route can only ever mail an address that already holds an unverified " +
        "registration row, so it addresses nobody new.",
    },
  ],
  [
    "src/app/api/register/route.ts#body.email",
    {
      reads: 1,
      origin: "caller",
      filteredBy: "verifyRecaptcha(recaptchaToken)",
      why:
        "A stranger types the address the verification link goes to, which is what " +
        "registering is. Gated by reCAPTCHA and by throttles on both the address and the " +
        "connection.",
    },
  ],
  [
    "src/app/api/subscriptions/route.ts#parsed.email",
    {
      reads: 2,
      origin: "caller",
      filteredBy: "rateLimit(`subscriptions:ip:${ip}`",
      why:
        "The public subscribe form's address, with a per-IP throttle and a sixty-second " +
        "per-address cooldown but no captcha. Recorded rather than blessed: a captcha here is " +
        "on the hardening queue, and `tests/public-write-gating.test.mjs` carries the same " +
        "note.",
    },
  ],
  [
    "src/app/api/tasks/[id]/notify-member/route.ts#local:recipient",
    {
      reads: 1,
      origin: "assembled",
      why:"The single resolved user, looked up from the uid the refusal above already bounded.",
    },
  ],
  [
    "src/app/api/tasks/[id]/notify-member/route.ts#payload.uid",
    {
      reads: 2,
      origin: "caller",
      filteredBy: "if (!onTask)",
      why:
        "The one uid the request names. It is refused unless it is on the task, before " +
        "anything is composed, which is the shape the other three routes should have had from " +
        "the start.",
    },
  ],
  [
    "src/app/api/tasks/[id]/notify-member/route.ts#task.completerUids",
    {
      reads: 1,
      origin: "roster",
      writtenBy: "src/features/tasks/taskMutations.ts",
      why:"One half of the `onTask` refusal that bounds the uid above.",
    },
  ],
  [
    "src/app/api/tasks/[id]/notify-member/route.ts#task.pendingNotifyUids",
    {
      reads: 1,
      origin: "roster",
      writtenBy: "src/features/tasks/taskMutations.ts",
      why:
        "The per-uid queue the Notify button empties, read AFTER the `onTask` refusal, so " +
        "even on a personal task whose creator may write this field freely the only uid it " +
        "carries through is one already on the roster.",
    },
  ],
  [
    "src/app/api/tasks/[id]/notify-member/route.ts#task.reviewerUids",
    {
      reads: 1,
      origin: "roster",
      writtenBy: "src/features/tasks/taskMutations.ts",
      why:
        "The other half of the same refusal: a uid in either array passes, a uid in neither " +
        "is refused before a message is composed.",
    },
  ],
  [
    "src/app/api/tasks/[id]/notify/route.ts#comment.mentions",
    {
      reads: 1,
      origin: "caller",
      filteredBy: "onTaskRoster(comment.mentions, task)",
      why:
        "The comment's author writes `mentions` and the rules cap only its size, so before " +
        "the filter this route was an outbound mailer with a caller-chosen recipient list. " +
        "The composer offers the task roster and nothing else.",
    },
  ],
  [
    "src/app/api/tasks/[id]/notify/route.ts#local:recipientUids",
    {
      reads: 1,
      origin: "assembled",
      why:
        "The keys of `reasonByUid`, which is the filtered mentions plus, on request, the two " +
        "roster arrays above. Every uid in it came from one of them.",
    },
  ],
  [
    "src/app/api/tasks/[id]/notify/route.ts#task.completerUids",
    {
      reads: 3,
      origin: "roster",
      writtenBy: "src/features/tasks/taskMutations.ts",
      why:
        "The task's own completer list: the access gate, and the recipients of a " +
        "forceEmailCompleters notify. A member may only ever put themselves in it.",
    },
  ],
  [
    "src/app/api/tasks/[id]/notify/route.ts#task.reviewerUids",
    {
      reads: 3,
      origin: "roster",
      writtenBy: "src/features/tasks/taskMutations.ts",
      why:
        "The same array on the other side of the task, pinned empty on a personal task by " +
        "both the create and the update rule.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-for-review/route.ts#payload.reviewerUids",
    {
      reads: 2,
      origin: "caller",
      filteredBy: "requestedReviewerUids.filter((u) => allowed.has(u))",
      why:
        "The request's own narrowing, so one reviewer can be asked rather than all of them. " +
        "It is intersected with the computed set, which is now itself roster-scoped: before " +
        "that it narrowed one caller-written list by another.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-for-review/route.ts#s.reviewerUids",
    {
      reads: 1,
      origin: "caller",
      filteredBy: "onTaskRoster(s.reviewerUids, task)",
      why:
        "A subtask's reviewer list, read out of `task.subtasks`, which sits in the narrow " +
        "band every completer may write and which a personal task's creator rewrites freely. " +
        "Uncapped, so it was a wider door than `mentions` ever was.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-for-review/route.ts#subtaskInfo.reviewerUids",
    {
      reads: 2,
      origin: "derived",
      derivedFrom: [
        "src/app/api/tasks/[id]/send-for-review/route.ts#s.reviewerUids",
      ],
      why:
        "`findSubtask`'s return value, which is the filtered list. Registered separately so a " +
        "future reader that skips `findSubtask` cannot inherit its entry.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-for-review/route.ts#task.completerUids",
    {
      reads: 1,
      origin: "gate",
      why:
        "The access gate only. Completers are not recipients of a review request: the people " +
        "asked to review are.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-for-review/route.ts#task.reviewerUids",
    {
      reads: 3,
      origin: "roster",
      writtenBy: "src/features/tasks/taskMutations.ts",
      why:
        "The task-level reviewer list, the fallback when the subtask names none, and the " +
        "access gate. Pinned empty on a personal task by firestore.rules.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-initial-notifications/route.ts#local:recipientList",
    {
      reads: 1,
      origin: "assembled",
      why:"The union of the two roster arrays above, de-duplicated. Nothing else can enter it.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-initial-notifications/route.ts#task.completerUids",
    {
      reads: 1,
      origin: "roster",
      writtenBy: "src/features/tasks/taskMutations.ts",
      why:
        "Everyone the task was assigned to, told once that they are on it. The route reads no " +
        "subcollection and no request-supplied list at all.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-initial-notifications/route.ts#task.reviewerUids",
    {
      reads: 1,
      origin: "roster",
      writtenBy: "src/features/tasks/taskMutations.ts",
      why:
        "The other half of the same one-off announcement, read from the task document rather " +
        "than from anything the request carried.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-review-outcome/route.ts#local:recipientList",
    {
      reads: 1,
      origin: "assembled",
      why:"The same set as an array, which is what the send loop walks.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-review-outcome/route.ts#local:recipientSet",
    {
      reads: 1,
      origin: "assembled",
      why:
        "The task's completers, its reviewers, and the filtered reviewers of each signoff row " +
        "on the block, minus the actor.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-review-outcome/route.ts#s.approvedByReviewerUids",
    {
      reads: 3,
      origin: "record",
      why:
        "Who approved a row. Compared against the filtered reviewer list to decide whether " +
        "the block is done; never added to a recipient set.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-review-outcome/route.ts#s.questionedByReviewerUids",
    {
      reads: 2,
      origin: "record",
      why:
        "Who raised an outstanding question on a row. Read only to refuse sending an outcome " +
        "while one is open.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-review-outcome/route.ts#s.rejectedByReviewerUids",
    {
      reads: 3,
      origin: "record",
      why:"Who rejected a row. Read only to sort the row into the email's rejected list.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-review-outcome/route.ts#s.reviewerUids",
    {
      reads: 5,
      origin: "caller",
      filteredBy: "reviewerUids: onTaskRoster(s.reviewerUids, task)",
      why:
        "The same subtask array, deciding three things at once: who this route mails, whether " +
        "the block's reviews are complete, and whether the CALLER may press the button. " +
        "Filtered once where the rows are read, so all three ask the roster.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-review-outcome/route.ts#task.completerUids",
    {
      reads: 2,
      origin: "roster",
      writtenBy: "src/features/tasks/taskMutations.ts",
      why:
        "The access gate, and the recipients: everybody who did the work is told the review " +
        "outcome.",
    },
  ],
  [
    "src/app/api/tasks/[id]/send-review-outcome/route.ts#task.reviewerUids",
    {
      reads: 2,
      origin: "roster",
      writtenBy: "src/features/tasks/taskMutations.ts",
      why:"The task-level reviewers, the other half of the recipient set, and the access gate.",
    },
  ],
  [
    "src/app/api/verify-email/send/route.ts#body.email",
    {
      reads: 1,
      origin: "caller",
      filteredBy: "rateLimit(`verify-email-send:ip:${ip}`",
      why:
        "The university address an account claims. Throttled per connection and per actor " +
        "since 9 September 2026, and the proof it starts can only ever be completed by the " +
        "account that started it.",
    },
  ],
  [
    "src/app/api/worksheets/circulations/[circulationId]/notify-copy-edited/route.ts#local:recipientUids",
    {
      reads: 1,
      origin: "assembled",
      sourceOutsideScan:
        "Built by walking the circulation's own `responses` subcollection and taking each " +
        "document id. The server queried it; nothing in the request names anybody.",
      why:
        "Built by walking the circulation's own `responses` subcollection and taking each " +
        "document's id. The server queried it; nothing in the request names anybody.",
    },
  ],
  [
    "src/app/api/worksheets/circulations/[circulationId]/recipients/route.ts#body.recipientUids",
    {
      reads: 1,
      origin: "caller",
      filteredBy: "isEligibleRecipient(",
      why:
        "Adding recipients to a circulation that is already out, gated on " +
        "`circulateWorksheet` and filtered against live user documents exactly as the create " +
        "is.",
    },
  ],
  [
    "src/app/api/worksheets/circulations/[circulationId]/recipients/route.ts#local:recipients",
    {
      reads: 1,
      origin: "assembled",
      why:"The parsed body list before that filter, the object the read above comes off.",
    },
  ],
  [
    "src/app/api/worksheets/circulations/[circulationId]/recipients/route.ts#recipients.uids",
    {
      reads: 2,
      origin: "derived",
      derivedFrom: [
        "src/app/api/worksheets/circulations/[circulationId]/recipients/route.ts#body.recipientUids",
      ],
      why:"The parsed body list, read to look up roles and then reduced to `eligible`.",
    },
  ],
  [
    "src/app/api/worksheets/circulations/[circulationId]/submit/route.ts#circulation.reviewerUids",
    {
      reads: 1,
      origin: "roster",
      writtenBy: "src/app/api/worksheets/circulations/route.ts",
      why:
        "The staff on the circulation, told a response came in. The document has no client " +
        "create path, and this array was filtered when it was written.",
    },
  ],
  [
    "src/app/api/worksheets/circulations/[circulationId]/submit/route.ts#outcome.reviewerUids",
    {
      reads: 2,
      origin: "derived",
      derivedFrom: [
        "src/app/api/worksheets/circulations/[circulationId]/submit/route.ts#circulation.reviewerUids",
      ],
      why:
        "The same staff array, carried out of the transaction minus the submitter themselves, " +
        "so a recipient who is also staff is not told about their own submission.",
    },
  ],
  [
    "src/app/api/worksheets/circulations/route.ts#body.recipientUids",
    {
      reads: 1,
      origin: "caller",
      filteredBy: "isEligibleRecipient(",
      why:
        "Circulating a worksheet IS choosing who receives it, so the list arrives in the body " +
        "by design. The caller holds `circulateWorksheet`, and every uid is checked against " +
        "its live user document before a task is minted for it.",
    },
  ],
  [
    "src/app/api/worksheets/circulations/route.ts#body.reviewerUids",
    {
      reads: 1,
      origin: "caller",
      filteredBy: "ineligibleReviewer",
      why:
        "The staff the sender names beside themselves. A named uid that fails the live " +
        "library-tier check refuses the whole request rather than being dropped, because a " +
        "circulation created with a reviewer silently missing is a queue nobody empties.",
    },
  ],
  [
    "src/app/api/worksheets/circulations/route.ts#local:recipients",
    {
      reads: 1,
      origin: "assembled",
      why:
        "The parsed body list before the eligibility filter, which is the object the two " +
        "reads above come off.",
    },
  ],
  [
    "src/app/api/worksheets/circulations/route.ts#recipients.uids",
    {
      reads: 1,
      origin: "derived",
      derivedFrom: [
        "src/app/api/worksheets/circulations/route.ts#body.recipientUids",
      ],
      why:
        "The parsed body list, read to look up each uid's live role before the eligibility " +
        "filter reduces it to `eligible`.",
    },
  ],
  [
    "src/lib/email/courseFacilitatorEmails.ts#run.runFacilitatorUids",
    {
      reads: 1,
      origin: "gate",
      why:"Whether the CALLER may address a whole run. Not an audience.",
    },
  ],
  [
    "src/lib/email/courseFacilitatorEmails.ts#run.trackLeadUids",
    {
      reads: 1,
      origin: "gate",
      why:
        "The other half of the same question about the caller: a track lead may address the " +
        "run they lead.",
    },
  ],
  [
    "src/lib/email/eventAnnouncement.ts#audience.recipients",
    {
      reads: 1,
      origin: "derived",
      derivedFrom: [
        "src/lib/email/eventAnnouncement.ts#local:recipients",
      ],
      sourceOutsideScan:
        "Built here from a query over the events notification row and, for a public event, " +
        "the guest subscriptions. Nothing in a request reaches it.",
      why:
        "The announcement audience, resolved from the subscriptions and members queries this " +
        "module runs for itself.",
    },
  ],
  [
    "src/lib/email/eventAnnouncement.ts#local:recipients",
    {
      reads: 1,
      origin: "assembled",
      why:
        "Built here from a query over the events notification row and, for a public event, " +
        "the guest subscriptions. Nothing in a request reaches it.",
    },
  ],
  [
    "src/lib/email/send.ts#local:recipients",
    {
      reads: 1,
      origin: "assembled",
      sourceOutsideScan:
        "This is the transport. The `to` field arrives already decided by whichever caller " +
        "above chose it, and normalising a string into an array names nobody new.",
      why:
        "The transport's own normalisation of the `to` field it was handed. It chooses " +
        "nobody: every caller above decided that already.",
    },
  ],
  [
    "src/lib/push/rowAudience.ts#owners.uids",
    {
      reads: 1,
      origin: "roster",
      writtenBy: "src/lib/push/rowAudience.ts",
      why:
        "The audience of a notification ROW, built here by querying who has that row's push " +
        "cell switched on. Nothing in a request reaches it.",
    },
  ],
  [
    "src/lib/scheduler/jobs/eventAnnouncements.ts#audience.recipients",
    {
      reads: 1,
      origin: "derived",
      derivedFrom: [
        "src/lib/email/eventAnnouncement.ts#local:recipients",
      ],
      why:
        "The same audience, consumed by the job that delivers a queued announcement one " +
        "marker-claimed recipient at a time.",
    },
  ],
  [
    "src/lib/scheduler/jobs/eventAnnouncements.ts#local:recipientKey",
    {
      reads: 2,
      origin: "assembled",
      sourceOutsideScan:
        "A per-recipient marker key, so a job that dies mid-send resumes without telling " +
        "anybody twice. It names a recipient the audience above already chose.",
      why:
        "A per-recipient marker key, so a job that dies mid-send resumes without telling " +
        "anybody twice. It names a recipient the audience above already chose.",
    },
  ],
  [
    "src/lib/scheduler/jobs/eventAnnouncements.ts#owners.uids",
    {
      reads: 1,
      origin: "derived",
      derivedFrom: [
        "src/lib/push/rowAudience.ts#owners.uids",
      ],
      why:
        "The push half of the same audience, built by the row-audience helper rather than by " +
        "anything in a request.",
    },
  ],
  [
    "src/lib/worksheets/notify.ts#args.recipientUids",
    {
      reads: 2,
      origin: "derived",
      derivedFrom: [
        "src/app/api/worksheets/circulations/route.ts#body.recipientUids",
        "src/app/api/worksheets/circulations/[circulationId]/recipients/route.ts#body.recipientUids",
      ],
      why:
        "The shared notify helper takes a finished list. Its callers are the routes above, " +
        "all of which filtered before minting a task for each uid.",
    },
  ],
  [
    "src/lib/worksheets/notify.ts#args.recipients",
    {
      reads: 1,
      origin: "derived",
      derivedFrom: [
        "src/lib/worksheets/notify.ts#args.recipientUids",
      ],
      why:"The same list under the other name the argument object carries it as.",
    },
  ],
  [
    "src/lib/worksheets/notify.ts#local:recipients",
    {
      reads: 1,
      origin: "assembled",
      why:"The de-duplicated form of the argument above, which is what the send loop walks.",
    },
  ],
]);

// ---------------------------------------------------------------------------
// 1. The chokepoint, executed
// ---------------------------------------------------------------------------

const { loadTs: loadChokepoint } = createLoader({
  stubs: new Map([["server-only", "export {};"]]),
});
const { taskRoster, onTaskRoster } = await loadChokepoint("lib/tasks/recipientScope.ts");

describe("the chokepoint", () => {
  const task = { completerUids: ["doer1", "doer2"], reviewerUids: ["rev1", "doer1"] };

  test("the roster is both arrays, as one set", () => {
    assert.deepEqual([...taskRoster(task)].sort(), ["doer1", "doer2", "rev1"]);
    assert.deepEqual([...taskRoster({})], []);
    assert.deepEqual([...taskRoster({ completerUids: "nope", reviewerUids: null })], []);
  });

  test("an off-roster uid is dropped and an on-roster one is kept, in order", () => {
    assert.deepEqual(onTaskRoster(["rev1", "stranger", "doer2"], task), ["rev1", "doer2"]);
    assert.deepEqual(onTaskRoster(["stranger", "nobody"], task), []);
  });

  test("duplicates and non-strings cannot inflate the list", () => {
    assert.deepEqual(onTaskRoster(["doer1", "doer1", 7, null, "", "doer1"], task), ["doer1"]);
    assert.deepEqual(onTaskRoster("doer1", task), []);
    assert.deepEqual(onTaskRoster(undefined, task), []);
  });

  test("a personal task admits only its own creator", () => {
    const personal = { completerUids: ["me"], reviewerUids: [] };
    assert.deepEqual(onTaskRoster(["victim1", "victim2", "me"], personal), ["me"]);
  });
});

// ---------------------------------------------------------------------------
// 2. The three routes, executed
// ---------------------------------------------------------------------------

/** Every `serverTimestamp()` in this file resolves to this instant. */
const STAMP = new Date("2026-09-09T09:00:00Z");

const ROUTE_STUBS = new Map([
  ["server-only", "export {};"],
  [
    "next/server",
    "export const NextResponse = {\n" +
      "  json(body, init) {\n    return { status: (init && init.status) || 200, body };\n  },\n};",
  ],
  [
    "firebase-admin/firestore",
    "export const FieldValue = {\n" +
      "  serverTimestamp: () => ({ __op: 'serverTimestamp' }),\n" +
      "  arrayRemove: (...values) => ({ __op: 'arrayRemove', values }),\n};\n" +
      "export const Timestamp = { fromDate: (date) => ({ __ts: date }) };",
  ],
  ["@/lib/firebase/admin", "export function getAdminDb() {\n  return globalThis.__db;\n}"],
  [
    "@/lib/firebase/session",
    "export async function getCurrentUser() {\n  return globalThis.__viewer;\n}",
  ],
  [
    "@/lib/email/send",
    "export async function sendEmail(args) {\n  (globalThis.__sent ||= []).push(args);\n}",
  ],
  [
    "@/lib/push/taskNotifications",
    "export async function mirrorTaskEmailToPush(uid, payload) {\n" +
      "  (globalThis.__pushed ||= []).push({ uid, ...payload });\n}",
  ],
  [
    "@/lib/firestore/taskEmailConfig",
    "export async function isTaskEmailEnabled() {\n  return true;\n}",
  ],
]);

const { loadTs } = createLoader({ stubs: ROUTE_STUBS });

/** A Firestore small enough to read: addressed documents, `getAll`, subcollection queries. */
function makeDb(seed) {
  const docs = new Map(Object.entries(seed).map(([path, data]) => [path, { ...data }]));
  const snapshot = (path) => {
    const data = docs.get(path);
    return {
      id: path.split("/").pop(),
      path,
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : { ...data }),
    };
  };
  const query = (path, filters) => ({
    where: (field, op, value) => query(path, [...filters, [field, op, value]]),
    async get() {
      const out = [];
      for (const [docPath, data] of docs) {
        if (!docPath.startsWith(`${path}/`)) continue;
        if (docPath.slice(path.length + 1).includes("/")) continue;
        const ok = filters.every(([field, op, value]) => {
          const actual = (data ?? {})[field];
          if (op === "in") return Array.isArray(value) && value.includes(actual);
          if (op === ">=") return true; // no test here turns on a time bound
          return actual === value;
        });
        if (ok) out.push(snapshot(docPath));
      }
      return { docs: out, empty: out.length === 0, size: out.length };
    },
  });
  let added = 0;
  const collectionRef = (path) => ({
    path,
    doc: (id) => docRef(`${path}/${id}`),
    async add(data) {
      added += 1;
      docs.set(`${path}/auto${added}`, { ...data });
      return docRef(`${path}/auto${added}`);
    },
    ...query(path, []),
  });
  const docRef = (path) => ({
    id: path.split("/").pop(),
    path,
    collection: (name) => collectionRef(`${path}/${name}`),
    async get() {
      return snapshot(path);
    },
    async update(patch) {
      const next = { ...(docs.get(path) ?? {}) };
      for (const [key, value] of Object.entries(patch)) {
        next[key] = value && value.__op === "serverTimestamp" ? STAMP : value;
      }
      docs.set(path, next);
    },
  });
  const apply = (path, patch) => {
    const next = { ...(docs.get(path) ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = value && value.__op === "serverTimestamp" ? STAMP : value;
    }
    docs.set(path, next);
  };
  return {
    docs,
    collection: collectionRef,
    async getAll(...refs) {
      return refs.map((ref) => snapshot(ref.path));
    },
    async runTransaction(body) {
      const writes = [];
      const result = await body({
        get: async (ref) => snapshot(ref.path),
        set: (ref, patch) => writes.push([ref.path, patch]),
        update: (ref, patch) => writes.push([ref.path, patch]),
      });
      for (const [path, patch] of writes) apply(path, patch);
      return result;
    },
  };
}

const TASKS = join("app", "api", "tasks", "[id]");
const { POST: notify } = await loadTs(join(TASKS, "notify", "route.ts"));
const { POST: sendForReview } = await loadTs(join(TASKS, "send-for-review", "route.ts"));
const { POST: sendReviewOutcome } = await loadTs(join(TASKS, "send-review-outcome", "route.ts"));

const ctx = (id) => ({ params: Promise.resolve({ id }) });
const jsonRequest = (body) => ({ json: async () => body });

/** Four accounts, three of them strangers to whatever task is under test. */
function people() {
  const person = (uid, name) => ({ uid, email: `${uid}@example.com`, displayName: name });
  return {
    "users/attacker": person("attacker", "Mal"),
    "users/victim1": person("victim1", "Vic One"),
    "users/victim2": person("victim2", "Vic Two"),
    "users/mate": person("mate", "Team Mate"),
  };
}

function reset() {
  globalThis.__sent = [];
  globalThis.__pushed = [];
}

const addressed = () => (globalThis.__sent ?? []).map((m) => m.to).sort();
const pushedTo = () => (globalThis.__pushed ?? []).map((m) => m.uid).sort();

describe("the mention list cannot name somebody who is not on the task", () => {
  test("a pending account does not reach the route at all", async () => {
    reset();
    globalThis.__viewer = { uid: "attacker", role: "pending", suRecognised: false };
    globalThis.__db = makeDb({
      ...people(),
      "tasks/t0": {
        title: "x",
        source: "personal",
        visibility: "assignees-only",
        creatorUid: "attacker",
        completerUids: ["attacker"],
        reviewerUids: [],
      },
      "tasks/t0/comments/c1": { authorUid: "attacker", bodyMarkdown: ".", mentions: ["victim1"] },
    });
    const res = await notify(jsonRequest({ commentId: "c1" }), ctx("t0"));
    assert.equal(res.status, 403, "the approved-account floor is the outer layer here");
    assert.deepEqual(addressed(), []);
  });

  test("an approved member's personal to-do reaches nobody but itself", async (t) => {
    reset();
    globalThis.__viewer = { uid: "attacker", role: "member", suRecognised: false };
    globalThis.__db = makeDb({
      ...people(),
      "tasks/t1": {
        title: "Your NAISI account needs re-verification",
        source: "personal",
        visibility: "assignees-only",
        creatorUid: "attacker",
        completerUids: ["attacker"],
        reviewerUids: [],
      },
      "tasks/t1/comments/c1": {
        authorUid: "attacker",
        bodyMarkdown: "Confirm at naisi-verify.example",
        mentions: ["victim1", "victim2"],
      },
    });
    const res = await notify(jsonRequest({ commentId: "c1" }), ctx("t1"));
    t.diagnostic(JSON.stringify(res.body));
    assert.deepEqual(addressed(), [], "an off-roster uid was emailed");
    assert.deepEqual(pushedTo(), [], "an off-roster uid was pushed to");
    assert.equal(res.body.skipped, "no recipients");
  });

  test("a real mention on a shared task still lands, and only that one", async () => {
    reset();
    globalThis.__viewer = { uid: "attacker", role: "member", suRecognised: false };
    globalThis.__db = makeDb({
      ...people(),
      "tasks/t2": {
        title: "Term plan",
        source: "committee",
        visibility: "assignees-only",
        creatorUid: "mate",
        completerUids: ["attacker", "mate"],
        reviewerUids: [],
      },
      "tasks/t2/comments/c1": {
        authorUid: "attacker",
        bodyMarkdown: "@Team Mate could you look?",
        mentions: ["mate", "victim1", "victim2"],
      },
    });
    await notify(jsonRequest({ commentId: "c1" }), ctx("t2"));
    assert.deepEqual(addressed(), ["mate@example.com"]);
    assert.deepEqual(pushedTo(), ["mate"]);
  });
});

describe("a subtask's reviewer list cannot name somebody who is not on the task", () => {
  test("send-for-review refuses a forged subtask reviewer list", async () => {
    reset();
    globalThis.__viewer = { uid: "attacker", role: "member", suRecognised: false };
    globalThis.__db = makeDb({
      ...people(),
      "tasks/t3": {
        title: "Action required on your membership",
        source: "personal",
        visibility: "assignees-only",
        creatorUid: "attacker",
        completerUids: ["attacker"],
        reviewerUids: [],
        subtasks: [
          {
            id: "s1",
            title: "Confirm your details at naisi-verify.example",
            reviewerUids: ["victim1", "victim2"],
          },
        ],
      },
    });
    const res = await sendForReview(jsonRequest({ subtaskId: "s1" }), ctx("t3"));
    assert.deepEqual(addressed(), [], "a forged subtask reviewer was emailed");
    assert.deepEqual(pushedTo(), [], "a forged subtask reviewer was pushed to");
    assert.equal(res.status, 400, "the route should find no reviewer to notify");
  });

  test("a real subtask reviewer on a shared task is still asked", async () => {
    reset();
    globalThis.__viewer = { uid: "attacker", role: "member", suRecognised: false };
    globalThis.__db = makeDb({
      ...people(),
      "tasks/t4": {
        title: "Term plan",
        source: "committee",
        visibility: "assignees-only",
        creatorUid: "mate",
        completerUids: ["attacker"],
        reviewerUids: ["mate"],
        subtasks: [{ id: "s1", title: "Draft the agenda", reviewerUids: ["mate", "victim1"] }],
      },
    });
    await sendForReview(jsonRequest({ subtaskId: "s1" }), ctx("t4"));
    assert.deepEqual(addressed(), ["mate@example.com"]);
  });
});

describe("a signoff row's reviewer list cannot name somebody who is not on the task", () => {
  /** A sealed block with one completion row and one signoff row, both decided. */
  function block(signoffReviewers) {
    return {
      blocks: [
        { id: "b1", name: "Week one", sealState: "sealed", sealedAt: null, reviewPassSentAt: null },
      ],
      subtasks: [
        {
          id: "s1",
          blockId: "b1",
          title: "Draft the agenda",
          roleHint: "completer",
          reviewerUids: [],
          approvedByReviewerUids: [],
          questionedByReviewerUids: [],
          rejectedByReviewerUids: [],
          done: true,
        },
        {
          id: "s2",
          blockId: "b1",
          title: "Sign off",
          roleHint: "reviewer",
          reviewerUids: signoffReviewers,
          approvedByReviewerUids: [],
          questionedByReviewerUids: [],
          rejectedByReviewerUids: [],
          done: true,
        },
      ],
    };
  }

  test("send-review-outcome refuses a forged signoff reviewer list", async () => {
    reset();
    globalThis.__viewer = { uid: "attacker", role: "member", suRecognised: false };
    globalThis.__db = makeDb({
      ...people(),
      "tasks/t5": {
        title: "Your NAISI membership was reviewed",
        source: "personal",
        visibility: "assignees-only",
        creatorUid: "attacker",
        completerUids: ["attacker"],
        reviewerUids: [],
        ...block(["attacker", "victim1", "victim2"]),
      },
    });
    const res = await sendReviewOutcome(jsonRequest({ blockId: "b1" }), ctx("t5"));
    assert.equal(res.status, 200, `the route refused for another reason: ${JSON.stringify(res.body)}`);
    assert.deepEqual(addressed(), [], "a forged signoff reviewer was emailed");
    assert.deepEqual(pushedTo(), [], "a forged signoff reviewer was pushed to");
  });

  test("the people on the task still hear the outcome", async () => {
    reset();
    globalThis.__viewer = { uid: "mate", role: "member", suRecognised: false };
    globalThis.__db = makeDb({
      ...people(),
      "tasks/t6": {
        title: "Term plan",
        source: "committee",
        visibility: "assignees-only",
        creatorUid: "mate",
        completerUids: ["attacker"],
        reviewerUids: ["mate"],
        ...block(["mate", "victim1"]),
      },
    });
    const res = await sendReviewOutcome(jsonRequest({ blockId: "b1" }), ctx("t6"));
    assert.equal(res.status, 200, `the route refused: ${JSON.stringify(res.body)}`);
    assert.deepEqual(addressed(), ["attacker@example.com"], "the completer was not told");
  });
});

describe("what the roster filter changed about the review gate, on purpose", () => {
  /**
   * Filtering `s.reviewerUids` where the rows are READ means the completion
   * gate's `required` set is the filtered array too. A row whose reviewers
   * have all left the task therefore reads as ungated rather than blocking the
   * block forever, which is a loosening. It is the right one: those people can
   * no longer see the task, let alone approve a row on it, so the old
   * behaviour was a block nobody could ever release. Pinned here so it is a
   * decision rather than a side effect of a security filter.
   */
  test("a completion row whose reviewers all left the task no longer blocks the block", async () => {
    reset();
    globalThis.__viewer = { uid: "mate", role: "member", suRecognised: false };
    globalThis.__db = makeDb({
      ...people(),
      "tasks/t7": {
        title: "Term plan",
        source: "committee",
        visibility: "assignees-only",
        creatorUid: "mate",
        completerUids: ["attacker"],
        reviewerUids: ["mate"],
        blocks: [
          { id: "b1", name: "Week one", sealState: "sealed", sealedAt: null, reviewPassSentAt: null },
        ],
        subtasks: [
          {
            id: "s1",
            blockId: "b1",
            title: "Draft the agenda",
            roleHint: "completer",
            // `victim1` was a reviewer on this row and has since been taken off
            // the task, so nothing they left behind can approve it.
            reviewerUids: ["victim1"],
            approvedByReviewerUids: [],
            questionedByReviewerUids: [],
            rejectedByReviewerUids: [],
            done: true,
          },
          {
            id: "s2",
            blockId: "b1",
            title: "Sign off",
            roleHint: "reviewer",
            reviewerUids: ["mate"],
            approvedByReviewerUids: [],
            questionedByReviewerUids: [],
            rejectedByReviewerUids: [],
            done: true,
          },
        ],
      },
    });
    const res = await sendReviewOutcome(jsonRequest({ blockId: "b1" }), ctx("t7"));
    assert.equal(
      res.status,
      200,
      `the block stayed stuck behind a reviewer who is no longer on the task: ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(addressed(), ["attacker@example.com"]);
  });
});

// ---------------------------------------------------------------------------
// 3. The tree
// ---------------------------------------------------------------------------

describe("every uid array in a sending file is registered", () => {
  const found = scanRecipientSources(["src/app/api", "src/lib"], assert);

  test("both directions, and the counts agree", () => {
    const missing = [...found.keys()].filter((key) => !RECIPIENT_SOURCES.has(key)).sort();
    assert.deepEqual(
      missing,
      [],
      "A uid array is read in a file that can send, with no entry saying where it comes " +
        "from. Add it to RECIPIENT_SOURCES: `caller` if the person calling the route wrote " +
        "it, and then name the literal that scopes it.",
    );
    const stale = [...RECIPIENT_SOURCES.keys()].filter((key) => !found.has(key)).sort();
    assert.deepEqual(stale, [], "RECIPIENT_SOURCES names a read that is no longer in the tree.");
    for (const [key, entry] of RECIPIENT_SOURCES) {
      assert.equal(
        found.get(key),
        entry.reads,
        `${key} is read ${found.get(key)} times, the registry says ${entry.reads}. A second ` +
          "read must be looked at rather than folded into the entry above it.",
      );
    }
  });

  test("every entry gives a written reason", () => {
    for (const [key, entry] of RECIPIENT_SOURCES) {
      assert.ok(
        typeof entry.why === "string" && entry.why.trim().length >= 55,
        `${key} needs a real reason, not a placeholder.`,
      );
    }
  });

  test("a caller-written array names the literal that scopes it, and the file carries it", () => {
    for (const [key, entry] of RECIPIENT_SOURCES) {
      if (entry.origin !== "caller") continue;
      const file = join(REPO_ROOT, key.split("#")[0]);
      assert.ok(
        typeof entry.filteredBy === "string" && entry.filteredBy.length > 0,
        `${key} is caller-written and must name a filter.`,
      );
      assert.ok(
        withStrings(file).includes(entry.filteredBy),
        `${key} declares the filter ${JSON.stringify(entry.filteredBy)}, which is not in the ` +
          "file. A recipient list the caller wrote reaches a send unscoped.",
      );
    }
  });

  test("a derived array points at entries that exist", () => {
    for (const [key, entry] of RECIPIENT_SOURCES) {
      if (entry.origin !== "derived") continue;
      assert.ok(Array.isArray(entry.derivedFrom) && entry.derivedFrom.length > 0, `${key} needs derivedFrom.`);
      for (const source of entry.derivedFrom) {
        assert.ok(
          RECIPIENT_SOURCES.has(source),
          `${key} is derived from ${source}, which is not registered.`,
        );
      }
    }
  });

  test("a list a file assembles for itself has a registered source in that file", () => {
    for (const [key, entry] of RECIPIENT_SOURCES) {
      if (entry.origin !== "assembled") continue;
      const [path] = key.split("#");
      if (entry.sourceOutsideScan) {
        assert.ok(
          entry.sourceOutsideScan.trim().length >= 55,
          `${key} says its source is outside the scan, which needs the reason written out.`,
        );
        continue;
      }
      const siblings = [...RECIPIENT_SOURCES.entries()].filter(
        ([other, e]) => other.startsWith(`${path}#`) && e.origin !== "assembled",
      );
      assert.ok(
        siblings.length > 0,
        `${key} is a recipient list this file builds, and nothing else in the file is ` +
          "registered as feeding it. Either its sources are unregistered, which is the gap " +
          "this scan exists to close, or the list comes from somewhere the scan cannot see " +
          "and that has to be written down.",
      );
    }
  });

  test("a roster names where it is written, and that file is real", () => {
    for (const [key, entry] of RECIPIENT_SOURCES) {
      if (entry.origin !== "roster") continue;
      assert.ok(typeof entry.writtenBy === "string" && entry.writtenBy.length > 0, `${key} needs writtenBy.`);
      assert.doesNotThrow(
        () => statSync(join(REPO_ROOT, entry.writtenBy)),
        `${key} says it is written by ${entry.writtenBy}, which is not a file.`,
      );
    }
  });

  test("a gate is proved to be a gate, and reaches no recipient", () => {
    for (const [key, entry] of RECIPIENT_SOURCES) {
      if (entry.origin !== "gate") continue;
      const [path, field] = key.split("#");
      const source = codeOf(join(REPO_ROOT, path));
      assert.ok(
        source.includes("isNamedWithStanding("),
        `${key} claims to be an authorisation read, but ${path} never calls the eligibility ` +
          "chokepoint. See tests/authority-at-use.test.mjs.",
      );
      assertReachesNoRecipient(source, key, field);
    }
  });

  test("a record of who acted reaches no recipient either", () => {
    for (const [key, entry] of RECIPIENT_SOURCES) {
      if (entry.origin !== "record") continue;
      const [path, field] = key.split("#");
      assertReachesNoRecipient(codeOf(join(REPO_ROOT, path)), key, field);
    }
  });

  test("every origin is one of the six the registry defines", () => {
    const known = new Set(["gate", "roster", "caller", "derived", "record", "assembled"]);
    for (const [key, entry] of RECIPIENT_SOURCES) {
      assert.ok(known.has(entry.origin), `${key} has origin ${entry.origin}, which is not defined.`);
    }
  });
});

/**
 * A `gate` or a `record` claims its array is not an audience. Checked by
 * reading the lines that mention it: none of them may also be building a
 * recipient set or handing something to a send door.
 */
function assertReachesNoRecipient(source, key, field) {
  const name = field.split(".")[1];
  for (const line of source.split("\n")) {
    if (!new RegExp(`\\.${name}\\b`).test(line)) continue;
    for (const marker of RECIPIENT_MARKERS) {
      assert.ok(
        !line.includes(marker),
        `${key} is registered as reaching no recipient, but this line does:\n  ${line.trim()}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 4. The scanner itself
// ---------------------------------------------------------------------------

describe("the scanner still matches what it is meant to", () => {
  const fieldsIn = (source) => {
    const hits = new Map();
    MEMBER_READ.lastIndex = 0;
    let m;
    while ((m = MEMBER_READ.exec(source)) !== null) {
      const key = `${m[1]}.${m[2]}`;
      hits.set(key, (hits.get(key) ?? 0) + 1);
    }
    return hits;
  };

  test("it finds a read, counts repeats, and ignores a definition", () => {
    const hits = fieldsIn(
      [
        "const a = doc.reviewerUids;",
        "const b = doc.reviewerUids;",
        "const c = other.mentions;",
        "const d = payload.uids;",
        "type X = { reviewerUids: string[] };",
      ].join("\n"),
    );
    assert.equal(hits.get("doc.reviewerUids"), 2);
    assert.equal(hits.get("other.mentions"), 1);
    assert.equal(hits.get("payload.uids"), 1);
    assert.equal(hits.size, 3, "a bare property in a type literal is not a read");
  });

  test("a string that reads like a field access is not a read", () => {
    const line = 'const x = isNamedWithStanding(u, "tasks.completerUids", t.completerUids);';
    assert.deepEqual([...fieldsIn(stripSource(line)).keys()], ["t.completerUids"]);
  });

  test("a trailing comment with an apostrophe cannot swallow the file", () => {
    // The desync that made a fifteen-thousand-character route read as four
    // thousand, and both of its handlers vanish. See tests/lib/stripSource.mjs.
    const source = stripSource(
      ["const a = doc.reviewerUids; // don't ask", "const b = other.mentions;"].join("\n"),
    );
    assert.deepEqual([...fieldsIn(source).keys()].sort(), ["doc.reviewerUids", "other.mentions"]);
  });

  test("a send door is recognised in each spelling the tree uses", () => {
    for (const call of [
      "await sendEmail({",
      "void mirrorTaskEmailToPush(uid, {",
      "  sendRsvpEmail({",
      "return notifyWorksheetEvent(db, {",
    ]) {
      SEND_DOORS.lastIndex = 0;
      assert.ok(SEND_DOORS.test(call), `${call} should read as a send`);
    }
    SEND_DOORS.lastIndex = 0;
    assert.equal(SEND_DOORS.test("const sendEmailLabel = 'x';"), false);
  });
});
