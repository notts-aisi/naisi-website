/**
 * THE STANDING RED TEAM'S ANSWER KEY: what every route and every authed page
 * answers each persona.
 *
 * One entry per route (by method) and per page under `src/app/(app)`, keyed
 * the way `tests/e2e-coverage-map.test.mjs` keys them (the path under
 * `src/app` with `/route.ts` or `/page.tsx` removed, route groups kept). Each
 * entry says what every persona gets and why, and `tests/persona-route-gates.test.mjs`
 * (offline) checks the tree and this file agree in both directions while
 * `scripts/e2e/tests/persona-route-gates.test.mjs` (a real build, an emulator
 * behind it) drives every cell and asserts the answer.
 *
 * PERSONAS. `anonymous` has no session. `pending`, `rejected`, `member`,
 * `committee` (not SU-recognised), `suCommittee`, `admin`, and one plain
 * member per permissions key (`draftNewsletter`, `approveNewsletter`,
 * `draftEvent`, `approveEvent`, `draftCourse`, `approveCourse`,
 * `manageMembership`, `circulateWorksheet`). Their documents are written by
 * `scripts/e2e/lib/personas.mjs`, to an emulator only.
 *
 * WHAT A CELL MEANS. The battery requests each route with an id that
 * addresses nothing (`e2e-missing-<segment>`) and an empty JSON body, so the
 * status is the GATE's answer, or the first validation's, never a document's.
 * `expect` maps a persona (or `"*"` for everyone not named) to a status. For
 * a page the value is a status, the name of a redirect target from
 * `REDIRECTS`, or a list of names when a gating layout and the page beneath
 * it both redirect and the stream decides which the browser sees first:
 * every target observed must then be one of the list. `fields` lists the top-level keys a 2xx JSON body may carry;
 * a key outside it fails. `drive` overrides the request (a body, a query
 * string) with the reason, for a route whose gate sits behind a validation
 * an empty body never reaches.
 *
 * The helpers below are the recurring shapes, so an entry reads as a
 * decision rather than a table. Every entry carries `why`.
 */

export const PERSONA_NAMES = [
  "anonymous",
  "pending",
  "rejected",
  "member",
  "committee",
  "suCommittee",
  "admin",
  "draftNewsletter",
  "approveNewsletter",
  "draftEvent",
  "approveEvent",
  "draftCourse",
  "approveCourse",
  "manageMembership",
  "circulateWorksheet",
];

/** Redirect targets a page may name. */
export const REDIRECTS = {
  login: "/login",
  pendingApproval: "/pending-approval",
  home: "/",
  dashboard: "/dashboard",
  collaborator: "/collaborator",
  learn: "/learn",
  eventsManage: "/events/manage",
  event: "/events/manage/[id]",
  newsletter: "/newsletter",
};

/** Anonymous is refused for having no session; everyone signed in gets `rest`. */
export const signedIn = (rest, overrides = {}) => ({ anonymous: 401, "*": rest, ...overrides });
/** Only an admin gets `ok`; every other session is forbidden. */
export const adminOnly = (ok, overrides = {}) => ({ anonymous: 401, "*": 403, admin: ok, ...overrides });
/** An approved account (member, committee, admin, the permission holders) gets `ok`. */
export const approvedOnly = (ok, overrides = {}) => ({
  anonymous: 401,
  "*": ok,
  pending: 403,
  rejected: 403,
  ...overrides,
});
/** Everyone, signed in or not, gets `status`: a public route or a uniform answer. */
export const everyone = (status, overrides = {}) => ({ "*": status, ...overrides });

/** Resolve one persona's expectation out of an `expect` map. */
export function expectedFor(expect, persona) {
  if (persona in expect) return expect[persona];
  if ("*" in expect) return expect["*"];
  return undefined;
}

/**
 * FINDINGS RECORDED HERE, from the first recording (9 September 2026), each
 * named in the entries it applies to:
 *
 *  F1  Thirty-two handlers read the document before applying any role floor,
 *      so a pending or rejected account is told whether an id exists (a 404
 *      here, because the ids address nothing; a 403 from the document's own
 *      membership once it exists). Per-document authorisation has to read
 *      first; an approved-account floor before the read is the fix, and it is
 *      a decision across the tasks, events, courses, admissions and worksheet
 *      trees rather than a line in this file.
 *  F2  Twenty-three handlers validate the body before any authorisation, so
 *      every signed-in persona meets the same 400 on an empty body. What is
 *      validated is the caller's own body, and nothing is read first.
 *  F3  Two group-week routes answer 404 to a signed-out caller before any
 *      session check.
 *  F4  With no webhook secret configured, the Resend webhook answers 500 to
 *      everybody rather than refusing with a 4xx.
 *
 * Nothing in the recording admitted a persona the model excludes.
 */

/** Routes: key -> { METHOD: { expect, fields?, drive?, public?, why } }. */
export const ROUTES = {
  "/api/account/delete": {
    POST: {
      expect: signedIn(409),
      why:
        "Self-service account deletion needs a typed confirmation, so every signed-in persona " +
        "meets the 409 that asks for it; an outsider has no account to delete.",
    },
  },
  "/api/account/reconsent": {
    POST: {
      expect: signedIn(400),
      why:
        "Accepting the current policy needs the version in the body; every signed-in persona " +
        "meets that validation, including pending and rejected, because their consent is " +
        "their own to give.",
    },
  },
  "/api/admin/application-emails/[templateId]/send-test": {
    POST: {
      expect: everyone(403, { admin: 404 }),
      why:
        "Admin only, decided before the read: every other session is forbidden and the admin " +
        "is told the id is missing.",
    },
  },
  "/api/admin/application-emails/preview": {
    POST: {
      expect: everyone(403, { admin: 200 }),
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not.",
    },
  },
  "/api/admin/application-emails/send": {
    POST: {
      expect: everyone(400, { anonymous: 403 }),
      why:
        "A missing session is refused outright; the body is then validated before the " +
        "per-body authorisation, because an applicant may trigger their own 'submitted' mail " +
        "and the check needs the uid in the body. Recorded: non-admins can probe the template " +
        "and uid validation (F2).",
    },
  },
  "/api/admin/backfill-subscriptions": {
    POST: {
      expect: everyone(403, { admin: 200 }),
      fields: ["legacyRowsMigrated", "memberRowsWritten", "ok", "usersScanned", "usersWithNoEmail"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not. The backfill is idempotent and ran against the emulator here.",
    },
  },
  "/api/admin/collaborators/verification": {
    POST: {
      expect: everyone(403, { admin: 200 }),
      fields: ["verified"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not.",
    },
  },
  "/api/admin/config/task-emails": {
    GET: {
      expect: everyone(403, { admin: 200 }),
      fields: ["enabled", "updatedAt", "updatedByUid"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not.",
    },
    PATCH: {
      expect: everyone(403, { admin: 400 }),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation.",
    },
  },
  "/api/admin/course-emails/[templateId]/send-test": {
    POST: {
      expect: everyone(403, { admin: 404 }),
      why:
        "Admin only, decided before the read: every other session is forbidden and the admin " +
        "is told the id is missing.",
    },
  },
  "/api/admin/course-emails/preview": {
    POST: {
      expect: everyone(403, { admin: 200 }),
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not.",
    },
  },
  "/api/admin/courses-config": {
    GET: {
      expect: everyone(403, { admin: 200 }),
      fields: ["defaults", "dropOutFeedbackUrl", "unmarkedRegisterGraceHours", "weeklyFeedbackUrl"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not.",
    },
    POST: {
      expect: everyone(403, { admin: 400 }),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation.",
    },
  },
  "/api/admin/deliverability/exports": {
    GET: {
      expect: everyone(403, { admin: 200 }),
      fields: ["items"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not. The rows are the server-written export log.",
    },
  },
  "/api/admin/deliverability/sends": {
    GET: {
      expect: everyone(403, { admin: 200 }),
      fields: ["items"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not. The rows are the server-written send log.",
    },
  },
  "/api/admin/deliverability/suppressed": {
    GET: {
      expect: everyone(403, { admin: 200 }),
      fields: ["items"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not. The rows are the suppression list.",
    },
  },
  "/api/admin/deliverability/suppressed/[docId]": {
    DELETE: {
      expect: everyone(403, { admin: 200 }),
      fields: ["ok"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not. Removing a suppression that does not exist is reported as done.",
    },
  },
  "/api/admin/impersonate": {
    POST: {
      expect: everyone(403, { admin: 400 }),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation. A view-as session needs a target uid.",
    },
  },
  "/api/admin/impersonate/exit": {
    POST: {
      expect: everyone(400),
      why:
        "Answers 400 to everyone when no view-as marker cookie is present. RECORDED, NOT " +
        "BLESSED: this is the route with no server-side identity check (the hardening queue's " +
        "own low).",
    },
  },
  "/api/admin/members/[uid]/conduct-flag": {
    GET: {
      expect: adminOnly(200),
      fields: ["byName", "flagged", "flaggedAt", "reason"],
      why:
        "Admin only through requireAdmin; a missing session is a 401 here rather than the " +
        "tree's usual 403, and the admin gets the empty flag shape for an unknown uid.",
    },
    POST: {
      expect: adminOnly(400),
      why:
        "Admin only through requireAdmin; the admin then meets the body validation before any " +
        "member is read.",
    },
  },
  "/api/admin/membership/current": {
    POST: {
      expect: adminOnly(400),
      why:
        "Moving the current period pointer is admin only even for a manageMembership holder, " +
        "decided before the body is read; the admin meets the validation.",
    },
  },
  "/api/admin/membership/export": {
    POST: {
      expect: adminOnly(400, { manageMembership: 400 }),
      why:
        "Admins and manageMembership holders keep the membership record; both meet the " +
        "validation on an empty body, everyone else is forbidden.",
    },
  },
  "/api/admin/membership/grant": {
    POST: {
      expect: adminOnly(400, { manageMembership: 400 }),
      why:
        "Admins and manageMembership holders may grant a membership; both meet the " +
        "validation, everyone else is forbidden.",
    },
  },
  "/api/admin/membership/import": {
    POST: {
      expect: adminOnly(400, { manageMembership: 400 }),
      why:
        "Admins and manageMembership holders may start an import; both meet the validation, " +
        "everyone else is forbidden.",
    },
    GET: {
      expect: adminOnly(400, { manageMembership: 400 }),
      why:
        "Admins and manageMembership holders may read an import; the batch id is required, so " +
        "both meet the validation.",
    },
  },
  "/api/admin/membership/import/[batchId]/abandon": {
    POST: {
      expect: adminOnly(404, { manageMembership: 404 }),
      why:
        "Admins and manageMembership holders; the batch is missing for both, everyone else is " +
        "forbidden before the read.",
    },
  },
  "/api/admin/membership/import/[batchId]/commit": {
    POST: {
      expect: adminOnly(404, { manageMembership: 404 }),
      why:
        "Admins and manageMembership holders; the batch is missing for both, everyone else is " +
        "forbidden before the read.",
    },
  },
  "/api/admin/membership/list": {
    GET: {
      expect: adminOnly(400, { manageMembership: 400 }),
      why:
        "Admins and manageMembership holders may list the record; a period id is required, so " +
        "both meet the validation.",
    },
  },
  "/api/admin/membership/periods": {
    GET: {
      expect: adminOnly(200, { manageMembership: 200 }),
      fields: ["canSetCurrent", "currentPeriodId", "periods"],
      why:
        "Admins and manageMembership holders read the periods; the list is empty here. " +
        "canSetCurrent is the admin-only flag the console renders from.",
    },
    POST: {
      expect: adminOnly(400, { manageMembership: 400 }),
      why:
        "Admins and manageMembership holders may create a period; both meet the validation on " +
        "an empty body.",
    },
  },
  "/api/admin/membership/periods/[periodId]": {
    PATCH: {
      expect: adminOnly(404, { manageMembership: 404 }),
      why:
        "Admins and manageMembership holders; the period is missing for both, everyone else " +
        "is forbidden before the read.",
    },
  },
  "/api/admin/membership/periods/[periodId]/recount": {
    POST: {
      expect: adminOnly(404, { manageMembership: 404 }),
      why:
        "Admins and manageMembership holders; the period is missing for both, everyone else " +
        "is forbidden before the read.",
    },
  },
  "/api/admin/migrate-notifications": {
    POST: {
      expect: everyone(403, { admin: 200 }),
      fields: ["alreadyNew", "migrated", "ok", "skipped"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not. The migration is idempotent and ran against the emulator here.",
    },
  },
  "/api/admin/nuke-tasks": {
    POST: {
      expect: everyone(403, { admin: 400 }),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation. The danger-zone action needs its typed confirmation.",
    },
  },
  "/api/admin/registrations": {
    GET: {
      expect: everyone(403, { admin: 200 }),
      fields: ["nextCursor", "rows"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not. The rows are projected signup-tracker rows (toRegistrationView).",
    },
  },
  "/api/admin/registrations/[uid]": {
    DELETE: {
      expect: everyone(403, { admin: 200 }),
      fields: ["admissionApplicationPrivateDeleted", "admissionApplicationsDeleted", "admissionReviewsAuthoredDeleted", "admissionReviewsDeleted", "admissionRoundRolesCleared", "authDeleted", "collaboratorDeleted", "conductFlagDeleted", "courseApplicationsDeleted", "courseAttendanceMarksCleared", "courseEnrolmentsDeleted", "courseExerciseResponsesDeleted", "courseProgressDeleted", "emailVerificationsDeleted", "memberRecordApplicationsRetained", "membershipImportRowsDeleted", "membershipsDeleted", "ok", "pushSubscriptionsDeleted", "registrationDeleted", "schedulerMarkersDeleted", "subscriptionsDeleted", "userDocDeleted", "worksheetResponsesRetained"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not. Deleting an unknown uid reports every sweep as zero and answers ok, " +
        "which is the cascade's own idempotency.",
    },
  },
  "/api/admin/registrations/summary": {
    GET: {
      expect: everyone(403, { admin: 200 }),
      fields: ["counts", "flags", "recaptcha", "velocity"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not.",
    },
  },
  "/api/admin/scheduler": {
    GET: {
      expect: everyone(403, { admin: 200 }),
      fields: ["enabled", "failedMarkers", "jobMarkers", "jobs", "receipts", "updatedAt", "updatedByUid"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not.",
    },
  },
  "/api/admin/scheduler/config": {
    POST: {
      expect: everyone(403, { admin: 400 }),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation.",
    },
  },
  "/api/admin/scheduler/run": {
    POST: {
      expect: everyone(403, { admin: 400 }),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation. A job id is required.",
    },
  },
  "/api/admin/site-notice": {
    GET: {
      expect: everyone(403, { admin: 200 }),
      fields: ["audit", "notice"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not.",
    },
    PATCH: {
      expect: everyone(403, { admin: 400 }),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation.",
    },
  },
  "/api/admin/subscriptions/[id]": {
    DELETE: {
      expect: everyone(403, { admin: 404 }),
      why:
        "Admin only, decided before the read: every other session is forbidden and the admin " +
        "is told the id is missing.",
    },
  },
  "/api/admin/subscriptions/[id]/set-status": {
    POST: {
      expect: everyone(403, { admin: 400 }),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation.",
    },
  },
  "/api/admin/test-email": {
    POST: {
      expect: everyone(403, { admin: 200 }),
      fields: ["messageId", "ok", "sentTo"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not. The admin's own address is the recipient; it went to Mailpit here.",
    },
  },
  "/api/admin/users/[uid]": {
    DELETE: {
      expect: everyone(403, { admin: 200 }),
      fields: ["admissionApplicationPrivateDeleted", "admissionApplicationsDeleted", "admissionReviewsAuthoredDeleted", "admissionReviewsDeleted", "admissionRoundRolesCleared", "authDeleted", "collaboratorDeleted", "conductFlagDeleted", "courseApplicationsDeleted", "courseAttendanceMarksCleared", "courseEnrolmentsDeleted", "courseExerciseResponsesDeleted", "courseProgressDeleted", "emailVerificationsDeleted", "memberRecordApplicationsRetained", "membershipImportRowsDeleted", "membershipsDeleted", "ok", "pushSubscriptionsDeleted", "registrationDeleted", "schedulerMarkersDeleted", "subscriptionsDeleted", "userDocDeleted", "worksheetResponsesRetained"],
      why:
        "Admin only through the tree's own requireAdmin helper, which answers a missing " +
        "session with the same 403 an outsider gets, so an anonymous probe learns nothing an " +
        "admin would not. The hard delete of an unknown uid reports every sweep as zero and " +
        "answers ok.",
    },
  },
  "/api/admissions/applications/me": {
    GET: {
      expect: signedIn(200, { rejected: 403 }),
      fields: ["rows"],
      why:
        "The applicant lane: a pending account is an applicant and sees its own (empty) list, " +
        "a rejected one is refused, and every approved account sees its own.",
    },
  },
  "/api/admissions/rounds": {
    GET: {
      expect: signedIn(200),
      fields: ["canAuthor", "rounds"],
      why:
        "Any signed-in account may list rounds, and canSeeRound filters the list per caller; " +
        "here the list is empty, so pending and rejected see nothing and canAuthor is false.",
    },
    POST: {
      expect: adminOnly(400, { approveCourse: 400 }),
      why:
        "Round authors (admin or approveCourse) may create a round and meet the validation; " +
        "everyone else is forbidden before the body is read.",
    },
  },
  "/api/admissions/rounds/[roundId]": {
    GET: {
      expect: signedIn(404),
      why:
        "404 rather than 403 by design: whether a round exists is itself information about an " +
        "intake, so every session including pending and rejected is told the same thing.",
    },
    PATCH: {
      expect: adminOnly(404, { approveCourse: 404 }),
      why:
        "Round authors (admin or approveCourse) may edit; for them the round is missing, " +
        "everyone else is forbidden before the read.",
    },
  },
  "/api/admissions/rounds/[roundId]/apply": {
    GET: {
      expect: signedIn(404, { rejected: 403 }),
      why:
        "The applicant lane (requireApplicant): a pending account is an applicant and is " +
        "admitted, a rejected one is refused, and the round or run is then missing.",
    },
    POST: {
      expect: approvedOnly(403),
      why:
        "The applicant lane, then the captcha: every session that gets past requireApplicant " +
        "is refused by reCAPTCHA on a tokenless request before the round is read, rejected " +
        "accounts included.",
    },
    PATCH: {
      expect: signedIn(404, { rejected: 403 }),
      why:
        "The applicant lane (requireApplicant): a pending account is an applicant and is " +
        "admitted, a rejected one is refused, and the round or run is then missing.",
    },
    DELETE: {
      expect: signedIn(400, { rejected: 403 }),
      why:
        "The applicant lane, then the withdrawal needs its typed word; a rejected account is " +
        "refused first.",
    },
  },
  "/api/admissions/rounds/[roundId]/apply/stage/[stageId]": {
    POST: {
      expect: approvedOnly(403),
      why:
        "The applicant lane, then the captcha before the round is read; every session past " +
        "requireApplicant meets the captcha refusal.",
    },
  },
  "/api/admissions/rounds/[roundId]/apply/submit": {
    POST: {
      expect: approvedOnly(403),
      why:
        "The applicant lane, then the captcha before the round is read; every session past " +
        "requireApplicant meets the captcha refusal.",
    },
  },
  "/api/admissions/rounds/[roundId]/decide": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2). The " +
        "audit's ordering low on this route: the decision body is validated first.",
    },
  },
  "/api/admissions/rounds/[roundId]/destroy": {
    POST: {
      expect: adminOnly(400),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation. Destroying a round needs its typed confirmation.",
    },
  },
  "/api/admissions/rounds/[roundId]/destroy-manifest": {
    GET: {
      expect: adminOnly(404),
      why:
        "Admin only, decided before the read: every other session is forbidden and the admin " +
        "is told the id is missing.",
    },
  },
  "/api/admissions/rounds/[roundId]/reminders/send-now": {
    POST: {
      expect: adminOnly(404, { approveCourse: 404 }),
      why:
        "Round authors (admin or approveCourse); the round is missing for them, everyone else " +
        "is forbidden before the read.",
    },
  },
  "/api/admissions/rounds/[roundId]/roles": {
    PUT: {
      expect: adminOnly(400),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation. Appointing reviewers is admin only.",
    },
  },
  "/api/admissions/rounds/[roundId]/stages": {
    GET: {
      expect: signedIn(404),
      why:
        "404 for every session, like the round itself: a stage list is information about an " +
        "intake and the applicant projection serves it only to those the round admits.",
    },
  },
  "/api/admissions/rounds/[roundId]/stages/[stageId]": {
    PUT: {
      expect: adminOnly(400, { approveCourse: 400 }),
      why:
        "Round authors (admin or approveCourse) meet the validation; everyone else is " +
        "forbidden before the body is read.",
    },
    DELETE: {
      expect: adminOnly(404, { approveCourse: 404 }),
      why:
        "Round authors (admin or approveCourse); the round is missing for them, everyone else " +
        "is forbidden before the read.",
    },
  },
  "/api/admissions/rounds/[roundId]/stages/[stageId]/release": {
    POST: {
      expect: adminOnly(404, { approveCourse: 404 }),
      why:
        "Round authors (admin or approveCourse); the round is missing for them, everyone else " +
        "is forbidden before the read.",
    },
  },
  "/api/admissions/rounds/[roundId]/status": {
    POST: {
      expect: adminOnly(404, { approveCourse: 404 }),
      why:
        "Round authors (admin or approveCourse); the round is missing for them, everyone else " +
        "is forbidden before the read.",
    },
  },
  "/api/auth/google/callback": {
    POST: {
      expect: everyone(303),
      why:
        "The Google redirect-mode sign-in lands here with a credential; without one, " +
        "everybody is sent back to the sign-in page with an error, cookie or not.",
    },
  },
  "/api/auth/session": {
    POST: {
      expect: everyone(400),
      why:
        "The cookie mint needs an id token; without one everybody gets the same 400, and " +
        "nothing about the caller is read first.",
    },
    DELETE: {
      expect: everyone(200),
      fields: ["ok"],
      public: "Sign-out; there is no session to protect and nothing is read.",
      why:
        "Sign-out answers ok to everyone: with a session it revokes and clears, without one " +
        "there is nothing to clear. Requested last, because it revokes the persona's cookie.",
    },
  },
  "/api/auth/session/clear": {
    POST: {
      expect: everyone(200),
      fields: ["ok"],
      public: "Cookie clear; nothing is read.",
      why:
        "Clears the cookie without revoking, for a client whose two halves drifted apart; " +
        "answers ok to everyone and reads nothing.",
    },
  },
  "/api/collaborators": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the application body is validated; every signed-in persona " +
        "meets the same 400.",
    },
    PATCH: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated; every signed-in persona meets the same " +
        "400.",
    },
  },
  "/api/collaborators/[id]": {
    POST: {
      expect: everyone(403, { admin: 400 }),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation. Deciding a collaborator application is admin only.",
    },
    DELETE: {
      expect: everyone(403, { admin: 404 }),
      why:
        "Admin only, decided before the read: every other session is forbidden and the admin " +
        "is told the id is missing.",
    },
  },
  "/api/courses/[courseId]/destroy": {
    POST: {
      expect: adminOnly(400),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation. Destroying a course needs its typed confirmation.",
    },
  },
  "/api/courses/[courseId]/destroy-manifest": {
    GET: {
      expect: adminOnly(404),
      why:
        "Admin only, decided before the read: every other session is forbidden and the admin " +
        "is told the id is missing.",
    },
  },
  "/api/courses/[courseId]/page": {
    PUT: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). Authorship is per course, so the course is read " +
        "first.",
    },
  },
  "/api/courses/[courseId]/page/generate-themes": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header).",
    },
  },
  "/api/courses/[courseId]/publish": {
    POST: {
      expect: adminOnly(404, { approveCourse: 404 }),
      why:
        "Course approvers (admin or approveCourse) may publish; the course is missing for " +
        "them, everyone else is forbidden before the read.",
    },
  },
  "/api/courses/[courseId]/templates": {
    POST: {
      expect: adminOnly(400),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation.",
    },
    GET: {
      expect: adminOnly(200, { draftCourse: 200, approveCourse: 200 }),
      fields: ["templates"],
      why:
        "Course authors (admin, draftCourse, approveCourse) read a course's templates; the " +
        "list is empty here, everyone else is forbidden.",
    },
  },
  "/api/courses/exercise-responses/[responseId]/review": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2).",
    },
  },
  "/api/courses/groups/[groupId]/attendance": {
    GET: {
      expect: adminOnly(404),
      why:
        "The register gate (gateGroupRegister) collapses missing, archived and not-yours onto " +
        "one 403 for a non-admin and tells an admin the group is missing.",
    },
    POST: {
      expect: adminOnly(404),
      why:
        "The register gate collapses missing, archived and not-yours onto one 403 for a " +
        "non-admin; an admin is told the group is missing.",
    },
    PATCH: {
      expect: adminOnly(404),
      why:
        "The register gate collapses missing, archived and not-yours onto one 403 for a " +
        "non-admin; an admin is told the group is missing.",
    },
  },
  "/api/courses/groups/[groupId]/attendance/push": {
    POST: {
      expect: adminOnly(404),
      why:
        "The register gate collapses missing, archived and not-yours onto one 403 for a " +
        "non-admin; an admin is told the group is missing.",
    },
  },
  "/api/courses/groups/[groupId]/email": {
    POST: {
      expect: adminOnly(404),
      why:
        "Group staff only, collapsed onto one 403 for a non-admin; an admin is told the group " +
        "is missing.",
    },
  },
  "/api/courses/groups/[groupId]/exercises": {
    GET: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2). A week " +
        "id is required in the query.",
    },
  },
  "/api/courses/groups/[groupId]/facilitators": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The audit's ordering low on this route.",
    },
  },
  "/api/courses/groups/[groupId]/notice": {
    POST: {
      expect: adminOnly(404),
      why:
        "Group staff only, collapsed onto one 403 for a non-admin; an admin is told the group " +
        "is missing.",
    },
  },
  "/api/courses/groups/[groupId]/pace": {
    PATCH: {
      expect: adminOnly(404),
      why:
        "Group staff only, collapsed onto one 403 for a non-admin; an admin is told the group " +
        "is missing.",
    },
  },
  "/api/courses/groups/[groupId]/participant-notes": {
    POST: {
      expect: adminOnly(404),
      why:
        "Group staff only, collapsed onto one 403 for a non-admin; an admin is told the group " +
        "is missing.",
    },
  },
  "/api/courses/groups/[groupId]/roster": {
    GET: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The audit's ordering low on this route.",
    },
  },
  "/api/courses/groups/[groupId]/session": {
    PATCH: {
      expect: adminOnly(404),
      why:
        "Group staff only, collapsed onto one 403 for a non-admin; an admin is told the group " +
        "is missing.",
    },
  },
  "/api/courses/groups/[groupId]/weeks/[weekId]": {
    PATCH: {
      expect: everyone(404),
      why:
        "404 for everyone including outsiders: the group's week is read before the session, " +
        "and a missing one answers the same to all. Recorded (F3): an anonymous caller learns " +
        "whether a group week exists.",
    },
  },
  "/api/courses/groups/[groupId]/weeks/[weekId]/fork": {
    POST: {
      expect: everyone(404),
      why:
        "404 for everyone including outsiders, the same shape as the week route (F3).",
    },
  },
  "/api/courses/me": {
    GET: {
      expect: signedIn(200),
      fields: ["runs"],
      why:
        "Any signed-in account sees its own runs; the list is empty here for every persona, " +
        "pending and rejected included.",
    },
  },
  "/api/courses/progress/[progressId]/moderate": {
    POST: {
      expect: adminOnly(400),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation.",
    },
  },
  "/api/courses/runs/[runId]/allocate": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2).",
    },
  },
  "/api/courses/runs/[runId]/allocation": {
    GET: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). Track leads are per run, so the run is read " +
        "first.",
    },
  },
  "/api/courses/runs/[runId]/allocation/publish": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header).",
    },
  },
  "/api/courses/runs/[runId]/applications": {
    GET: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). Reviewers are per run, so the run is read " +
        "first.",
    },
  },
  "/api/courses/runs/[runId]/applications/[uid]/decide": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2).",
    },
  },
  "/api/courses/runs/[runId]/applications/[uid]/notes": {
    PATCH: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header).",
    },
  },
  "/api/courses/runs/[runId]/apply": {
    POST: {
      expect: signedIn(404, { rejected: 403 }),
      why:
        "The applicant lane refuses a rejected account; everyone else meets the body " +
        "validation before the run is read.",
    },
    PATCH: {
      expect: signedIn(404, { rejected: 403 }),
      why:
        "The applicant lane (requireApplicant): a pending account is an applicant and is " +
        "admitted, a rejected one is refused, and the round or run is then missing.",
    },
    DELETE: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The applicant's own application is looked up by " +
        "run.",
    },
  },
  "/api/courses/runs/[runId]/apply-template": {
    POST: {
      expect: adminOnly(400, { approveCourse: 400 }),
      why:
        "Course authors (admin or approveCourse) meet the validation; everyone else is " +
        "forbidden before the body is read.",
    },
  },
  "/api/courses/runs/[runId]/archive": {
    PATCH: {
      expect: adminOnly(400, { approveCourse: 400 }),
      why:
        "Course authors (admin or approveCourse) meet the validation; everyone else is " +
        "forbidden before the body is read.",
    },
  },
  "/api/courses/runs/[runId]/clone-weeks": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2).",
    },
  },
  "/api/courses/runs/[runId]/comments": {
    GET: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2). A week " +
        "is required in the query.",
    },
  },
  "/api/courses/runs/[runId]/destroy": {
    POST: {
      expect: adminOnly(400),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation. Destroying a run needs its typed confirmation.",
    },
  },
  "/api/courses/runs/[runId]/destroy-manifest": {
    GET: {
      expect: adminOnly(404),
      why:
        "Admin only, decided before the read: every other session is forbidden and the admin " +
        "is told the id is missing.",
    },
  },
  "/api/courses/runs/[runId]/email": {
    POST: {
      expect: adminOnly(404),
      why:
        "Run staff only through gateRunStaff, collapsed onto one 403 for a non-admin; an " +
        "admin is told the run is missing.",
    },
  },
  "/api/courses/runs/[runId]/enrol": {
    GET: {
      expect: signedIn(404, { rejected: 403 }),
      why:
        "The enroller gate refuses a rejected account; every other session is told the run is " +
        "missing.",
    },
    POST: {
      expect: signedIn(400, { rejected: 403 }),
      why:
        "The enroller gate refuses a rejected account; everyone else meets the body " +
        "validation before the run is read.",
    },
    PATCH: {
      expect: signedIn(400, { rejected: 403 }),
      why:
        "The enroller gate refuses a rejected account; everyone else meets the body " +
        "validation before the run is read.",
    },
    DELETE: {
      expect: signedIn(404, { rejected: 403 }),
      why:
        "The enroller gate refuses a rejected account; every other session is told the run is " +
        "missing.",
    },
  },
  "/api/courses/runs/[runId]/enrol-mode": {
    PATCH: {
      expect: adminOnly(400),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation.",
    },
  },
  "/api/courses/runs/[runId]/enrolments/[uid]/reinstate": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header).",
    },
  },
  "/api/courses/runs/[runId]/enrolments/[uid]/remove": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header).",
    },
  },
  "/api/courses/runs/[runId]/exercises/[exerciseId]/submit": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2).",
    },
  },
  "/api/courses/runs/[runId]/material-notes": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2).",
    },
  },
  "/api/courses/runs/[runId]/my-exercises": {
    GET: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2). A week " +
        "is required in the query.",
    },
  },
  "/api/courses/runs/[runId]/normalise-weeks": {
    POST: {
      expect: adminOnly(404, { approveCourse: 404 }),
      why:
        "Course authors (admin or approveCourse); the run is missing for them, everyone else " +
        "is forbidden before the read.",
    },
  },
  "/api/courses/runs/[runId]/nudge": {
    GET: {
      expect: adminOnly(404),
      why:
        "Run staff only through gateRunStaff, collapsed onto one 403 for a non-admin; an " +
        "admin is told the run is missing.",
    },
    POST: {
      expect: adminOnly(404),
      why:
        "Run staff only through gateRunStaff, collapsed onto one 403 for a non-admin; an " +
        "admin is told the run is missing.",
    },
  },
  "/api/courses/runs/[runId]/overview": {
    GET: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header).",
    },
  },
  "/api/courses/runs/[runId]/retrospective": {
    GET: {
      expect: adminOnly(404, { draftCourse: 404, approveCourse: 404 }),
      why:
        "Course authors (admin, draftCourse, approveCourse) read a run's retrospective; the " +
        "run is missing for them, everyone else is forbidden before the read.",
    },
  },
  "/api/courses/runs/[runId]/roles": {
    GET: {
      expect: adminOnly(404),
      why:
        "Admin only, decided before the read: every other session is forbidden and the admin " +
        "is told the id is missing. Run roles are admin only.",
    },
    POST: {
      expect: adminOnly(404),
      why:
        "Admin only, decided before the read: every other session is forbidden and the admin " +
        "is told the id is missing. Assigning run roles is admin only.",
    },
  },
  "/api/courses/runs/[runId]/status": {
    POST: {
      expect: adminOnly(400, { approveCourse: 400 }),
      why:
        "Course authors (admin or approveCourse) meet the validation; everyone else is " +
        "forbidden before the body is read.",
    },
  },
  "/api/courses/runs/[runId]/sync-tasks": {
    POST: {
      expect: approvedOnly(403),
      why:
        "Forbidden to every session on a missing run, including admins: the run's staff is " +
        "the bar and a missing run has none. Anonymous is refused first.",
    },
  },
  "/api/courses/templates/[templateId]": {
    DELETE: {
      expect: adminOnly(404),
      why:
        "Admin only, decided before the read: every other session is forbidden and the admin " +
        "is told the id is missing.",
    },
  },
  "/api/events/[id]/archive": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2).",
    },
  },
  "/api/events/[id]/broadcast": {
    POST: {
      expect: adminOnly(404, { suCommittee: 404 }),
      why:
        "SU-recognised committee and admins may address an event's attendees; for them the " +
        "event is missing, and every other session is forbidden before the read, draftEvent " +
        "and approveEvent holders included.",
    },
  },
  "/api/events/[id]/calendar.ics": {
    GET: {
      expect: everyone(404),
      why:
        "The public calendar feed of a published event: everybody gets the same 404 for an " +
        "unknown id, and nothing about the caller is read.",
    },
  },
  "/api/events/[id]/cancel": {
    POST: {
      expect: adminOnly(404, { approveEvent: 404 }),
      why:
        "Event approvers (admin or approveEvent) may cancel; for them the event is missing, " +
        "everyone else is forbidden before the read.",
    },
  },
  "/api/events/[id]/collaborators": {
    GET: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). Authorship is per event.",
    },
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). Authorship is per event.",
    },
  },
  "/api/events/[id]/delete": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). Authorship is per event.",
    },
  },
  "/api/events/[id]/publish": {
    POST: {
      expect: adminOnly(404, { approveEvent: 404 }),
      why:
        "Event approvers (admin or approveEvent) may publish; for them the event is missing, " +
        "everyone else is forbidden before the read.",
    },
  },
  "/api/events/[id]/rsvp": {
    POST: {
      expect: everyone(400),
      why:
        "The public RSVP: the per-IP throttle, then reCAPTCHA before the event is read, so a " +
        "tokenless request from anybody meets the same 400.",
    },
  },
  "/api/events/[id]/rsvp/[rsvpId]/approve": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The event decides who may approve.",
    },
  },
  "/api/events/[id]/rsvp/[rsvpId]/approve-change": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The event decides who may approve.",
    },
  },
  "/api/events/[id]/rsvp/[rsvpId]/cancel": {
    POST: {
      expect: everyone(404),
      why:
        "The attendee's own signed link: without a valid token everybody, cookie or not, is " +
        "told the RSVP is missing.",
    },
  },
  "/api/events/[id]/rsvp/[rsvpId]/deny": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The event decides who may deny.",
    },
  },
  "/api/events/[id]/rsvp/[rsvpId]/deny-change": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The event decides who may deny.",
    },
  },
  "/api/events/[id]/rsvp/[rsvpId]/request-change": {
    POST: {
      expect: everyone(404),
      why:
        "The attendee's own signed link: without a valid token everybody, cookie or not, is " +
        "told the RSVP is missing.",
    },
  },
  "/api/events/[id]/test-rsvps": {
    POST: {
      expect: adminOnly(400),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation. Test attendees are an admin's tool.",
    },
    DELETE: {
      expect: adminOnly(200),
      fields: ["deleted", "ok"],
      why:
        "Admin only; removing test attendees from an unknown event deletes nothing and " +
        "answers ok.",
    },
  },
  "/api/events/[id]/update": {
    POST: {
      expect: adminOnly(404, { approveEvent: 404 }),
      why:
        "Event approvers (admin or approveEvent) may edit a live event; for them the event is " +
        "missing, everyone else is forbidden before the read.",
    },
  },
  "/api/members/roster": {
    GET: {
      expect: everyone(200, { anonymous: 403, pending: 403, rejected: 403 }),
      fields: ["members"],
      why:
        "Every approved account may read a roster derived from its own task memberships, " +
        "empty here; pending, rejected and outsiders are forbidden with one 403.",
    },
  },
  "/api/membership/me": {
    GET: {
      expect: signedIn(200),
      fields: ["currentPeriod", "history", "membership"],
      why:
        "Any signed-in account reads its own membership through projectMembershipForMe; " +
        "nothing about anybody else is in it.",
    },
  },
  "/api/newsletter/[id]/send": {
    POST: {
      expect: everyone(403, { admin: 404, approveNewsletter: 404 }),
      why:
        "Newsletter approvers (admin or approveNewsletter) may send; for them the draft is " +
        "missing, and every other session, a missing one included, is forbidden with one 403.",
    },
  },
  "/api/newsletter/[id]/send-test": {
    POST: {
      expect: everyone(403, { admin: 404, draftNewsletter: 404, approveNewsletter: 404 }),
      why:
        "Drafters and approvers (admin, draftNewsletter, approveNewsletter) may test-send; " +
        "for them the draft is missing, everyone else is forbidden with one 403.",
    },
  },
  "/api/newsletter/preview": {
    POST: {
      expect: everyone(403, { admin: 200, draftNewsletter: 200, approveNewsletter: 200 }),
      why:
        "Drafters and approvers (admin, draftNewsletter, approveNewsletter) may render a " +
        "preview of what they post; everyone else is forbidden with one 403.",
    },
  },
  "/api/push/subscribe": {
    POST: {
      expect: signedIn(400, { pending: 401, rejected: 401 }),
      why:
        "Approved accounts only; a pending, rejected or missing session gets the same 401, " +
        "and an approved one meets the subscription validation.",
    },
  },
  "/api/push/test": {
    POST: {
      expect: signedIn(200, { pending: 401, rejected: 401 }),
      fields: ["deferred", "failed", "ok", "pruned", "retried", "sent"],
      why:
        "Approved accounts only; a pending, rejected or missing session gets the same 401, " +
        "and an approved one gets its own delivery counts (zero here).",
    },
  },
  "/api/push/unsubscribe": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the endpoint is validated; every signed-in persona meets the " +
        "same 400.",
    },
  },
  "/api/register": {
    POST: {
      expect: everyone(400),
      why:
        "Public registration: the per-IP throttle, then the address validation; an empty body " +
        "from anybody meets the same 400 before the captcha is spent.",
    },
  },
  "/api/register/password-set": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the password is validated; every signed-in persona meets the " +
        "same 400 on an empty body.",
    },
  },
  "/api/register/profile-complete": {
    POST: {
      expect: signedIn(200),
      fields: ["ok"],
      why:
        "Any signed-in account marks its own registration row as profile-complete; the write " +
        "is to the caller's own row and answers ok whether or not the row exists.",
    },
  },
  "/api/register/resend": {
    POST: {
      expect: everyone(200),
      fields: ["cooldownSeconds", "ok"],
      public: "A public, throttled re-send that answers one uniform body.",
      why:
        "Public re-send: throttled per IP and answered with one uniform body whatever the " +
        "address's state, so everybody gets the same 200.",
    },
  },
  "/api/scheduler/tick": {
    POST: {
      expect: everyone(404),
      why:
        "The bearer-secret endpoint answers 404 to everything without the secret, by design, " +
        "so a cookie is worth nothing here.",
    },
  },
  "/api/subscriptions": {
    POST: {
      expect: everyone(400),
      why:
        "The public subscribe form: throttled per IP, then the body is validated; an empty " +
        "body from anybody meets the same 400.",
    },
  },
  "/api/subscriptions/confirm": {
    GET: {
      expect: everyone(400),
      why:
        "The confirmation preview page: without a signed token everybody gets the same 400 " +
        "page.",
    },
    POST: {
      expect: everyone(400),
      why:
        "The confirmation commit: without a signed token everybody gets the same 400 page.",
    },
  },
  "/api/subscriptions/sync": {
    POST: {
      expect: everyone(200, { anonymous: 403 }),
      fields: ["ok"],
      why:
        "Any signed-in account syncs its own subscription rows to its own preferences; an " +
        "outsider has nothing to sync and is forbidden.",
    },
  },
  "/api/tasks/[id]/delete": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The task's own roster decides.",
    },
  },
  "/api/tasks/[id]/delete-block": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2).",
    },
  },
  "/api/tasks/[id]/delete-subtask": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2).",
    },
  },
  "/api/tasks/[id]/notify": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2). A " +
        "comment id is required.",
    },
  },
  "/api/tasks/[id]/notify-member": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2).",
    },
  },
  "/api/tasks/[id]/send-for-review": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The task's own roster decides.",
    },
  },
  "/api/tasks/[id]/send-initial-notifications": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The task's own roster decides.",
    },
  },
  "/api/tasks/[id]/send-review-outcome": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2).",
    },
  },
  "/api/unsubscribe": {
    GET: {
      expect: everyone(400),
      why:
        "The unsubscribe preview page: without a signed token everybody gets the same 400 " +
        "page.",
    },
    POST: {
      expect: everyone(400),
      why:
        "The unsubscribe commit: without a signed token everybody gets the same 400 page.",
    },
  },
  "/api/verify-email/confirm": {
    POST: {
      expect: everyone(400),
      why:
        "The magic-link confirm: without a signed token everybody gets the same 400.",
    },
  },
  "/api/verify-email/reconcile": {
    POST: {
      expect: signedIn(200),
      fields: ["ok", "stamped"],
      why:
        "Any signed-in account may ask for its own verified token to be stamped; nothing to " +
        "stamp answers ok with stamped false.",
    },
  },
  "/api/verify-email/send": {
    POST: {
      expect: signedIn(400),
      why:
        "Session required (before the address is validated, the #209 order), then the body; " +
        "every signed-in persona meets the same 400.",
    },
  },
  "/api/webhooks/resend-events": {
    POST: {
      expect: everyone(500),
      why:
        "With no RESEND_WEBHOOK_SECRET on the local server the webhook fails closed with a " +
        "500 for everybody. RECORDED (F4): unconfigured, it should refuse with a 4xx rather " +
        "than report a server error; on a deployed backend the secret is present and an " +
        "unsigned body is refused.",
    },
  },
  "/api/worksheets/[worksheetId]": {
    DELETE: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). Authorship, with the library-tier floor, is per " +
        "worksheet.",
    },
  },
  "/api/worksheets/circulations": {
    POST: {
      expect: adminOnly(404, { circulateWorksheet: 404 }),
      why:
        "Circulators (admin or circulateWorksheet) may send a worksheet; for them the " +
        "worksheet is missing, everyone else is forbidden before the read.",
    },
  },
  "/api/worksheets/circulations/[circulationId]/aggregate": {
    GET: {
      expect: signedIn(400),
      why:
        "Session required, then the body is validated before the document is read or any role " +
        "applied, so every signed-in persona meets the same 400 on an empty body (F2). A " +
        "question id is required in the query.",
    },
  },
  "/api/worksheets/circulations/[circulationId]/close": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The circulation's staff decides.",
    },
  },
  "/api/worksheets/circulations/[circulationId]/destroy": {
    POST: {
      expect: adminOnly(400),
      why:
        "Admin only, decided before the body is read: every other session is forbidden and " +
        "the admin meets the validation. Destroying a circulation needs its typed " +
        "confirmation.",
    },
  },
  "/api/worksheets/circulations/[circulationId]/destroy-manifest": {
    GET: {
      expect: adminOnly(404),
      why:
        "Admin only, decided before the read: every other session is forbidden and the admin " +
        "is told the id is missing.",
    },
  },
  "/api/worksheets/circulations/[circulationId]/export": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The circulation's staff decides.",
    },
  },
  "/api/worksheets/circulations/[circulationId]/notify-copy-edited": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The circulation's staff decides.",
    },
  },
  "/api/worksheets/circulations/[circulationId]/recipients": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The circulation's staff decides.",
    },
  },
  "/api/worksheets/circulations/[circulationId]/responses/[uid]/return": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The circulation's staff decides.",
    },
  },
  "/api/worksheets/circulations/[circulationId]/responses/[uid]/unfreeze": {
    POST: {
      expect: adminOnly(404),
      why:
        "Admin only, decided before the read: every other session is forbidden and the admin " +
        "is told the id is missing. Unfreezing a response is admin only.",
    },
  },
  "/api/worksheets/circulations/[circulationId]/submit": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The recipient's own response decides.",
    },
  },
  "/api/worksheets/circulations/[circulationId]/upload": {
    POST: {
      expect: signedIn(404),
      why:
        "Session required, then the document is read and its own membership decides; with no " +
        "role floor before the read, a pending or rejected account is told the id is missing " +
        "(finding F1 in the registry header). The recipient's own response decides.",
    },
  },
  "/api/worksheets/recipients": {
    GET: {
      expect: everyone(403, { admin: 200, circulateWorksheet: 200 }),
      fields: ["members"],
      why:
        "Circulators (admin or circulateWorksheet) may read the committee roster this route " +
        "hands out; everyone else is forbidden with one 403.",
    },
  },
};

/** Pages under src/app/(app): key -> { expect, why }. */
export const PAGES = {
  "/(app)/admin/(admin-only)": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200 }),
    why:
      "The (admin-only) tree: requireAdminPage sends every non-admin to the dashboard, the " +
      "course and membership permission holders included, because the admin front door " +
      "admits them and this inner gate is what keeps them out of the rest.",
  },
  "/(app)/admin/(admin-only)/collaborators": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200 }),
    why:
      "The (admin-only) tree: requireAdminPage sends every non-admin to the dashboard, the " +
      "course and membership permission holders included, because the admin front door " +
      "admits them and this inner gate is what keeps them out of the rest.",
  },
  "/(app)/admin/(admin-only)/danger-zone": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200 }),
    why:
      "The (admin-only) tree: requireAdminPage sends every non-admin to the dashboard, the " +
      "course and membership permission holders included, because the admin front door " +
      "admits them and this inner gate is what keeps them out of the rest.",
  },
  "/(app)/admin/(admin-only)/deliverability": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200 }),
    why:
      "The (admin-only) tree: requireAdminPage sends every non-admin to the dashboard, the " +
      "course and membership permission holders included, because the admin front door " +
      "admits them and this inner gate is what keeps them out of the rest.",
  },
  "/(app)/admin/(admin-only)/email-designs": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200 }),
    why:
      "The (admin-only) tree: requireAdminPage sends every non-admin to the dashboard, the " +
      "course and membership permission holders included, because the admin front door " +
      "admits them and this inner gate is what keeps them out of the rest.",
  },
  "/(app)/admin/(admin-only)/email-designs/[templateId]": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200 }),
    why:
      "The (admin-only) tree: requireAdminPage sends every non-admin to the dashboard, the " +
      "course and membership permission holders included, because the admin front door " +
      "admits them and this inner gate is what keeps them out of the rest.",
  },
  "/(app)/admin/(admin-only)/email-designs/course/[templateId]": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200 }),
    why:
      "The (admin-only) tree: requireAdminPage sends every non-admin to the dashboard, the " +
      "course and membership permission holders included, because the admin front door " +
      "admits them and this inner gate is what keeps them out of the rest.",
  },
  "/(app)/admin/(admin-only)/members": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200 }),
    why:
      "The (admin-only) tree: requireAdminPage sends every non-admin to the dashboard, the " +
      "course and membership permission holders included, because the admin front door " +
      "admits them and this inner gate is what keeps them out of the rest.",
  },
  "/(app)/admin/(admin-only)/newsletter": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200 }),
    why:
      "The (admin-only) tree: requireAdminPage sends every non-admin to the dashboard, the " +
      "course and membership permission holders included, because the admin front door " +
      "admits them and this inner gate is what keeps them out of the rest.",
  },
  "/(app)/admin/(admin-only)/projects": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200 }),
    why:
      "The (admin-only) tree: requireAdminPage sends every non-admin to the dashboard, the " +
      "course and membership permission holders included, because the admin front door " +
      "admits them and this inner gate is what keeps them out of the rest.",
  },
  "/(app)/admin/(admin-only)/registrations": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200 }),
    why:
      "The (admin-only) tree: requireAdminPage sends every non-admin to the dashboard, the " +
      "course and membership permission holders included, because the admin front door " +
      "admits them and this inner gate is what keeps them out of the rest.",
  },
  "/(app)/admin/(admin-only)/site-status": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200 }),
    why:
      "The (admin-only) tree: requireAdminPage sends every non-admin to the dashboard, the " +
      "course and membership permission holders included, because the admin front door " +
      "admits them and this inner gate is what keeps them out of the rest.",
  },
  "/(app)/admin/(admin-only)/subscriptions": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200 }),
    why:
      "The (admin-only) tree: requireAdminPage sends every non-admin to the dashboard, the " +
      "course and membership permission holders included, because the admin front door " +
      "admits them and this inner gate is what keeps them out of the rest.",
  },
  "/(app)/admin/(admin-only)/task-templates": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200 }),
    why:
      "The (admin-only) tree: requireAdminPage sends every non-admin to the dashboard, the " +
      "course and membership permission holders included, because the admin front door " +
      "admits them and this inner gate is what keeps them out of the rest.",
  },
  "/(app)/admin/admissions": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200, approveCourse: 200 }),
    why:
      "The admissions console: requireAdmissionsPage admits round authors (admin or " +
      "approveCourse) and named reviewers; a draftCourse holder passes the admin front door " +
      "and is sent on to the dashboard here.",
  },
  "/(app)/admin/admissions/[roundId]": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200, approveCourse: 200 }),
    why:
      "The admissions console: requireAdmissionsPage admits round authors (admin or " +
      "approveCourse) and named reviewers; a draftCourse holder passes the admin front door " +
      "and is sent on to the dashboard here. A missing round renders the console's " +
      "not-found state for those admitted.",
  },
  "/(app)/admin/admissions/[roundId]/appointments": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200, approveCourse: 200 }),
    why:
      "The admissions console: requireAdmissionsPage admits round authors (admin or " +
      "approveCourse) and named reviewers; a draftCourse holder passes the admin front door " +
      "and is sent on to the dashboard here. A missing round renders the console's " +
      "not-found state for those admitted.",
  },
  "/(app)/admin/courses": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200, draftCourse: 200, approveCourse: 200 }),
    why:
      "The course authoring tree: requireCourseAuthorPage admits admins and draftCourse and " +
      "approveCourse holders and sends everyone else to the dashboard; a missing course or " +
      "run renders the tree's own not-found state.",
  },
  "/(app)/admin/courses/[courseId]": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200, draftCourse: 200, approveCourse: 200 }),
    why:
      "The course authoring tree: requireCourseAuthorPage admits admins and draftCourse and " +
      "approveCourse holders and sends everyone else to the dashboard; a missing course or " +
      "run renders the tree's own not-found state.",
  },
  "/(app)/admin/courses/[courseId]/page": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200, draftCourse: 200, approveCourse: 200 }),
    why:
      "The course authoring tree: requireCourseAuthorPage admits admins and draftCourse and " +
      "approveCourse holders and sends everyone else to the dashboard; a missing course or " +
      "run renders the tree's own not-found state.",
  },
  "/(app)/admin/courses/[courseId]/runs/[runId]": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200, draftCourse: 200, approveCourse: 200 }),
    why:
      "The course authoring tree: requireCourseAuthorPage admits admins and draftCourse and " +
      "approveCourse holders and sends everyone else to the dashboard; a missing course or " +
      "run renders the tree's own not-found state.",
  },
  "/(app)/admin/courses/[courseId]/runs/[runId]/allocation": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200, draftCourse: 200, approveCourse: 200 }),
    why:
      "The course authoring tree: requireCourseAuthorPage admits admins and draftCourse and " +
      "approveCourse holders and sends everyone else to the dashboard; a missing course or " +
      "run renders the tree's own not-found state.",
  },
  "/(app)/admin/courses/[courseId]/runs/[runId]/applications": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200, draftCourse: 200, approveCourse: 200 }),
    why:
      "The course authoring tree: requireCourseAuthorPage admits admins and draftCourse and " +
      "approveCourse holders and sends everyone else to the dashboard; a missing course or " +
      "run renders the tree's own not-found state.",
  },
  "/(app)/admin/courses/[courseId]/runs/[runId]/retrospective": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200, draftCourse: 200, approveCourse: 200 }),
    why:
      "The course authoring tree: requireCourseAuthorPage admits admins and draftCourse and " +
      "approveCourse holders and sends everyone else to the dashboard; a missing course or " +
      "run renders the tree's own not-found state.",
  },
  "/(app)/admin/courses/[courseId]/runs/[runId]/weeks/[weekId]": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200, draftCourse: 200, approveCourse: 200 }),
    why:
      "The course authoring tree: requireCourseAuthorPage admits admins and draftCourse and " +
      "approveCourse holders and sends everyone else to the dashboard; a missing course or " +
      "run renders the tree's own not-found state.",
  },
  "/(app)/admin/membership": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200, manageMembership: 200 }),
    why:
      "The membership console: requireMembershipPage admits admins and manageMembership " +
      "holders and sends everyone else to the dashboard.",
  },
  "/(app)/committee/tasks": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", suCommittee: 200, admin: 200 }),
    why:
      "The committee task board is SU-recognised committee and admins only, because it " +
      "shows every committee-visibility task and the member roster; a non-SU committee " +
      "member and everyone else is sent to the dashboard.",
  },
  "/(app)/credentials": {
    expect: everyone(200, { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "The authed shell: a stranger is sent to sign in by the proxy, a pending account to " +
      "the waiting page and a rejected one home by the layout, and every approved account " +
      "renders it. The credentials page is a placeholder today.",
  },
  "/(app)/dashboard": {
    expect: everyone(200, { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "The authed shell: a stranger is sent to sign in by the proxy, a pending account to " +
      "the waiting page and a rejected one home by the layout, and every approved account " +
      "renders it.",
  },
  "/(app)/events/manage": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", committee: 200, suCommittee: 200, admin: 200, draftEvent: 200, approveEvent: 200 }),
    why:
      "The events area is open to the whole committee and to draftEvent and approveEvent " +
      "holders; a plain member or another permission holder is sent to the dashboard by the " +
      "events layout. A missing event renders the area's own not-found state.",
  },
  "/(app)/events/manage/[id]": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", committee: 200, suCommittee: 200, admin: 200, draftEvent: 200, approveEvent: 200 }),
    why:
      "The events area is open to the whole committee and to draftEvent and approveEvent " +
      "holders; a plain member or another permission holder is sent to the dashboard by the " +
      "events layout. A missing event renders the area's own not-found state.",
  },
  "/(app)/events/manage/[id]/attendees": {
    expect: everyone(["dashboard", "event"], { anonymous: "login", pending: "pendingApproval", rejected: "home", committee: "event", suCommittee: 200, admin: 200, draftEvent: "event", approveEvent: "event" }),
    why:
      "Attendee PII is SU-recognised committee and admins only: the attendees page sends " +
      "any other visitor the events layout admits (non-SU committee, draftEvent, " +
      "approveEvent) back to the event, while the layout sends a plain member or another " +
      "permission holder to the dashboard. Both redirects are in the stream for the latter, " +
      "so either is accepted.",
  },
  "/(app)/events/manage/[id]/preview": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", committee: 200, suCommittee: 200, admin: 200, draftEvent: 200, approveEvent: 200 }),
    why:
      "The events area is open to the whole committee and to draftEvent and approveEvent " +
      "holders; a plain member or another permission holder is sent to the dashboard by the " +
      "events layout. A missing event renders the area's own not-found state.",
  },
  "/(app)/events/manage/new": {
    expect: everyone(["dashboard", "eventsManage"], { anonymous: "login", pending: "pendingApproval", rejected: "home", committee: "eventsManage", suCommittee: "eventsManage", admin: 200, draftEvent: 200, approveEvent: "eventsManage" }),
    why:
      "Creating an event needs draftEvent (or admin): the page sends any other visitor the " +
      "events layout admits back to the events list, while the layout sends a plain member " +
      "or another permission holder to the dashboard. Both redirects are in the stream for " +
      "the latter, so either is accepted.",
  },
  "/(app)/learn": {
    expect: everyone(200, { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "The authed shell: a stranger is sent to sign in by the proxy, a pending account to " +
      "the waiting page and a rejected one home by the layout, and every approved account " +
      "renders it. The learn hub lists the account's own runs, empty here.",
  },
  "/(app)/learn/[runId]": {
    expect: everyone("learn", { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "A run under /learn: the run layout sends every approved account back to /learn when " +
      "the run is missing, and the run's own roster decides the rest once it exists.",
  },
  "/(app)/learn/[runId]/admissions": {
    expect: everyone("learn", { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "A run under /learn: the run layout sends every approved account back to /learn when " +
      "the run is missing, and the run's own roster decides the rest once it exists.",
  },
  "/(app)/learn/[runId]/email": {
    expect: everyone("learn", { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "A run under /learn: the run layout sends every approved account back to /learn when " +
      "the run is missing, and the run's own roster decides the rest once it exists.",
  },
  "/(app)/learn/[runId]/group/[groupId]": {
    expect: everyone("learn", { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "A run under /learn: the run layout sends every approved account back to /learn when " +
      "the run is missing, and the run's own roster decides the rest once it exists.",
  },
  "/(app)/learn/[runId]/group/[groupId]/edit": {
    expect: everyone("learn", { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "A run under /learn: the run layout sends every approved account back to /learn when " +
      "the run is missing, and the run's own roster decides the rest once it exists.",
  },
  "/(app)/learn/[runId]/group/[groupId]/edit/[weekId]": {
    expect: everyone("learn", { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "A run under /learn: the run layout sends every approved account back to /learn when " +
      "the run is missing, and the run's own roster decides the rest once it exists.",
  },
  "/(app)/learn/[runId]/group/[groupId]/email": {
    expect: everyone("learn", { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "A run under /learn: the run layout sends every approved account back to /learn when " +
      "the run is missing, and the run's own roster decides the rest once it exists.",
  },
  "/(app)/learn/[runId]/group/[groupId]/review": {
    expect: everyone("learn", { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "A run under /learn: the run layout sends every approved account back to /learn when " +
      "the run is missing, and the run's own roster decides the rest once it exists.",
  },
  "/(app)/learn/[runId]/nudge": {
    expect: everyone("learn", { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "A run under /learn: the run layout sends every approved account back to /learn when " +
      "the run is missing, and the run's own roster decides the rest once it exists.",
  },
  "/(app)/learn/[runId]/progress": {
    expect: everyone("learn", { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "A run under /learn: the run layout sends every approved account back to /learn when " +
      "the run is missing, and the run's own roster decides the rest once it exists.",
  },
  "/(app)/learn/[runId]/weeks/[n]": {
    expect: everyone("learn", { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "A run under /learn: the run layout sends every approved account back to /learn when " +
      "the run is missing, and the run's own roster decides the rest once it exists.",
  },
  "/(app)/newsletter": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200, draftNewsletter: 200, approveNewsletter: 200 }),
    why:
      "The newsletter tools admit admins and draftNewsletter and approveNewsletter holders; " +
      "everyone else is sent to the dashboard by the newsletter layout.",
  },
  "/(app)/newsletter/[id]": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200, draftNewsletter: 200, approveNewsletter: 200 }),
    why:
      "The newsletter tools admit admins and draftNewsletter and approveNewsletter holders; " +
      "everyone else is sent to the dashboard by the newsletter layout. A missing draft " +
      "renders the tool's own not-found state for those admitted.",
  },
  "/(app)/newsletter/new": {
    expect: everyone(["dashboard", "newsletter"], { anonymous: "login", pending: "pendingApproval", rejected: "home", admin: 200, draftNewsletter: 200, approveNewsletter: "newsletter" }),
    why:
      "Drafting needs draftNewsletter (or admin): the page sends an approveNewsletter " +
      "holder, whom the layout admits, back to the newsletter list, while the layout sends " +
      "everyone else to the dashboard. Both redirects are in the stream for the latter, so " +
      "either is accepted.",
  },
  "/(app)/profile": {
    expect: everyone(200, { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "The authed shell: a stranger is sent to sign in by the proxy, a pending account to " +
      "the waiting page and a rejected one home by the layout, and every approved account " +
      "renders it.",
  },
  "/(app)/tasks": {
    expect: everyone(200, { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "The authed shell: a stranger is sent to sign in by the proxy, a pending account to " +
      "the waiting page and a rejected one home by the layout, and every approved account " +
      "renders it. My Work shows only the account's own tasks.",
  },
  "/(app)/worksheets/(author)": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", committee: 200, suCommittee: 200, admin: 200 }),
    why:
      "The worksheet library is the library tier (committee and admin); everyone else is " +
      "sent to the dashboard by the author layout. A missing document renders the library's " +
      "own not-found state.",
  },
  "/(app)/worksheets/(author)/[worksheetId]": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", committee: 200, suCommittee: 200, admin: 200 }),
    why:
      "The worksheet library is the library tier (committee and admin); everyone else is " +
      "sent to the dashboard by the author layout. A missing document renders the library's " +
      "own not-found state.",
  },
  "/(app)/worksheets/(author)/[worksheetId]/circulations/[circulationId]": {
    expect: everyone("dashboard", { anonymous: "login", pending: "pendingApproval", rejected: "home", committee: 200, suCommittee: 200, admin: 200 }),
    why:
      "The worksheet library is the library tier (committee and admin); everyone else is " +
      "sent to the dashboard by the author layout. A missing document renders the library's " +
      "own not-found state.",
  },
  "/(app)/worksheets/respond/[circulationId]": {
    expect: everyone(200, { anonymous: "login", pending: "pendingApproval", rejected: "home" }),
    why:
      "The authed shell: a stranger is sent to sign in by the proxy, a pending account to " +
      "the waiting page and a rejected one home by the layout, and every approved account " +
      "renders it. The respond page is for the recipient the circulation names; a missing " +
      "circulation renders its own not-found state for any approved account, and the " +
      "response itself is client-direct behind the rules.",
  },
};
