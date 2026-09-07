/**
 * Every send in `src`, and the class it belongs to.
 *
 * Run with `npm test` (Node's built-in runner, no dependencies, no emulator).
 *
 * ## The rule this enforces
 *
 * The three classes, in one sentence each (they get their own page,
 * `docs/notifications.md`, in the documentation PR of this series):
 *
 *  - **grid** consults the member's row for its category before it sends;
 *  - **transactional** never consults it, because the member asked for this
 *    message by doing the thing it is about;
 *  - **notice** deliberately ignores it: a person responsible for an audience
 *    is addressing that audience about something they signed up for.
 *
 * Every send belongs to exactly ONE of those, the choice is made at the call
 * site, and the choice is invisible in the code. A route that emails a cohort
 * and a route that emails one applicant look identical from a diff; the only
 * difference is whether a preference was read three functions earlier. So the
 * choice is written down here, per (file, symbol), with a reason, and this
 * guard walks the tree in both directions:
 *
 *  - a call site the registry does not name FAILS, naming itself and its file,
 *    so a new sender cannot ship without somebody saying which class it is;
 *  - a registry entry whose file or symbol has gone FAILS, so the list cannot
 *    rot into a description of a tree that no longer exists.
 *
 * ## What "consults the row" is allowed to look like
 *
 * A grid entry's file (or the file its entry names in `via`) must reference one
 * of the MARKERS below. They are the ways a row is asked in this codebase, and
 * every one of them resolves through `resolveRow` in
 * `src/lib/firestore/notifications.ts`, which is the single table of defaults:
 *
 *  - `wantsCategory(`, the email column, off a normalised prefs object;
 *  - `addressesForSend(`, which is `wantsCategory` with address routing
 *    attached, and is how the newsletter send asks;
 *  - `wantsEmailForProfile(`, the email column off a raw user document the
 *    sender is already holding (`src/lib/email/preferences.ts`, added with this
 *    guard so the five task routes, the worksheet notifier and the due-soon job
 *    make the decision one way);
 *  - `wantsPushFor(`, the push column, server side;
 *  - `hasOptedOutOfCourseAnnouncements(`, the courses cell read as a refusal,
 *    which is `wantsEmailForProfile` inverted.
 *
 * That list is itself checked: each marker's defining file must reach the one
 * table, so a sixth way of asking cannot appear that resolves a row by hand.
 *
 * ## `via`: where the decision is actually made
 *
 * Several senders delegate. The five worksheet circulation routes call
 * `notifyWorksheetEvent`, and the row is consulted inside it; the task routes'
 * push mirrors consult `wantsPushFor` inside `mirrorTaskEmailToPush`. Marking
 * those files as ungated would be wrong and marking them as gated would be a
 * lie, so a grid entry may name `via`: the file where the row IS consulted.
 * The assertion then runs against that file, and the delegation is written
 * down rather than assumed.
 *
 * ## Counting, and what file granularity still cannot do
 *
 * The registry is keyed `file#symbol`, and a key that only had to EXIST would
 * leave the most likely place a new send lands uncovered: a second call
 * dropped into a file whose key is already registered, which the scanner would
 * fold into the entry above it and pass in silence. So every entry also
 * carries `calls`, the number of times that file calls that symbol, and a
 * count that has moved fails naming both numbers. Adding a send to a
 * registered sender module is therefore the same conversation as adding a new
 * one: somebody says which class it is.
 *
 * What remains, and it is narrower: two calls of one symbol in one file share
 * one CLASS line. Five entries carry `calls: 2` today, four of them two
 * messages on one lane (the two verification variants, the confirm and
 * welcome pair, appoint and decline, the attendee and organiser cancellations)
 * and one genuinely two lanes: `courseFacilitatorEmails.ts` calls `sendEmail`
 * for the cohort announcement (grid, courses) and for the group composer
 * (which becomes a notice in the notice-lane PR). That entry is classified by
 * the lane that consults a row, and each lane's own CALL SITE carries its own
 * entry further up, which is where the classification is legible. The class
 * assertions are therefore per FILE and not per entry: a file with any grid
 * entry must reference a marker; only a file whose entries are ALL
 * transactional is required to reference none.
 *
 * ## The tracked symbols are checked, not remembered
 *
 * `TRACKED` is the scanner's whole reach, so a wrapper missing from it takes
 * every call of that wrapper out of the registry silently. It is therefore
 * derived-checked rather than hand-kept: section 7 walks `src` for exported
 * `send*`/`notify*`/`mirror*` functions in files that reach a send primitive,
 * and fails on one that something else in `src` calls and this list does not
 * name. The other direction too: a tracked name the tree defines nowhere must
 * carry its reason in `NOT_BUILT_YET`.
 *
 * ## Not built yet, listed anyway
 *
 * `sendNotice(` and `sendNoticePush(` are tracked before they exist so the
 * notice-lane PR adds registry rows rather than editing the scanner. Until
 * then they match nothing, which is what the scanner's self-test proves.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

// ---------------------------------------------------------------------------
// 1. The scanner
// ---------------------------------------------------------------------------

/**
 * Every symbol whose call is a send, or a decision to send.
 *
 * The primitives first, then the named wrappers: each one is a function that
 * ends in `sendEmail` or in a push, and each one is called from somewhere that
 * has to declare a class. A wrapper's own body is registered too, keyed by its
 * module, which is why `src/lib/events/sendRsvpEmail.ts#sendEmail` and the four
 * routes that call `sendRsvpEmail` all appear below.
 *
 * THIS LIST IS THE SCANNER'S WHOLE REACH, so a wrapper missing from it takes
 * every call of that wrapper out of the registry without a word. It is
 * therefore checked against the tree in both directions, in section 7: every
 * exported `send*`/`notify*`/`mirror*` function in a file that reaches a send
 * primitive, and that anything else in `src` refers to, must appear here; and
 * every name here must either be one of those or carry a written reason in
 * {@link NOT_BUILT_YET}.
 */
const TRACKED = [
  // Primitives.
  "sendEmail",
  "sendNotice",
  "sendNoticePush",
  "mirrorTaskEmailToPush",
  "mirrorCourseDecisionToPush",
  "sendPushToUid",
  // Named wrappers.
  "sendRsvpEmail",
  "sendCollaboratorEmail",
  "sendCourseApplicationEmail",
  "sendCourseDroppedOutEmail",
  "notifyWorksheetEvent",
  "sendAdmissionEmail",
  "sendCourseWeekNudgeEmail",
  "sendWorksheetDueSoonEmail",
  "sendCourseGroupEmail",
  "sendCourseRunEmail",
];

/**
 * Comments out, because a module header naming `sendEmail()` is prose and
 * `src/lib/firestore/emailSends.ts` has two of those. Strings are left in: a
 * string that looks like a call would be a false positive that costs a registry
 * line, and a scanner that parsed strings would be one that could be fooled by
 * one.
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/**
 * A CALL, not a declaration and not a property access.
 *
 * The leading group refuses a preceding word character, `$` or `.`, so
 * `logEmailSend(` and `mailer.sendEmail(` are not `sendEmail(`. The
 * declaration is dropped separately, by looking at what sits immediately
 * before the name, because `export async function sendEmail(` is the one place
 * in the tree where the definition would otherwise register as its own caller.
 */
function callRegex(symbol) {
  return new RegExp(`(^|[^\\w$.])${symbol}\\s*\\(`, "g");
}

/** Every `file#symbol` this source calls, to HOW MANY TIMES it calls it. */
function callSitesIn(relPath, source) {
  const code = stripComments(source);
  const out = new Map();
  for (const symbol of TRACKED) {
    const re = callRegex(symbol);
    let match;
    while ((match = re.exec(code)) !== null) {
      const before = code.slice(Math.max(0, match.index - 40), match.index + match[1].length);
      if (/\bfunction\s+$/.test(before)) continue;
      const key = `${relPath}#${symbol}`;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  return out;
}

function tsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Repo-relative, forward slashes, so a key reads the same on every platform. */
const relPathOf = (file) => relative(REPO_ROOT, file).split(sep).join("/");

const SOURCE_BY_FILE = new Map();
/** `file#symbol` to the number of calls the tree has of it. */
const FOUND = new Map();
for (const file of tsFilesUnder(SRC)) {
  const rel = relPathOf(file);
  const source = readFileSync(file, "utf8");
  SOURCE_BY_FILE.set(rel, source);
  for (const [key, count] of callSitesIn(rel, source)) {
    FOUND.set(key, (FOUND.get(key) ?? 0) + count);
  }
}

// ---------------------------------------------------------------------------
// 2. The markers
// ---------------------------------------------------------------------------

/** Marker to the file that defines it. See the header. */
const MARKER_DEFINED_IN = {
  "wantsCategory(": "src/lib/firestore/notifications.ts",
  "addressesForSend(": "src/lib/firestore/notifications.ts",
  "wantsEmailForProfile(": "src/lib/email/preferences.ts",
  "wantsPushFor(": "src/lib/push/preferences.ts",
  "hasOptedOutOfCourseAnnouncements(": "src/lib/email/courseFacilitatorEmails.ts",
};
const GRID_MARKERS = Object.keys(MARKER_DEFINED_IN);

/** How a marker's own file is allowed to reach the one table of defaults. */
const REACHES_THE_TABLE = [
  "resolveRow(",
  "wantsCategory(",
  "wantsPush(",
  "wantsEmailForProfile(",
];

/** The notice lane's two doors. Neither exists yet; both are tracked. */
const NOTICE_MARKERS = ["sendNotice(", "sendNoticePush("];

const referencesAny = (rel, needles) => {
  const code = stripComments(SOURCE_BY_FILE.get(rel) ?? "");
  return needles.some((needle) => code.includes(needle));
};

// ---------------------------------------------------------------------------
// 3. The registry
// ---------------------------------------------------------------------------

/**
 * `calls` is how many times that file calls that symbol, and it defaults to
 * one because that is what almost every entry is. It is pinned rather than
 * counted so a SECOND send in a file the registry already names has to be
 * declared: without it the scanner folds the new call into the entry above and
 * the guard passes on a send nobody classified.
 */
const G = (row, reason, via, calls = 1) => ({ class: "grid", row, reason, via, calls });
const T = (reason, calls = 1) => ({ class: "transactional", reason, calls });

/**
 * Every send in the tree, with the class it belongs to and why.
 *
 * Seeded on 7 September 2026 from the tree as it stood, one line of reasoning
 * each. A reason of "see the row above" is not a reason; each says what makes
 * this particular message the class it is.
 */
const REGISTRY = {
  // -- Tasks row: email ----------------------------------------------------
  "src/app/api/tasks/[id]/notify/route.ts#sendEmail": G(
    "tasks",
    "A comment or a mention on a task. Grid: the member can switch task email off on /profile, and the row's copy says mentions stop arriving with it.",
  ),
  "src/app/api/tasks/[id]/send-initial-notifications/route.ts#sendEmail": G(
    "tasks",
    "The you-have-been-added mail for a whole task roster at once.",
  ),
  "src/app/api/tasks/[id]/notify-member/route.ts#sendEmail": G(
    "tasks",
    "The same you-have-been-added mail, for one person added after the batch went out.",
  ),
  "src/app/api/tasks/[id]/send-for-review/route.ts#sendEmail": G(
    "tasks",
    "A review request to the reviewers of a task or one of its subtasks.",
  ),
  "src/app/api/tasks/[id]/send-review-outcome/route.ts#sendEmail": G(
    "tasks",
    "The batched outcome of a review pass, to everybody on the block.",
  ),
  "src/lib/worksheets/notify.ts#sendEmail": G(
    "tasks",
    "All four built circulation messages (assigned, submitted, feedbackReturned, copyEdited) go out through this one loop.",
  ),
  "src/lib/scheduler/jobs/worksheetDueReminders.ts#sendWorksheetDueSoonEmail": G(
    "tasks",
    "The scheduled due-soon nudge. The row is read in `resolveRecipient`, beside the address and the suppression check.",
  ),
  "src/lib/email/worksheetReminderEmails.ts#sendEmail": G(
    "tasks",
    "The due-soon template's send door. It has one caller and that caller consults the row before it gets here.",
    "src/lib/scheduler/jobs/worksheetDueReminders.ts",
  ),
  "src/app/api/worksheets/circulations/route.ts#notifyWorksheetEvent": G(
    "tasks",
    "Sending a worksheet: the `assigned` message to every recipient.",
    "src/lib/worksheets/notify.ts",
  ),
  "src/app/api/worksheets/circulations/[circulationId]/recipients/route.ts#notifyWorksheetEvent": G(
    "tasks",
    "The same `assigned` message, for recipients added to a circulation already in flight.",
    "src/lib/worksheets/notify.ts",
  ),
  "src/app/api/worksheets/circulations/[circulationId]/submit/route.ts#notifyWorksheetEvent": G(
    "tasks",
    "The `submitted` message telling reviewers somebody's answers are waiting.",
    "src/lib/worksheets/notify.ts",
  ),
  "src/app/api/worksheets/circulations/[circulationId]/responses/[uid]/return/route.ts#notifyWorksheetEvent": G(
    "tasks",
    "The `feedbackReturned` message telling a recipient a reviewer has written back.",
    "src/lib/worksheets/notify.ts",
  ),
  "src/app/api/worksheets/circulations/[circulationId]/notify-copy-edited/route.ts#notifyWorksheetEvent": G(
    "tasks",
    "The `copyEdited` message telling recipients the questions changed under them.",
    "src/lib/worksheets/notify.ts",
  ),

  // -- Tasks row: push -----------------------------------------------------
  "src/app/api/tasks/[id]/notify/route.ts#mirrorTaskEmailToPush": G(
    "tasks",
    "The comment email's push mirror. The push cell is read inside the mirror.",
    "src/lib/push/taskNotifications.ts",
  ),
  "src/app/api/tasks/[id]/send-initial-notifications/route.ts#mirrorTaskEmailToPush": G(
    "tasks",
    "The push mirror beside the batch you-have-been-added email.",
    "src/lib/push/taskNotifications.ts",
  ),
  "src/app/api/tasks/[id]/notify-member/route.ts#mirrorTaskEmailToPush": G(
    "tasks",
    "The push mirror beside the per-uid you-have-been-added email.",
    "src/lib/push/taskNotifications.ts",
  ),
  "src/app/api/tasks/[id]/send-for-review/route.ts#mirrorTaskEmailToPush": G(
    "tasks",
    "The push mirror beside the review request email.",
    "src/lib/push/taskNotifications.ts",
  ),
  "src/app/api/tasks/[id]/send-review-outcome/route.ts#mirrorTaskEmailToPush": G(
    "tasks",
    "The push mirror beside the batched review outcome email.",
    "src/lib/push/taskNotifications.ts",
  ),
  "src/lib/worksheets/notify.ts#mirrorTaskEmailToPush": G(
    "tasks",
    "The circulation messages' push mirror, sent only after its own email has gone.",
    "src/lib/push/taskNotifications.ts",
  ),
  "src/lib/scheduler/jobs/worksheetDueReminders.ts#mirrorTaskEmailToPush": G(
    "tasks",
    "The due-soon reminder's push leg. It is a leg rather than a mirror here: the circulation's own push switch can be on with its email switch off.",
    "src/lib/push/taskNotifications.ts",
  ),
  "src/lib/push/taskNotifications.ts#sendPushToUid": G(
    "tasks",
    "The mirror itself, and the one place `push.tasks` is read.",
  ),

  // -- Courses row: email --------------------------------------------------
  "src/lib/email/courseFacilitatorEmails.ts#sendEmail": G(
    "courses",
    "Two calls in one file: `sendCourseRunEmail` (the cohort announcement, gated by `resolveCohortAudience` in this same file) and `sendCourseGroupEmail` (the group composer, which the notice-lane PR moves to the notice class). Classified by the lane that reads a row; each lane's call site carries its own entry.",
    undefined,
    2,
  ),
  "src/app/api/courses/runs/[runId]/email/route.ts#sendCourseRunEmail": G(
    "courses",
    "The cohort announcement composer. `resolveCohortAudience` drops everybody whose courses cell is a stored false before a single message is rendered.",
    "src/lib/email/courseFacilitatorEmails.ts",
  ),
  "src/app/api/courses/runs/[runId]/nudge/route.ts#sendCourseWeekNudgeEmail": G(
    "courses",
    "The run catch-up nudge, over the same audience resolver.",
    "src/lib/email/courseFacilitatorEmails.ts",
  ),
  "src/app/api/courses/groups/[groupId]/attendance/push/route.ts#sendCourseWeekNudgeEmail": G(
    "courses",
    "The weekly session nudge to one group, over the same audience resolver.",
    "src/lib/email/courseFacilitatorEmails.ts",
  ),
  "src/lib/email/courseNudgeEmail.ts#sendEmail": G(
    "courses",
    "The nudge template's send door. Both of its callers resolve their audience through the cohort resolver first.",
    "src/lib/email/courseFacilitatorEmails.ts",
  ),
  "src/lib/scheduler/jobs/admissionsReminders.ts#sendAdmissionEmail": G(
    "courses",
    "The admissions deadline reminder. A scheduled nag about a draft, so the courses row is its off switch; `resolveRecipient` reads it off the user document it fetches for the name. Email only: this job has no push leg, so the cell it reads gates the only channel it has.",
  ),
  "src/lib/scheduler/jobs/admissionsStageRelease.ts#sendAdmissionEmail": G(
    "courses",
    "The stage-release announcement telling applicants a new part of the form has opened.",
  ),

  // -- Courses row: push ---------------------------------------------------
  "src/lib/scheduler/jobs/admissionsStageRelease.ts#mirrorCourseDecisionToPush": G(
    "courses",
    "The stage announcement's push leg, and the one place both directions of the row are live at once: the email is sent whatever the push cell says, and the push is handed off whatever the EMAIL cell says (`mailCandidate` gives an `opted-out` skip a push-only lane). Two cells, two answers.",
    "src/lib/push/courseNotifications.ts",
  ),
  "src/app/api/admissions/rounds/[roundId]/decide/route.ts#mirrorCourseDecisionToPush": G(
    "courses",
    "The push beside an appointment or a decline. The decision email itself is transactional and goes either way.",
    "src/lib/push/courseNotifications.ts",
  ),
  "src/app/api/courses/runs/[runId]/allocation/publish/route.ts#mirrorCourseDecisionToPush": G(
    "courses",
    "The push beside a course placement. Same split: the placement email is transactional.",
    "src/lib/push/courseNotifications.ts",
  ),
  "src/lib/push/courseNotifications.ts#sendPushToUid": G(
    "courses",
    "The mirror itself, and the one place `push.courses` is read.",
  ),

  // -- Newsletter row ------------------------------------------------------
  "src/app/api/newsletter/[id]/send/route.ts#sendEmail": G(
    "newsletter",
    "The only sender that addresses the newsletter row. `addressesForSend` returns an empty list for anybody who has not opted in, which is also how the per-address matrix is honoured.",
  ),

  // -- Transactional: account and identity ---------------------------------
  "src/app/api/register/route.ts#sendEmail": T(
    "The university-email magic link, sent because somebody typed their address into the registration form thirty seconds earlier.",
  ),
  "src/app/api/register/resend/route.ts#sendEmail": T(
    "The same magic link, resent because they pressed resend.",
  ),
  "src/app/api/verify-email/send/route.ts#sendEmail": T(
    "The verification link from /profile, and the already-registered variant that goes to the address instead of telling the browser who owns it.",
    2,
  ),

  // -- Transactional: applications and decisions ---------------------------
  "src/app/api/admin/application-emails/send/route.ts#sendEmail": T(
    "The membership application lifecycle mail (submitted, approved, rejected). A decision on somebody's own application.",
  ),
  "src/lib/email/collaboratorEmails.ts#sendEmail": T(
    "Collaborator submitted, approved and rejected. Same shape as the membership decisions.",
  ),
  "src/app/api/collaborators/route.ts#sendCollaboratorEmail": T(
    "The acknowledgement for a collaboration enquiry somebody has just submitted.",
  ),
  "src/app/api/collaborators/[id]/route.ts#sendCollaboratorEmail": T(
    "The decision on that enquiry, approved or rejected, to the person who sent it.",
  ),
  "src/lib/email/courseApplicationEmails.ts#sendEmail": T(
    "Course application submitted, decided and allocated: three answers to one person about one application.",
  ),
  "src/app/api/courses/runs/[runId]/apply/route.ts#sendCourseApplicationEmail": T(
    "The receipt for a course application, sent as it is submitted.",
  ),
  "src/app/api/courses/runs/[runId]/applications/[uid]/decide/route.ts#sendCourseApplicationEmail": T(
    "The decision on that application, accepted or not, to the applicant.",
  ),
  "src/app/api/courses/runs/[runId]/allocation/publish/route.ts#sendCourseApplicationEmail": T(
    "The placement mail telling an accepted applicant which group they are in.",
  ),
  "src/lib/email/courseEnrolmentEmails.ts#sendEmail": T(
    "The dropped-out note confirming a member is off a run. A change to their own enrolment.",
  ),
  "src/app/api/courses/runs/[runId]/enrol/route.ts#sendCourseDroppedOutEmail": T(
    "The call site of that note, on the route that takes a member off a run.",
  ),
  "src/lib/email/admissionEmails.ts#sendEmail": T(
    "The admissions template's send door, shared by five callers. It consults nothing itself; the two scheduled callers consult the courses row before they reach it and carry their own grid entries.",
  ),
  "src/app/api/admissions/rounds/[roundId]/apply/route.ts#sendAdmissionEmail": T(
    "The receipt for starting an admissions application.",
  ),
  "src/app/api/admissions/rounds/[roundId]/apply/submit/route.ts#sendAdmissionEmail": T(
    "The receipt for submitting one, sent as the applicant presses submit.",
  ),
  "src/app/api/admissions/rounds/[roundId]/decide/route.ts#sendAdmissionEmail": T(
    "Appoint and decline: the decision on somebody's own application. One call each, on one lane.",
    2,
  ),

  // -- Transactional: things the person asked for by acting -----------------
  "src/lib/events/sendRsvpEmail.ts#sendEmail": T(
    "Every RSVP lifecycle message: submitted, confirmed, waitlisted, denied, changed, cancelled. Each one answers something the recipient just did.",
  ),
  "src/app/api/events/[id]/rsvp/route.ts#sendRsvpEmail": T(
    "The acknowledgement for an RSVP as it is made.",
  ),
  "src/app/api/events/[id]/rsvp/[rsvpId]/approve/route.ts#sendRsvpEmail": T(
    "The confirmation when an organiser approves that RSVP.",
  ),
  "src/app/api/events/[id]/rsvp/[rsvpId]/deny/route.ts#sendRsvpEmail": T(
    "The refusal when an organiser denies that RSVP instead of approving it.",
  ),
  "src/app/api/events/[id]/rsvp/[rsvpId]/cancel/route.ts#sendRsvpEmail": T(
    "The two cancellation notes, one for the attendee cancelling and one for the organiser cancelling on their behalf.",
    2,
  ),
  "src/app/api/subscriptions/route.ts#sendEmail": T(
    "The confirmation link and the welcome that follows it. These CREATE the preference; gating them on it would make a subscription unconfirmable.",
    2,
  ),
  "src/app/api/subscriptions/confirm/route.ts#sendEmail": T(
    "The welcome sent when a confirmation link is followed. Same argument.",
  ),

  // -- Transactional: diagnostics addressed to the sender -------------------
  "src/app/api/admin/test-email/route.ts#sendEmail": T(
    "An admin mailing their own address to check the transport is alive.",
  ),
  "src/app/api/newsletter/[id]/send-test/route.ts#sendEmail": T(
    "A drafter mailing themselves the draft. Gating a rehearsal on the rehearser's own newsletter switch would hide the send they are trying to check.",
  ),
  "src/app/api/admin/application-emails/[templateId]/send-test/route.ts#sendEmail": T(
    "The application-template rehearsal, to the editor's own address.",
  ),
  "src/app/api/admin/course-emails/[templateId]/send-test/route.ts#sendEmail": T(
    "The course-template rehearsal, to the editor's own address.",
  ),
  "src/app/api/push/test/route.ts#sendPushToUid": T(
    "A member pushing to their own devices from the push card, to see whether the browser is really subscribed.",
  ),

  // -- Becomes a notice in the notice-lane PR -------------------------------
  "src/app/api/events/[id]/broadcast/route.ts#sendEmail": T(
    "The attendee broadcast. Transactional TODAY because an attendee asked for the event and nothing about the send reads a row; the notice-lane PR moves it to the notice class, with the marker, the receipt kind and the cap it has no cap for today.",
  ),
  "src/app/api/events/[id]/cancel/route.ts#sendEmail": T(
    "The cancellation notice to everybody holding an RSVP. Same move to the notice class in the notice-lane PR.",
  ),
  "src/app/api/courses/groups/[groupId]/email/route.ts#sendCourseGroupEmail": T(
    "The group composer: a facilitator writing to their own group. Becomes a notice in the notice-lane PR.",
  ),
  "src/app/api/courses/groups/[groupId]/notice/route.ts#sendEmail": T(
    "The room-change notice. Becomes a notice in the notice-lane PR, which is where its existing per-audience caps become the shared ones.",
  ),
};

// ---------------------------------------------------------------------------
// 4. Both directions
// ---------------------------------------------------------------------------

describe("every send in the tree declares its class", () => {
  test("the walk found the tree", () => {
    // A scanner that silently found nothing would pass every assertion below.
    assert.ok(SOURCE_BY_FILE.size > 200, `only ${SOURCE_BY_FILE.size} source files walked`);
    assert.ok(FOUND.size > 50, `only ${FOUND.size} call sites found`);
  });

  test("no call site is unregistered", () => {
    const missing = [...FOUND.keys()].filter((key) => !(key in REGISTRY)).sort();
    assert.deepEqual(
      missing,
      [],
      "these sends do not say which class they are. Add each to REGISTRY in " +
        "tests/notification-classification.test.mjs with a class and a reason:\n" +
        missing.map((key) => `  ${key}`).join("\n"),
    );
  });

  test("no registered file has grown a send nobody classified", () => {
    // The direction a Set could not see. A key that only has to EXIST covers
    // the first send in a file and nothing after it, and a sender module is
    // the likeliest place the second one lands.
    const moved = [];
    for (const [key, found] of FOUND) {
      const entry = REGISTRY[key];
      if (!entry) continue;
      const expected = entry.calls ?? 1;
      if (found !== expected) moved.push({ key, expected, found });
    }
    assert.deepEqual(
      moved,
      [],
      "these files call a tracked send a different number of times than the " +
        "registry says. If the new call is a new message, say which class it " +
        "is in its entry's reason; then update `calls`:\n" +
        moved
          .map(({ key, expected, found }) => `  ${key}: registered ${expected}, found ${found}`)
          .join("\n"),
    );
  });

  test("no registry entry names a call site that has gone", () => {
    const stale = Object.keys(REGISTRY).filter((key) => !FOUND.has(key)).sort();
    assert.deepEqual(
      stale,
      [],
      "these registry entries describe sends the tree no longer has. Delete " +
        "them, or fix the path if the file moved:\n" +
        stale.map((key) => `  ${key}`).join("\n"),
    );
  });

  test("every entry is well formed", () => {
    const ROWS = ["newsletter", "events", "courses", "tasks"];
    for (const [key, entry] of Object.entries(REGISTRY)) {
      assert.ok(
        ["grid", "transactional", "notice"].includes(entry.class),
        `${key} has no class`,
      );
      assert.equal(typeof entry.reason, "string", `${key} has no reason`);
      assert.ok(entry.reason.length > 40, `${key}'s reason is too short to be one`);
      assert.ok(
        Number.isInteger(entry.calls) && entry.calls >= 1,
        `${key} has no call count`,
      );
      if (entry.class === "grid") {
        assert.ok(ROWS.includes(entry.row), `${key} is grid but names no row`);
      } else {
        assert.equal(entry.row, undefined, `${key} is ${entry.class} and must take no row`);
      }
      if (entry.via !== undefined) {
        assert.equal(entry.class, "grid", `${key} is not grid and cannot delegate a row check`);
        assert.ok(
          SOURCE_BY_FILE.has(entry.via),
          `${key} delegates to ${entry.via}, which is not a source file`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The class, asserted from the source
// ---------------------------------------------------------------------------

describe("a class is a claim about the code, and the code is read", () => {
  /** file to the set of classes its entries carry. See the header on why. */
  const classesByFile = new Map();
  for (const [key, entry] of Object.entries(REGISTRY)) {
    const file = key.slice(0, key.lastIndexOf("#"));
    if (!classesByFile.has(file)) classesByFile.set(file, new Set());
    classesByFile.get(file).add(entry.class);
  }

  for (const [key, entry] of Object.entries(REGISTRY)) {
    if (entry.class !== "grid") continue;
    const file = key.slice(0, key.lastIndexOf("#"));
    const where = entry.via ?? file;
    test(`${key} consults the ${entry.row} row in ${where}`, () => {
      assert.ok(
        referencesAny(where, GRID_MARKERS),
        `${where} references none of ${GRID_MARKERS.join(", ")}, so nothing there reads a row`,
      );
    });
  }

  for (const [file, classes] of classesByFile) {
    if (classes.size !== 1 || !classes.has("transactional")) continue;
    test(`${file} sends transactionally and consults nothing`, () => {
      assert.ok(
        !referencesAny(file, GRID_MARKERS),
        `${file} is registered transactional but reads a notification row`,
      );
      assert.ok(
        !referencesAny(file, NOTICE_MARKERS),
        `${file} is registered transactional but reaches the notice lane`,
      );
    });
  }

  for (const [key, entry] of Object.entries(REGISTRY)) {
    if (entry.class !== "notice") continue;
    const file = key.slice(0, key.lastIndexOf("#"));
    test(`${key} goes through the notice lane`, () => {
      assert.ok(
        referencesAny(file, NOTICE_MARKERS),
        `${file} is registered notice but calls neither ${NOTICE_MARKERS.join(" nor ")}`,
      );
      assert.ok(
        !referencesAny(file, ["wantsCategory("]),
        `${file} is a notice and must not consult the grid`,
      );
    });
  }

  test("every marker resolves through the one table of defaults", () => {
    // A sixth way of asking a row is fine; a sixth way that compares a stored
    // value to `false` by hand is the drift the grid exists to end.
    for (const [marker, file] of Object.entries(MARKER_DEFINED_IN)) {
      assert.ok(existsSync(join(REPO_ROOT, file)), `${marker} is defined in ${file}, which is gone`);
      const others = REACHES_THE_TABLE.filter((needle) => needle !== marker);
      assert.ok(
        referencesAny(file, others),
        `${file} defines ${marker} but reaches none of ${others.join(", ")}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 6. The scanner, on itself
// ---------------------------------------------------------------------------

describe("the scanner would catch a new send", () => {
  const sitesOf = (source) =>
    [...callSitesIn("x.ts", source).keys()].map((k) => k.split("#")[1]).sort();
  const countsOf = (source) =>
    Object.fromEntries(
      [...callSitesIn("x.ts", source)].map(([k, n]) => [k.split("#")[1], n]),
    );

  test("a second call in one file is counted rather than folded away", () => {
    // The direction a Set could not see: two sends in one file looked exactly
    // like one, so a send added to a registered module shipped unclassified.
    assert.deepEqual(countsOf("await sendEmail(a);\nawait sendEmail(b);"), { sendEmail: 2 });
    assert.deepEqual(countsOf("await sendEmail(a);"), { sendEmail: 1 });
    assert.deepEqual(countsOf("await sendEmail(a);\nawait sendRsvpEmail(b);"), {
      sendEmail: 1,
      sendRsvpEmail: 1,
    });
  });

  test("a plain call, an awaited call and a voided call all register", () => {
    assert.deepEqual(sitesOf("sendEmail({ to });"), ["sendEmail"]);
    assert.deepEqual(sitesOf("await sendEmail({ to });"), ["sendEmail"]);
    assert.deepEqual(sitesOf("void sendEmail({ to });"), ["sendEmail"]);
    assert.deepEqual(sitesOf("  return sendRsvpEmail(args);"), ["sendRsvpEmail"]);
    assert.deepEqual(sitesOf("await mirrorTaskEmailToPush(uid, p);"), ["mirrorTaskEmailToPush"]);
  });

  test("the notice lane's two doors are tracked before they exist", () => {
    // The notice-lane PR adds registry rows. It must not have to edit this
    // scanner as well, or the first notice would ship unclassified.
    assert.deepEqual(sitesOf("await sendNotice(args);"), ["sendNotice"]);
    assert.deepEqual(sitesOf("await sendNoticePush(uid, p);"), ["sendNoticePush"]);
    assert.equal(
      [...FOUND.keys()].filter((k) => k.endsWith("#sendNotice") || k.endsWith("#sendNoticePush"))
        .length,
      0,
      "the notice helpers exist now: register their call sites",
    );
  });

  test("a definition, a comment and a property access are not call sites", () => {
    assert.deepEqual(sitesOf("export async function sendEmail({ to }) {}"), []);
    assert.deepEqual(sitesOf("function sendRsvpEmail(a) {}"), []);
    assert.deepEqual(sitesOf("// Called from `sendEmail()` after every response."), []);
    assert.deepEqual(sitesOf("/**\n * Called from sendEmail() once per address.\n */"), []);
    assert.deepEqual(sitesOf("await mailer.sendEmail(opts);"), []);
    assert.deepEqual(sitesOf("await logEmailSend(db, entry);"), []);
    assert.deepEqual(sitesOf("const notSendEmail = 1;"), []);
  });

  test("a marker in a comment does not count as consulting a row", () => {
    // The class assertions read stripped source for the same reason the
    // scanner does: a file that only MENTIONS `wantsCategory(` in a header
    // would otherwise pass as gated.
    const rel = "src/lib/firestore/notifications.ts";
    const saved = SOURCE_BY_FILE.get(rel);
    SOURCE_BY_FILE.set(rel, "// wantsCategory(prefs, row) is read elsewhere\nexport const x = 1;");
    try {
      assert.equal(referencesAny(rel, GRID_MARKERS), false);
    } finally {
      SOURCE_BY_FILE.set(rel, saved);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. The scanner's reach, derived from the tree
// ---------------------------------------------------------------------------

/**
 * The doors a wrapper is a wrapper AROUND. A file that reaches one of these is
 * a file that can send, so an exported sender in it is a symbol somebody else
 * calls to make a message happen.
 */
const SEND_PRIMITIVES = ["sendEmail(", "sendPushToUid(", "sendNotice(", "sendNoticePush("];

/**
 * Names in {@link TRACKED} that the tree does not define yet, each with the
 * reason it is listed anyway. Both halves of the derivation check consult
 * this, so a door that later gets built is not silently excused twice.
 */
const NOT_BUILT_YET = {
  sendNotice:
    "The notice lane's email door. Tracked before it exists so the notice-lane PR adds registry rows rather than editing this scanner.",
  sendNoticePush:
    "The notice lane's push door, listed for the same reason and asserted to match nothing until it is built.",
};

/** `export function send…` / `export const notify… =`, name only. */
const EXPORTED_SENDER =
  /export\s+(?:async\s+)?function\s+((?:send|notify|mirror)\w*)\s*\(|export\s+const\s+((?:send|notify|mirror)\w*)\s*[:=]/g;

/** Every exported sender the tree defines, to the file that defines it. */
function exportedSenders() {
  const found = new Map();
  for (const [rel, source] of SOURCE_BY_FILE) {
    const code = stripComments(source);
    if (!SEND_PRIMITIVES.some((primitive) => code.includes(primitive))) continue;
    EXPORTED_SENDER.lastIndex = 0;
    let match;
    while ((match = EXPORTED_SENDER.exec(code)) !== null) {
      const name = match[1] ?? match[2];
      if (!found.has(name)) found.set(name, rel);
    }
  }
  return found;
}

/** True when some OTHER file in `src` names this symbol, so it has callers. */
function usedOutside(name, definedIn) {
  const word = new RegExp(`\\b${name}\\b`);
  for (const [rel, source] of SOURCE_BY_FILE) {
    if (rel === definedIn) continue;
    if (word.test(stripComments(source))) return true;
  }
  return false;
}

describe("the scanner's reach is derived from the tree, not remembered", () => {
  const SENDERS = exportedSenders();

  test("the derivation found the wrappers it should", () => {
    // A derivation that silently matched nothing would excuse every name.
    assert.ok(SENDERS.size >= 10, `only ${SENDERS.size} exported senders derived`);
    for (const anchor of ["sendEmail", "sendRsvpEmail", "notifyWorksheetEvent"]) {
      assert.ok(SENDERS.has(anchor), `the derivation missed ${anchor}`);
    }
  });

  test("every exported sender with callers is tracked", () => {
    // The hole this closes: a new `sendEventAnnouncementEmail` in a new module
    // gets its OWN `sendEmail` call classified, and every route that calls the
    // wrapper escapes the registry, because the scanner never looks for a
    // symbol nobody added to TRACKED.
    const untracked = [];
    for (const [name, definedIn] of SENDERS) {
      if (TRACKED.includes(name)) continue;
      if (!usedOutside(name, definedIn)) continue;
      untracked.push(`  ${name} (${definedIn})`);
    }
    assert.deepEqual(
      untracked.sort(),
      [],
      "these exported senders are called from elsewhere in src and the scanner " +
        "does not look for them, so their call sites are unclassified. Add each " +
        "to TRACKED and register its call sites:\n" +
        untracked.join("\n"),
    );
  });

  test("every tracked name is one the tree defines, or says why not", () => {
    const orphans = TRACKED.filter(
      (name) => !SENDERS.has(name) && !(name in NOT_BUILT_YET),
    ).sort();
    assert.deepEqual(
      orphans,
      [],
      "these tracked symbols are defined nowhere in src. Delete them, or give " +
        "each a reason in NOT_BUILT_YET:\n" + orphans.map((name) => `  ${name}`).join("\n"),
    );
    for (const [name, reason] of Object.entries(NOT_BUILT_YET)) {
      assert.ok(TRACKED.includes(name), `${name} is excused but not tracked`);
      assert.ok(reason.length > 40, `${name}'s reason is too short to be one`);
      assert.ok(
        !SENDERS.has(name),
        `${name} is built now: drop it from NOT_BUILT_YET and register its call sites`,
      );
    }
  });
});
