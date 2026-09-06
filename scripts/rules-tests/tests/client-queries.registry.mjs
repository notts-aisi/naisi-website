/**
 * The registry behind `client-queries.test.mjs`: one entry per distinct
 * (file, collection path, clause set) READ that `src` issues through the
 * Firestore client SDK, and, for every entry, who is allowed to run it.
 *
 * WHY A REGISTRY RATHER THAN A LIST OF ASSERTIONS. Firestore judges a `list`
 * or a `listen` by the QUERY'S SHAPE, not by the rows it returns: a query
 * whose shape could match a document the rule forbids is refused wholesale,
 * silently, and with no document in the collection needed to trigger it. An
 * admin never sees that happen, because every rule in `firestore.rules` gives
 * an admin a resource-independent branch that matches the whole collection.
 * So the failure lands on exactly the people nobody tests as, and it lands as
 * an empty panel rather than an error. Three of those shipped this year:
 *
 *   1. `/profile`'s subscriptions listener carried one clause (`audienceId`)
 *      from 6 May 2026 until commit 7e6c38c, so the Email preferences grid was
 *      denied for every non-admin and showed nothing.
 *   2. `RoundEditor`'s unfiltered `courseRuns` list is refused for an
 *      appointed admissions reviewer holding no course key, under the run rule
 *      narrowed in V3 W3 PR20, even when no draft run exists.
 *   3. `admissions.test.mjs`'s own member control had to grow
 *      `where("status", "!=", "draft")` for the same reason.
 *
 * Each entry therefore states, in one place: the shape as the scanner reads it
 * out of `src`, the gate the caller sits behind, the concrete executable form
 * (`run`) with the fixtures it needs (`seed`), and an outcome for EVERY base
 * persona, so no audience is left silent. A "refused" here is a decision
 * somebody wrote down, not an absence.
 *
 * HOW TO ADD ONE. The test fails with the file, line and shape of any read it
 * cannot match, and fails again if an entry no longer matches anything in
 * `src`. Copy the shape out of that failure, name the gate honestly (open the
 * page's `layout.tsx`, do not guess), and give every base persona an outcome.
 * If a persona who can reach the page comes back "refused", that is a finding
 * to raise, not a line to write down and move past.
 *
 * COUNT AGGREGATIONS. `getCountFromServer` is judged on the same shape as the
 * equivalent `list`, so the three count sites here are proven with a `get()`
 * of the identical query. The entry says so in its reason.
 *
 * LISTENS. Around forty entries stand for `onSnapshot` sites. A listen is
 * judged on the same shape as the equivalent `list`, so every one of them is
 * executed as a `get()` of the identical query, and that substitution is the
 * only way in which the executable form differs from the source.
 *
 * SHARED KEYS. An entry may share its scanner key (file, path, clauses) with
 * one other entry when the FIXTURE is the interesting variable: the two
 * `adminLocks` id shapes, and a task the viewer is and is not on. The stale
 * check then sees the key through either entry, so both carry
 * `sharesKeyWith` and the suite checks the pair is symmetric.
 *
 * UNRESOLVED ENTRIES carry `pins`: the literal call-site text each declared
 * shape was read from, checked against `src` on every run, because the
 * scanner cannot match those shapes and prose alone would never go stale.
 * `UNRESOLVED_SITE_COUNTS` at the foot of the file states how many unreadable
 * reads each declared file carries, so a second one cannot ride the first.
 *
 * SINGLE-DOCUMENT READS evaluate against `resource.data`, so their entries
 * carry a `docShape` naming which document the fixture stands for, and their
 * `seed` writes it. A missing document is not neutral: a rule that
 * dereferences `resource.data` refuses a read of a document that does not
 * exist, which is consequence 3 in docs/courses-ops.md.
 */

/**
 * The hats a read can be issued under. `uid` is used even for the signed-out
 * visitor, so an entry's `run` never has to branch: it addresses a document id
 * that simply has no owner.
 *
 * The six base personas are mandatory on every entry. The permission variants
 * are opt-in, and belong on any entry whose rule keys off `users.permissions`,
 * because that is the axis on which a plain member reaches a staff surface.
 */
export const PERSONAS = [
  { key: "signed-out", uid: "visitor", anon: true },
  { key: "pending", uid: "pending1", data: { role: "pending" } },
  { key: "member", uid: "member1", data: { role: "member" } },
  { key: "committee", uid: "committee1", data: { role: "committee" } },
  {
    key: "su-committee",
    uid: "sucom1",
    data: { role: "committee", suRecognised: true },
  },
  { key: "admin", uid: "admin1", data: { role: "admin" } },
  {
    key: "member+draftCourse",
    uid: "drafter-course",
    data: { role: "member", permissions: { draftCourse: true } },
  },
  {
    key: "member+approveCourse",
    uid: "approver-course",
    data: { role: "member", permissions: { approveCourse: true } },
  },
  {
    key: "member+draftNewsletter",
    uid: "drafter-news",
    data: { role: "member", permissions: { draftNewsletter: true } },
  },
  {
    key: "member+approveNewsletter",
    uid: "approver-news",
    data: { role: "member", permissions: { approveNewsletter: true } },
  },
  {
    key: "member+draftEvent",
    uid: "drafter-event",
    data: { role: "member", permissions: { draftEvent: true } },
  },
  {
    key: "member+approveEvent",
    uid: "approver-event",
    data: { role: "member", permissions: { approveEvent: true } },
  },
];

/** Every entry must give each of these an outcome. Nothing may be silent. */
export const BASE_PERSONAS = [
  "signed-out",
  "pending",
  "member",
  "committee",
  "su-committee",
  "admin",
];

/** The course permission holders, who reach `/admin/courses` as plain members. */
const COURSE_STAFF = {
  "member+draftCourse": "allowed",
  "member+approveCourse": "allowed",
};
const COURSE_STAFF_REFUSED = {
  "member+draftCourse": "refused",
  "member+approveCourse": "refused",
};

/** The newsletter and events permission holders, same idea one feature over. */
const NEWSLETTER_STAFF = {
  "member+draftNewsletter": "allowed",
  "member+approveNewsletter": "allowed",
};
const EVENT_STAFF = {
  "member+draftEvent": "allowed",
  "member+approveEvent": "allowed",
};

/** Somebody who is not the persona under test, for "not mine" fixtures. */
const OTHER = "someone-else";

const RUN_ID = "guard-run";
const GROUP_ID = "guard-group";
const WEEK_ID = "w01";
const COURSE_ID = "guard-course";
const EVENT_ID = "guard-event";
const DRAFT_ID = "guard-draft";

/** A run as the authoring routes write it, at its most closed status. */
function draftRun(overrides = {}) {
  return {
    courseId: COURSE_ID,
    label: "Guard run",
    status: "draft",
    authorUid: OTHER,
    trackLeadUids: [],
    archived: false,
    ...overrides,
  };
}

/** A committee-visibility task with whatever roster the caller wants. */
function taskDoc(overrides = {}) {
  return {
    title: "Guard task",
    status: "todo",
    visibility: "committee",
    creatorUid: OTHER,
    completerUids: [],
    reviewerUids: [],
    subtasks: [],
    blocks: [],
    archived: false,
    ...overrides,
  };
}

/** The id `useTask` and the task subcollection hooks address for a persona. */
const taskId = (p) => `task__${p.uid}`;

const WORKSHEET_ID = "guard-worksheet";
const FOLDER_ID = "guard-folder";
const CIRC_ID = "guard-circulation";

/**
 * A library worksheet as the editor saves it: somebody else's, and not private.
 * `private` is written on every fixture because the read rule compares the
 * field bare (`resource.data.private == false`) so the query-shape analyser can
 * discharge it, and a document missing the key would deny by evaluation error.
 */
function worksheetDoc(overrides = {}) {
  return {
    title: "Guard worksheet",
    description: "",
    folderId: null,
    authorUid: OTHER,
    private: false,
    items: [],
    ...overrides,
  };
}

/**
 * One act of sending, as POST /api/worksheets/circulations writes it. Only
 * `staffUids` matters to the rules; the rest is here so a fixture reads like a
 * real document rather than a stub whose missing fields might be load-bearing.
 */
function circulationDoc(overrides = {}) {
  return {
    worksheetId: WORKSHEET_ID,
    title: "Guard worksheet",
    description: "",
    items: [],
    senderUid: OTHER,
    authorUid: OTHER,
    reviewerUids: [],
    staffUids: [OTHER],
    status: "open",
    anonymity: "named",
    source: { kind: "worksheet" },
    recipientCount: 1,
    submittedCount: 0,
    reviewedCount: 0,
    ...overrides,
  };
}

/**
 * One recipient's response. The uid is a parameter rather than an override
 * because the DOCUMENT ID is the recipient's uid and the field has to agree
 * with it: the rules bind the two structurally, and a fixture that let them
 * drift would prove the wrong thing.
 */
function responseDoc(uid, overrides = {}) {
  return {
    uid,
    circulationId: CIRC_ID,
    taskId: `task__${uid}`,
    state: "not-opened",
    answers: {},
    addedByUid: OTHER,
    ...overrides,
  };
}

/**
 * One recipient's review: the staff notes and scores about their answers, at a
 * document id that is the REVIEWED person's uid rather than the reviewer's.
 * Nothing in the read rule dereferences this data (the gate is the parent's
 * `staffUids`), so the fields are here to make the fixture read like the
 * document the panel writes rather than because a clause needs one.
 */
function reviewDoc(overrides = {}) {
  return {
    perQuestion: { q1: { feedback: "Clear and to the point.", score: 80 } },
    overall: "Good work overall.",
    updatedByUid: OTHER,
    ...overrides,
  };
}

export const REGISTRY = [
  // =====================================================================
  // The learner surfaces under /learn
  // =====================================================================
  {
    id: "progress-body-run-weeks",
    file: "src/app/(app)/learn/[runId]/progress/ProgressBody.tsx",
    path: "courseRuns/{runId}/weeks",
    clauses: [],
    reason:
      "The progress page lists the run's canonical curriculum. It sits under /learn, which any approved member reaches, and the weeks subcollection was deliberately left at `allow read: if isSignedIn()` in V3 W3 PR20 precisely so this unfiltered list keeps working. If that rule is ever narrowed on status, this list is the first thing that breaks.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`courseRuns/${RUN_ID}/weeks/${WEEK_ID}`).set({ weekNumber: 1, title: "Week 1" });
    },
    run: (db) => db.collection("courseRuns").doc(RUN_ID).collection("weeks").get(),
  },
  {
    id: "progress-body-group-weeks",
    file: "src/app/(app)/learn/[runId]/progress/ProgressBody.tsx",
    path: "courseGroups/{groupId}/weeks",
    clauses: [],
    reason:
      "The group's forked curriculum, read on the same member-facing progress page and fired only when the member is in a group. `courseGroups/{groupId}/weeks` is `allow read: if isSignedIn()` while the group document itself is staff-only, which is the asymmetry worth pinning: the fork list must stay readable by the learner it belongs to.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`courseGroups/${GROUP_ID}/weeks/${WEEK_ID}`).set({ weekNumber: 1, forked: true });
    },
    run: (db) => db.collection("courseGroups").doc(GROUP_ID).collection("weeks").get(),
  },
  {
    id: "group-weeks-run-weeks",
    file: "src/features/courses/useGroupWeeks.ts",
    path: "courseRuns/{runId}/weeks",
    clauses: [],
    reason:
      "The facilitator's week index reads the run's canonical weeks alongside the group's forks. Mounted by GroupWeekEditor under /learn/[runId]/group/[groupId]/edit, whose audience is the group's facilitator, a plain member with no permission map at all. Signed-in is the whole gate the rule applies, and that is what makes the surface work.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`courseRuns/${RUN_ID}/weeks/${WEEK_ID}`).set({ weekNumber: 1, title: "Week 1" });
    },
    run: (db) => db.collection("courseRuns").doc(RUN_ID).collection("weeks").get(),
  },
  {
    id: "group-weeks-group-weeks",
    file: "src/features/courses/useGroupWeeks.ts",
    path: "courseGroups/{groupId}/weeks",
    clauses: [],
    reason:
      "The other half of the same fetch: every fork this group holds. Same facilitator surface, same signed-in rule.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`courseGroups/${GROUP_ID}/weeks/${WEEK_ID}`).set({ weekNumber: 1, forked: true });
    },
    run: (db) => db.collection("courseGroups").doc(GROUP_ID).collection("weeks").get(),
  },
  {
    id: "group-week-run-doc",
    file: "src/features/courses/useGroupWeeks.ts",
    path: "courseRuns/{runId}/weeks/{weekId}",
    clauses: [],
    docShape:
      "One canonical week of the run, addressed by the zero-padded week id ('w01'). The fixture is a plain week document, because the rule tests nothing about its contents.",
    reason:
      "GroupWeekEditor opens a single week to fork it. The facilitator running this holds no permission key, so the signed-in rule on the weeks subcollection is what carries the surface.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`courseRuns/${RUN_ID}/weeks/${WEEK_ID}`).set({ weekNumber: 1, title: "Week 1" });
    },
    run: (db) => db.doc(`courseRuns/${RUN_ID}/weeks/${WEEK_ID}`).get(),
  },
  {
    id: "group-week-fork-doc",
    file: "src/features/courses/useGroupWeeks.ts",
    path: "courseGroups/{groupId}/weeks/{weekId}",
    clauses: [],
    docShape:
      "The group's fork of that same week, at the same week id: ids are preserved across a fork so progress references survive it.",
    reason:
      "Read beside the canonical week so the editor can show what this group changed. Same facilitator surface and the same signed-in rule.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`courseGroups/${GROUP_ID}/weeks/${WEEK_ID}`).set({ weekNumber: 1, forked: true });
    },
    run: (db) => db.doc(`courseGroups/${GROUP_ID}/weeks/${WEEK_ID}`).get(),
  },
  {
    id: "week-view-canonical-week-doc",
    pins: [
      {
        file: "src/features/courses/useWeek.ts",
        text: 'doc(getClientDb(), "courseRuns", runId, "weeks", weekId)',
      },
    ],
    file: "src/features/courses/useWeek.ts",
    path: "courseRuns/{runId}/weeks/{weekId}",
    clauses: [],
    unresolved:
      "The reference is built by a ternary (`forked ? doc(..., 'courseGroups', ...) : doc(..., 'courseRuns', ...)`), so the scanner cannot say which of the two paths a given call takes. Both are declared, this entry and `week-view-forked-week-doc`, and both land on a `weeks` subcollection whose rule is the same.",
    docShape:
      "The run's own week, the branch taken when the member's group has not forked it.",
    reason:
      "WeekView is the member's week page under /learn, so a plain member issues this. The weeks subcollection stayed signed-in-readable for exactly this reason.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`courseRuns/${RUN_ID}/weeks/${WEEK_ID}`).set({ weekNumber: 1, title: "Week 1" });
    },
    run: (db) => db.doc(`courseRuns/${RUN_ID}/weeks/${WEEK_ID}`).get(),
  },
  {
    id: "week-view-forked-week-doc",
    pins: [
      {
        file: "src/features/courses/useWeek.ts",
        text: 'doc(getClientDb(), "courseGroups", groupId, "weeks", weekId)',
      },
    ],
    file: "src/features/courses/useWeek.ts",
    path: "courseGroups/{groupId}/weeks/{weekId}",
    clauses: [],
    unresolved:
      "The other branch of the same ternary. Declared separately so a future edit that drops one branch shows up as a stale entry rather than as silence.",
    docShape: "The group's fork of the week, taken when the member's group has one.",
    reason:
      "Same member-facing week page under /learn, one collection over, and the same `allow read: if isSignedIn()`. A group fork is what a facilitator edits and what that group's members are then shown, so the two branches have to stay equally readable or a forked group loses its week page.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`courseGroups/${GROUP_ID}/weeks/${WEEK_ID}`).set({ weekNumber: 1, forked: true });
    },
    run: (db) => db.doc(`courseGroups/${GROUP_ID}/weeks/${WEEK_ID}`).get(),
  },
  {
    id: "run-progress-own-rows",
    file: "src/features/courses/useRunProgress.ts",
    path: "courseProgress",
    clauses: ["where(runId,==)", "where(uid,==)"],
    reason:
      "The member's own check-offs for one run, live. `courseProgress` is own-row-only with no admin branch at all, and the rule is deliberately get()-free so a long list stays cheap. The `uid` clause is load-bearing in the same way ProfileForm's `audience` clause is: without it the shape could match another member's row and the whole listen is refused.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`courseProgress/${RUN_ID}__${p.uid}__item1`).set({
        runId: RUN_ID,
        uid: p.uid,
        itemId: "item1",
        weekNumber: 1,
        done: true,
      });
    },
    run: (db, p) =>
      db
        .collection("courseProgress")
        .where("runId", "==", RUN_ID)
        .where("uid", "==", p.uid)
        .get(),
  },
  {
    id: "progress-moderation-carry",
    file: "src/features/courses/progressMutations.ts",
    path: "courseProgress/{progressId}",
    clauses: [],
    docShape:
      "The member's own progress row at the deterministic id runId__uid__itemId, re-read before a write so a moderation stamp is carried through at full timestamp precision.",
    reason:
      "A read that precedes the one client-direct member write in the courses feature, issued from the member's own week page. Own-row only, which the deterministic id makes structural.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`courseProgress/${RUN_ID}__${p.uid}__item1`).set({
        runId: RUN_ID,
        uid: p.uid,
        itemId: "item1",
        weekNumber: 1,
        done: true,
      });
    },
    run: (db, p) => db.doc(`courseProgress/${RUN_ID}__${p.uid}__item1`).get(),
  },
  {
    id: "my-application-own-row",
    file: "src/features/courses/useMyApplication.ts",
    path: "courseApplications/{applicationId}",
    clauses: [],
    docShape:
      "The applicant's own row at the deterministic id runId__uid. Seeded per persona, because the rule reads `resource.data.uid` and a missing document is refused rather than reported absent.",
    reason:
      "ApplyForm on the public course page asks whether this member has already applied. Own row plus admin is the whole rule, and the hook swallows the rejection so a member with no application still sees the form.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`courseApplications/${RUN_ID}__${p.uid}`).set({
        runId: RUN_ID,
        uid: p.uid,
        status: "submitted",
        email: `${p.uid}@example.com`,
      });
    },
    run: (db, p) => db.doc(`courseApplications/${RUN_ID}__${p.uid}`).get(),
  },

  // =====================================================================
  // Registration, which runs before a users document exists
  // =====================================================================
  {
    id: "collaborator-apply-own-row",
    file: "src/app/(auth)/register/CollaboratorApply.tsx",
    path: "collaborators",
    clauses: ["where(uid,==)"],
    reason:
      "The collaborator application form watches for its own row. Nobody here has a `users` document yet, so the `isAdmin()` branch of the rule cannot even resolve one: the read survives on the own-uid clause alone, which is why that clause has to be on the QUERY and not merely true of the rows.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`collaborators/collab__${p.uid}`).set({
        uid: p.uid,
        status: "pending",
        name: "Guard applicant",
      });
    },
    run: (db, p) => db.collection("collaborators").where("uid", "==", p.uid).get(),
  },
  {
    id: "register-collaborator-probe",
    file: "src/app/(auth)/register/page.tsx",
    path: "collaborators",
    clauses: ["where(uid,==)"],
    reason:
      "The reverse guard on /register: a signed-in collaborator has a collaborators row and no users document, so the role bounce never fires and this probe is what keeps them off the member form. Same own-uid clause, same reason it must be on the query.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`collaborators/collab__${p.uid}`).set({
        uid: p.uid,
        status: "pending",
        name: "Guard applicant",
      });
    },
    run: (db, p) => db.collection("collaborators").where("uid", "==", p.uid).get(),
  },
  {
    id: "collaborator-page-own-row",
    file: "src/app/collaborator/page.tsx",
    path: "collaborators",
    clauses: ["where(uid,==)"],
    reason:
      "The collaborator's own landing page outside the (app) tree, watching the same row for a decision. Third copy of the shape, kept as its own entry so deleting one surface cannot quietly take the guard off the other two.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`collaborators/collab__${p.uid}`).set({
        uid: p.uid,
        status: "pending",
        name: "Guard applicant",
      });
    },
    run: (db, p) => db.collection("collaborators").where("uid", "==", p.uid).get(),
  },
  {
    id: "register-email-verification",
    file: "src/app/(auth)/register/page.tsx",
    path: "emailVerifications/{tokenId}",
    clauses: [],
    docShape:
      "The outstanding magic-link document the registrant's own tab created, seeded with `authUid` set to the persona so the rule has something to match.",
    reason:
      "The register tab listens for `verifiedAt` on the token it just requested. The rule pins `resource.data.authUid == request.auth.uid`, so only the initiating tab sees it, and again the reader typically has no users document yet.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`emailVerifications/token__${p.uid}`).set({
        authUid: p.uid,
        email: `${p.uid}@nottingham.ac.uk`,
        verifiedAt: null,
      });
    },
    run: (db, p) => db.doc(`emailVerifications/token__${p.uid}`).get(),
  },

  // =====================================================================
  // A person's own user document, and their own preference rows
  // =====================================================================
  {
    id: "auth-provider-own-user",
    file: "src/auth/AuthProvider.tsx",
    path: "users/{uid}",
    clauses: [],
    docShape:
      "The signed-in person's own document. Every signed-in surface on the site depends on this one read landing.",
    reason:
      "AuthProvider streams the caller's own user document to resolve role, permissions and SU recognition. If this were ever refused the whole authed site would render as a permanently loading shell, so it is the single most load-bearing read in the codebase.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    run: (db, p) => db.doc(`users/${p.uid}`).get(),
  },
  {
    id: "profile-own-user",
    file: "src/features/profile/ProfileForm.tsx",
    path: "users/{uid}",
    clauses: [],
    docShape: "The member's own document, driving the identity half of /profile.",
    reason:
      "/profile is open to every approved member, and the users collection is otherwise SU-committee and admin only. The own-document branch of the rule is the entire reason this page works for a member.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    run: (db, p) => db.doc(`users/${p.uid}`).get(),
  },
  {
    id: "push-settings-own-user",
    file: "src/features/pwa/PushSettings.tsx",
    path: "users/{uid}",
    clauses: [],
    docShape: "The member's own document, for the push preference block.",
    reason:
      "The installable app's notification settings live on the member's own user document, read on /profile by the same member. Own-document branch again.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    run: (db, p) => db.doc(`users/${p.uid}`).get(),
  },
  {
    id: "profile-subscriptions-matrix",
    file: "src/features/profile/ProfileForm.tsx",
    path: "subscriptions",
    clauses: ["where(audience,==)", "where(audienceId,==)"],
    reason:
      "The Email preferences grid on /profile, open to every approved member. BOTH clauses are load-bearing: the rule grants a non-admin `audience == 'user' && audienceId == request.auth.uid`, and a query that pins only `audienceId` has a shape that could match a guest row, so Firestore refuses the whole listen. That is the bug commit 7e6c38c fixed, and the regression case at the foot of the test file keeps it fixed.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`subscriptions/sub__${p.uid}__newsletter`).set({
        email: `${p.uid}@example.com`,
        channel: "newsletter",
        audience: "user",
        audienceId: p.uid,
        confirmed: true,
        subscribed: true,
        source: "guard",
      });
    },
    run: (db, p) =>
      db
        .collection("subscriptions")
        .where("audience", "==", "user")
        .where("audienceId", "==", p.uid)
        .get(),
  },

  // =====================================================================
  // The admin console
  // =====================================================================
  {
    id: "approvals-pending-users",
    file: "src/features/admin/useApprovals.ts",
    path: "users",
    clauses: ["where(role,==)"],
    reason:
      "The Approvals tab lists `role == 'pending'` accounts. /admin/(admin-only) is full admins only, and the users rule gives admins and SU committee a resource-independent branch, so the list passes for both. Nobody else can reach the page.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "allowed",
      admin: "allowed",
    },
    run: (db) => db.collection("users").where("role", "==", "pending").get(),
  },
  {
    id: "pending-count-users",
    file: "src/features/admin/usePendingCount.ts",
    path: "users",
    clauses: ["where(role,==)"],
    reason:
      "The pending badge on the admin tab strip and the sidebar. This is a `getCountFromServer` aggregation, which Firestore judges on the same shape as the equivalent list, so it is proven here with a `get()` of the identical query. The hook refuses to issue it unless the caller's role is admin, which is what keeps a course drafter passing through the shell from firing a denied count.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "allowed",
      admin: "allowed",
    },
    run: (db) => db.collection("users").where("role", "==", "pending").get(),
  },
  {
    id: "members-roster",
    file: "src/features/admin/useMembers.ts",
    path: "users",
    clauses: ["where(role,in)"],
    reason:
      "The member roster, on `role in ['member','committee','admin']` (plus 'rejected' when the caller ticks it). Two shapes for one clause; both are lists over `users`, which is admin and SU-committee only, so the outcome is the same either way. Every caller that issues it is a caller the rule admits. The two pages whose gate is wider than the rule both mount the hook inside a child that only a caller the rule admits renders: RunEditor under /admin/courses (gate: admin, draftCourse or approveCourse) mounts it in GroupsAndRolesWithRoster, for an admin or an SU-recognised committee member, and RoundEditor under /admin/admissions (gate: admin, approveCourse, or an appointed admissions reviewer, who may hold no key at all) mounts it in RolesEditor, for an admin. A plain member on either page therefore never fires this list. What they see instead: RunEditor replaces the Roles pickers with a note naming who can appoint, and RoundEditor replaces its Reviewers section with a read-only summary. One picker stays drawn from an empty roster, the per-group facilitator picker inside GroupEditor, which is out of the split's reach because closing it out would take the rest of the group card with it; it still counts a group's facilitators but cannot name them, a second note on that card says so, and saving cannot silently drop them because GroupEditor writes the facilitator list only when it changed. Neither split is left to a reviewer's memory: `tests/roster-read-gates.test.mjs` walks every call site of every hook that lists `users` and fails if one drifts back into the page component, or if a new caller appears with no gate written down. The permission personas below therefore keep the outcome the RULE gives them, refused, which is what would happen if the hook were ever mounted from a surface they can reach again; it is not what any of them sees today.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "allowed",
      admin: "allowed",
      ...COURSE_STAFF_REFUSED,
    },
    run: (db) =>
      db.collection("users").where("role", "in", ["member", "committee", "admin"]).get(),
  },
  {
    id: "newsletter-subscribers-users",
    file: "src/features/admin/useNewsletterSubscribers.ts",
    path: "users",
    clauses: [],
    reason:
      "An unfiltered `users` list, filtered in memory because a `where()` on either the legacy or the current notification shape would miss users on the other. Admin-only page, and admins plus SU committee are the only callers the rule admits at all.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "allowed",
      admin: "allowed",
    },
    run: (db) => db.collection("users").get(),
  },
  {
    id: "verified-emails-users",
    file: "src/features/admin/useVerifiedEmails.ts",
    path: "users",
    clauses: [],
    reason:
      "A live unfiltered `users` listen powering stale-row detection on the admin Subscriptions tab. Same admin-only page, same rule branch.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "allowed",
      admin: "allowed",
    },
    run: (db) => db.collection("users").get(),
  },
  {
    id: "uni-email-index-users",
    file: "src/features/admin/useUniEmailIndex.ts",
    path: "users",
    clauses: ["where(profile.universityEmail,in)"],
    reason:
      "Duplicate-address detection on the Approvals tab, batched in groups of 30 because that is the `in` limit. The batching changes the VALUE per request, never the shape, so one entry covers every batch. Admin-only page.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "allowed",
      admin: "allowed",
    },
    run: (db) =>
      db
        .collection("users")
        .where("profile.universityEmail", "in", ["a@nottingham.ac.uk", "b@nottingham.ac.uk"])
        .get(),
  },
  {
    id: "collaborator-count",
    file: "src/features/admin/useCollaboratorCount.ts",
    path: "collaborators",
    clauses: ["where(status,==)"],
    reason:
      "The pending-collaborator badge, a `getCountFromServer` proven here with a `get()` of the same shape. The rule is admin, or own row by uid: a count filtered on status pins no uid, so only the admin branch can carry it, and the hook issues it only for an admin.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
    },
    run: (db) => db.collection("collaborators").where("status", "==", "pending").get(),
  },
  {
    id: "collaborators-list",
    file: "src/features/admin/useCollaborators.ts",
    path: "collaborators",
    clauses: [],
    reason:
      "Every collaborator application, on the admin-only Collaborators page. Unfiltered, so only the admin branch of the rule can carry it.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
    },
    run: (db) => db.collection("collaborators").get(),
  },
  {
    id: "projects-list",
    file: "src/features/admin/useProjects.ts",
    path: "projects",
    clauses: ["orderBy(createdAt,desc)"],
    reason:
      "The project list, mounted on the admin Projects page AND on /tasks and the dashboard's My Work summary, so a plain member issues it. `projects` is readable by member, committee and admin, which is exactly what those two member surfaces need; a pending account is refused and cannot reach either page.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc("projects/guard-project").set({
        name: "Guard project",
        leadUid: OTHER,
        memberUids: [],
        archived: false,
        createdAt: new Date(),
      });
    },
    run: (db) => db.collection("projects").orderBy("createdAt", "desc").get(),
  },
  {
    id: "project-doc-preflight",
    file: "src/features/admin/adminMutations.ts",
    path: "projects/{projectId}",
    clauses: [],
    docShape:
      "One project document, re-read before an update so the roster-shrink cascade can diff the stored member list.",
    reason:
      "A read that precedes a write, issued only from the admin Projects page. The read rule is the member/committee/admin one, so it is wider than the surface: the write rule underneath it is admin-only, which is where the boundary actually sits.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc("projects/guard-project").set({
        name: "Guard project",
        leadUid: OTHER,
        memberUids: [],
        archived: false,
        createdAt: new Date(),
      });
    },
    run: (db) => db.doc("projects/guard-project").get(),
  },
  {
    id: "project-tasks-cascade",
    file: "src/features/admin/adminMutations.ts",
    path: "tasks",
    clauses: ["where(projectId,==)"],
    reason:
      "Every task on a project, read so removing someone from the project can strip them from those tasks. The tasks rule gives only an admin a resource-independent branch, so this list works for an admin and nobody else, which matches the admin-only page it runs on.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc("tasks/guard-project-task").set(taskDoc({ projectId: "guard-project" }));
    },
    run: (db) => db.collection("tasks").where("projectId", "==", "guard-project").get(),
  },
  {
    id: "subscriptions-list",
    file: "src/features/admin/useSubscriptions.ts",
    path: "subscriptions",
    clauses: [],
    reason:
      "The whole junction collection for the admin Subscriptions table. Unfiltered, so the own-row branch cannot carry it and only an admin may run it. The contrast with `profile-subscriptions-matrix` is the point: same collection, two shapes, two audiences.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
    },
    run: (db) => db.collection("subscriptions").get(),
  },
  {
    id: "subscription-events-list",
    file: "src/features/admin/useSubscriptionEvents.ts",
    path: "subscriptionEvents",
    clauses: [],
    reason:
      "The append-only subscription audit log, streamed whole and grouped client-side on the admin Subscriptions tab. Admin-only in the rules, admin-only page.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
    },
    run: (db) => db.collection("subscriptionEvents").get(),
  },
  {
    id: "application-email-template",
    file: "src/features/admin/emailDesigns/EmailDesignEditor.tsx",
    path: "applicationEmailTemplates/{templateId}",
    clauses: [],
    docShape: "One lifecycle-email template document, live while the admin edits it.",
    reason:
      "The Email designs tab under /admin/(admin-only). Admin-only in the rules and on the page.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc("applicationEmailTemplates/submitted").set({
        recipients: "both",
        subject: "Your application",
      });
    },
    run: (db) => db.doc("applicationEmailTemplates/submitted").get(),
  },
  {
    id: "course-email-template",
    file: "src/features/admin/emailDesigns/CourseEmailDesignEditor.tsx",
    path: "courseEmailTemplates/{templateId}",
    clauses: [],
    docShape: "One course lifecycle-email template, live while the admin edits it.",
    reason:
      "The course half of the same Email designs tab. `courseEmailTemplates` is admin-only in the rules, and a course drafter never reaches this page: it sits in the (admin-only) group, not under /admin/courses.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
      ...COURSE_STAFF_REFUSED,
    },
    seed: async (db) => {
      await db.doc("courseEmailTemplates/application-accepted").set({
        subject: "You are in",
        blocks: [],
      });
    },
    run: (db) => db.doc("courseEmailTemplates/application-accepted").get(),
  },

  // =====================================================================
  // The admin coordination locks
  // =====================================================================
  {
    id: "page-lock-doc",
    sharesKeyWith: "user-edit-lock-doc",
    file: "src/features/admin/useAdminLock.ts",
    path: "adminLocks/{lockId}",
    clauses: [],
    docShape:
      "A page lease at the id shape `page__<pageKey>`, which the rule does NOT special-case: only the admin branch matches it.",
    reason:
      "The one-admin-at-a-time lease on an admin page, acquired in a transaction and then watched. Since /admin/courses opened to course permission holders the hook enables itself for them too, and for those callers every acquire and every snapshot is denied. That is a KNOWN limit rather than a surprise: the lease fails open by design, and the code comment on useAdminPageLock says the rules half is still owed. Recorded here so it stops being folklore.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
      ...COURSE_STAFF_REFUSED,
    },
    seed: async (db) => {
      await db.doc("adminLocks/page__courses-run-guard").set({
        scope: "page",
        pageKey: "courses-run-guard",
        holderUid: "admin1",
        holderName: "An admin",
        heartbeatAt: new Date(),
      });
    },
    run: (db) => db.doc("adminLocks/page__courses-run-guard").get(),
  },
  {
    id: "user-edit-lock-doc",
    sharesKeyWith: "page-lock-doc",
    file: "src/features/admin/useAdminLock.ts",
    path: "adminLocks/{lockId}",
    clauses: [],
    docShape:
      "The maintenance lease at `useredit__<uid>`, read by the member it targets. The id pattern is the rule: `lockId == 'useredit__' + request.auth.uid`, tested against the id rather than the document so a member can read their own lock before it exists.",
    reason:
      "Two callers, one shape. An admin holds this lock while editing a member (useUserEditLock), and the member watches their own copy of it on /profile (useMaintenanceWatch) to show the maintenance notice. The member branch is why this entry exists separately from the page lock: same file, same path, opposite audience.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`adminLocks/useredit__${p.uid}`).set({
        scope: "user-edit",
        targetUid: p.uid,
        holderUid: "admin1",
        heartbeatAt: new Date(),
      });
    },
    run: (db, p) => db.doc(`adminLocks/useredit__${p.uid}`).get(),
  },
  {
    id: "page-lock-messages",
    sharesKeyWith: "user-edit-lock-messages",
    file: "src/features/admin/useAdminLock.ts",
    path: "adminLocks/{lockId}/messages",
    clauses: ["orderBy(createdAt,desc)", "limit()"],
    reason:
      "The last ten messages on a page lease, read by the holder and by whoever is waiting. The subcollection rule repeats the parent's admit list off the lock id, so a `page__` lock is admin-only here too, with the same fail-open consequence for a course drafter.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
      ...COURSE_STAFF_REFUSED,
    },
    seed: async (db) => {
      await db.doc("adminLocks/page__courses-run-guard/messages/m1").set({
        fromUid: "admin1",
        fromName: "An admin",
        text: "Are you nearly done?",
        createdAt: new Date(),
      });
    },
    run: (db) =>
      db
        .collection("adminLocks")
        .doc("page__courses-run-guard")
        .collection("messages")
        .orderBy("createdAt", "desc")
        .limit(10)
        .get(),
  },
  {
    id: "user-edit-lock-messages",
    sharesKeyWith: "page-lock-messages",
    file: "src/features/admin/useAdminLock.ts",
    path: "adminLocks/{lockId}/messages",
    clauses: ["orderBy(createdAt,desc)", "limit()"],
    reason:
      "The same ten-message list on the member's own `useredit__` lock, which is how a member answers the admin editing their details. Its own entry because the audience is every signed-in member, not an admin.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`adminLocks/useredit__${p.uid}/messages/m1`).set({
        fromUid: p.uid,
        fromName: "The member",
        text: "Please leave my name alone",
        createdAt: new Date(),
      });
    },
    run: (db, p) =>
      db
        .collection("adminLocks")
        .doc(`useredit__${p.uid}`)
        .collection("messages")
        .orderBy("createdAt", "desc")
        .limit(10)
        .get(),
  },

  // =====================================================================
  // Course authoring, under /admin/courses and /admin/admissions
  // =====================================================================
  {
    id: "round-editor-run-picker",
    file: "src/features/admissions/RoundEditor.tsx",
    path: "courseRuns",
    clauses: [],
    reason:
      "An unfiltered `courseRuns` list feeding the outcome-run and evidence-run pickers on /admin/admissions. That gate admits an appointed admissions reviewer who holds neither course key, and since V3 W3 PR20 the read is refused for them EVEN WITH AN EMPTY COLLECTION, because the shape could match a draft. The caller catches its own rejection and the pickers render only inside the canAuthor branch, so nothing a reviewer was shown disappears. Named regression case (b) in the test file.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
      ...COURSE_STAFF,
    },
    run: (db) => db.collection("courseRuns").get(),
  },
  {
    id: "admin-course-list-runs",
    file: "src/features/courses/AdminCourseList.tsx",
    path: "courseRuns",
    clauses: [],
    reason:
      "One unfiltered run list for the whole course index page, used to label each course row. /admin/courses is admin, draftCourse or approveCourse, which is exactly the set the narrowed rule admits without a status clause.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
      ...COURSE_STAFF,
    },
    run: (db) => db.collection("courseRuns").get(),
  },
  {
    id: "admin-courses-list",
    file: "src/features/courses/useAdminCourses.ts",
    path: "courses",
    clauses: [],
    reason:
      "Every course, unfiltered, for the admin course index and the two editors. A member-facing copy of this list would have to carry `where('status','==','published')`, and the constraint DIFFERS from the run one, which has no published status to ask for.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
      ...COURSE_STAFF,
    },
    run: (db) => db.collection("courses").get(),
  },
  {
    id: "admin-course-runs-by-course",
    file: "src/features/courses/useAdminCourses.ts",
    path: "courseRuns",
    clauses: ["where(courseId,==)"],
    reason:
      "The runs of one course, for the course editor and the copy-forward picker. Filtering on `courseId` narrows nothing the RULE cares about, so this is refused for a caller with no course key exactly as the unfiltered list is: the only clause that would help is `status != 'draft'`.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
      ...COURSE_STAFF,
    },
    run: (db) => db.collection("courseRuns").where("courseId", "==", COURSE_ID).get(),
  },
  {
    id: "admin-course-groups-by-run",
    file: "src/features/courses/useAdminCourses.ts",
    path: "courseGroups",
    clauses: ["where(runId,==)"],
    reason:
      "The groups of one run, in RunEditor. `courseGroups` is a flat staff predicate (admin, draftCourse, approveCourse) with no member branch at all, so the same three callers pass and everyone else is refused regardless of the query.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
      ...COURSE_STAFF,
    },
    seed: async (db) => {
      await db.doc(`courseGroups/${GROUP_ID}`).set({
        runId: RUN_ID,
        name: "Guard group",
        facilitatorUids: [],
        memberCount: 0,
      });
    },
    run: (db) => db.collection("courseGroups").where("runId", "==", RUN_ID).get(),
  },
  {
    id: "admin-course-weeks",
    file: "src/features/courses/useAdminCourses.ts",
    path: "courseRuns/{runId}/weeks",
    clauses: [],
    reason:
      "The run's weeks in RunEditor. The subcollection is signed-in-readable, so this is the one course-authoring read that is wider than its page: staff run it, but the rule would let any member run it, which is the deliberate non-narrowing recorded in docs/courses-ops.md.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`courseRuns/${RUN_ID}/weeks/${WEEK_ID}`).set({ weekNumber: 1, title: "Week 1" });
    },
    run: (db) => db.collection("courseRuns").doc(RUN_ID).collection("weeks").get(),
  },
  {
    id: "run-editor-run-doc",
    file: "src/features/courses/RunEditor.tsx",
    path: "courseRuns/{runId}",
    clauses: [],
    docShape:
      "A DRAFT run authored by somebody else, which is the closed case: a run at any other status is readable by any signed-in account. Seeding the draft is what makes the staff-only outcome mean something.",
    reason:
      "The run document the editor edits, under /admin/courses. A course collaborator without a course key cannot read a draft run, because `collaboratorUids` lives on the course and a run carries only `authorUid`, and that is fine only because every client-side reader of a run sits behind this gate.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
      ...COURSE_STAFF,
    },
    seed: async (db) => {
      await db.doc(`courseRuns/${RUN_ID}`).set(draftRun());
    },
    run: (db) => db.doc(`courseRuns/${RUN_ID}`).get(),
  },
  {
    id: "week-editor-run-doc",
    file: "src/features/courses/WeekEditor.tsx",
    path: "courseRuns/{runId}",
    clauses: [],
    docShape: "The same draft run, read for the week's context.",
    reason:
      "WeekEditor needs the parent run to render week context. Same /admin/courses gate, same narrowed rule.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
      ...COURSE_STAFF,
    },
    seed: async (db) => {
      await db.doc(`courseRuns/${RUN_ID}`).set(draftRun());
    },
    run: (db) => db.doc(`courseRuns/${RUN_ID}`).get(),
  },
  {
    id: "week-plan-builder-run-doc",
    file: "src/features/courses/WeekPlanBuilder.tsx",
    path: "courseRuns/{runId}",
    clauses: [],
    docShape: "The same draft run, re-read to refresh the plan after a normalise.",
    reason:
      "Rendered inside RunEditor, so it inherits the /admin/courses gate. Listed separately because a component can be re-mounted somewhere else without anybody re-checking the gate.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
      ...COURSE_STAFF,
    },
    seed: async (db) => {
      await db.doc(`courseRuns/${RUN_ID}`).set(draftRun());
    },
    run: (db) => db.doc(`courseRuns/${RUN_ID}`).get(),
  },
  {
    id: "week-editor-week-doc",
    file: "src/features/courses/WeekEditor.tsx",
    path: "courseRuns/{runId}/weeks/{weekId}",
    clauses: [],
    docShape: "The week being edited, at its zero-padded id.",
    reason:
      "The week document itself, under /admin/courses. Signed-in-readable, so it is wider than the page: the write rule one line down is what actually scopes authoring to the run's owner, its approvers and its track leads.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`courseRuns/${RUN_ID}/weeks/${WEEK_ID}`).set({ weekNumber: 1, title: "Week 1" });
    },
    run: (db) => db.doc(`courseRuns/${RUN_ID}/weeks/${WEEK_ID}`).get(),
  },
  {
    id: "course-mutations-week-doc",
    file: "src/features/courses/courseMutations.ts",
    path: "courseRuns/{runId}/weeks/{weekId}",
    clauses: [],
    docShape:
      "The week a create is about to address, read first so an existing week is never overwritten.",
    reason:
      "A read that precedes a write, from the admin week editors. Same signed-in read rule; the create rule underneath enforces the week id shape and the authoring roles.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`courseRuns/${RUN_ID}/weeks/${WEEK_ID}`).set({ weekNumber: 1, title: "Week 1" });
    },
    run: (db) => db.doc(`courseRuns/${RUN_ID}/weeks/${WEEK_ID}`).get(),
  },
  {
    id: "course-page-doc",
    file: "src/features/courses/useCoursePage.ts",
    path: "coursePages/{courseId}",
    clauses: [],
    docShape:
      "The authored marketing page for one course. The document carries no status of its own, which is why the rule is a flat staff predicate rather than a status test.",
    reason:
      "CoursePageEditor at /admin/courses/[courseId]/page, whose gate is requireCourseAuthorPage() and whose rule is the identical predicate. The logged-out marketing page is served by fetchCoursePage.ts on the Admin SDK, which bypasses rules entirely.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
      ...COURSE_STAFF,
    },
    seed: async (db) => {
      await db.doc(`coursePages/${COURSE_ID}`).set({ blocks: [], updatedAt: new Date() });
    },
    run: (db) => db.doc(`coursePages/${COURSE_ID}`).get(),
  },
  {
    id: "course-application-count",
    file: "src/features/courses/useCourseApplicationCount.ts",
    path: "courseApplications",
    clauses: ["where(status,==)"],
    reason:
      "The Courses badge on the admin tab strip: a `getCountFromServer`, proven here with a `get()` of the same shape. `courseApplications` is admin plus own row, and a count filtered on status pins no uid, so only an admin can run it. The hook checks the caller's role before issuing it, which matters because the tab strip renders for course drafters too.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
      ...COURSE_STAFF_REFUSED,
    },
    run: (db) => db.collection("courseApplications").where("status", "==", "pending").get(),
  },

  // =====================================================================
  // Events
  // =====================================================================
  {
    id: "events-list",
    file: "src/features/events/useEvents.ts",
    path: "events",
    clauses: [],
    reason:
      "Every event, for the drafts and publishing index at /events/manage. The rule's first three branches (draftEvent, approveEvent, committee or admin) are resource-independent, so the unfiltered list passes for exactly the set the page's layout admits. A plain member is refused, and cannot reach the page.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
      ...EVENT_STAFF,
    },
    seed: async (db) => {
      await db.doc(`events/${EVENT_ID}`).set({
        title: "Guard event",
        status: "draft",
        authorUid: OTHER,
        collaboratorUids: [],
        visibility: "members",
      });
    },
    run: (db) => db.collection("events").get(),
  },
  {
    id: "event-editor-doc",
    file: "src/features/events/EventEditor.tsx",
    path: "events/{eventId}",
    clauses: [],
    docShape:
      "A DRAFT event by another author, which is the closed case: a published event is readable by any signed-in account, so seeding a draft is what makes the outcome informative.",
    reason:
      "The event the editor is editing, live. Same /events/manage gate: the whole committee plus the two event permission holders.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
      ...EVENT_STAFF,
    },
    seed: async (db) => {
      await db.doc(`events/${EVENT_ID}`).set({
        title: "Guard event",
        status: "draft",
        authorUid: OTHER,
        collaboratorUids: [],
        visibility: "members",
      });
    },
    run: (db) => db.doc(`events/${EVENT_ID}`).get(),
  },
  {
    id: "event-rsvps-by-event",
    file: "src/features/events/useEventRsvps.ts",
    path: "eventRsvps",
    clauses: ["where(eventId,==)"],
    reason:
      "The attendee list for one event, issued twice in this file with the identical shape: once as a live listener and once as a server-forced refetch after a decision, which is why they share one entry. Attendee PII is SU-recognised committee and admins only, and the attendees page repeats that check server-side before it renders, so a non-SU committee member is redirected rather than shown an empty table.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "allowed",
      admin: "allowed",
      ...{ "member+draftEvent": "refused", "member+approveEvent": "refused" },
    },
    seed: async (db) => {
      await db.doc("eventRsvps/guard-rsvp").set({
        eventId: EVENT_ID,
        name: "Guard attendee",
        email: "attendee@example.com",
        status: "confirmed",
      });
    },
    run: (db) => db.collection("eventRsvps").where("eventId", "==", EVENT_ID).get(),
  },

  // =====================================================================
  // Newsletter
  // =====================================================================
  {
    id: "drafts-list",
    file: "src/features/newsletter/useDrafts.ts",
    path: "newsletterDrafts",
    clauses: [],
    reason:
      "Every draft, for /newsletter. Both branches of the rule are resource-independent permission checks, so the unfiltered list passes for precisely the set the layout admits: admins and the two newsletter permission holders. Committee membership grants nothing here, which is the difference from events.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
      ...NEWSLETTER_STAFF,
    },
    seed: async (db) => {
      await db.doc(`newsletterDrafts/${DRAFT_ID}`).set({
        subject: "Guard draft",
        status: "draft",
        authorUid: OTHER,
        blocks: [],
      });
    },
    run: (db) => db.collection("newsletterDrafts").get(),
  },
  {
    id: "draft-editor-doc",
    file: "src/features/newsletter/DraftEditor.tsx",
    path: "newsletterDrafts/{draftId}",
    clauses: [],
    docShape: "One draft by another author, live while it is edited.",
    reason:
      "The draft the editor is editing. Same permission-only gate as the index; the per-document scoping added in the update rule is what stops a drafter rewriting somebody else's approved draft, and it does not touch reads.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
      ...NEWSLETTER_STAFF,
    },
    seed: async (db) => {
      await db.doc(`newsletterDrafts/${DRAFT_ID}`).set({
        subject: "Guard draft",
        status: "draft",
        authorUid: OTHER,
        blocks: [],
      });
    },
    run: (db) => db.doc(`newsletterDrafts/${DRAFT_ID}`).get(),
  },

  // =====================================================================
  // The two world-readable surfaces
  // =====================================================================
  {
    id: "status-page-log",
    file: "src/features/maintenance/StatusPage.tsx",
    path: "maintenanceLog",
    clauses: ["orderBy(startedAt,desc)", "limit()"],
    reason:
      "The public history behind /status. World-readable AND enumerable on purpose, so the signed-out outcome here is `allowed` and any change to it is a decision about publishing, not about permissions. Nothing sensitive may ever be written to this collection.",
    outcomes: {
      "signed-out": "allowed",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc("maintenanceLog/entry1").set({
        startedAt: new Date(),
        level: "info",
        message: "Guard entry",
      });
    },
    run: (db) =>
      db.collection("maintenanceLog").orderBy("startedAt", "desc").limit(20).get(),
  },
  {
    id: "site-notice-doc",
    file: "src/features/maintenance/useSiteNotice.ts",
    path: "publicConfig/siteNotice",
    clauses: [],
    docShape:
      "The single pinned document id. The rule matches that id and nothing else, so `list` cannot enumerate a future document dropped beside it.",
    reason:
      "The banner every visitor sees, read on the register page, the RSVP form, the apply form and the shell. Signed-out must be allowed or the notice would only reach people who are logged in, which is the opposite of what it is for.",
    outcomes: {
      "signed-out": "allowed",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc("publicConfig/siteNotice").set({ active: false, level: "info" });
    },
    run: (db) => db.doc("publicConfig/siteNotice").get(),
  },

  // =====================================================================
  // Tasks
  // =====================================================================
  {
    id: "task-templates-list",
    file: "src/features/tasks/hooks/useTaskTemplates.ts",
    path: "taskTemplates",
    clauses: ["orderBy(name,asc)"],
    reason:
      "Every task template, ordered by a field every template carries. The rule admits committee AND admin without the SU test, so a non-SU committee member may read templates even though the committee board itself is closed to them; the only surfaces that mount it are the board's TaskForm and the admin templates page, both narrower than the rule.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc("taskTemplates/guard-template").set({
        name: "Guard template",
        subtasks: [],
        createdByUid: OTHER,
      });
    },
    run: (db) => db.collection("taskTemplates").orderBy("name").get(),
  },
  {
    id: "task-doc-on-roster",
    sharesKeyWith: "task-doc-off-roster",
    file: "src/features/tasks/hooks/useTask.ts",
    path: "tasks/{taskId}",
    clauses: [],
    docShape:
      "A task the viewer is a COMPLETER on. This is the /tasks case: the modal only ever opens a task the viewer's own list handed it, so the fixture is a task with the persona on the roster.",
    reason:
      "The live task subscription behind the detail modal, opened from My Work as well as from the committee board. The completer branch is what makes the modal work for a plain member, and it is resource-dependent, which is exactly why a member's LIST has to carry the array-contains clause.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`tasks/${taskId(p)}`).set(taskDoc({ completerUids: [p.uid] }));
    },
    run: (db, p) => db.doc(`tasks/${taskId(p)}`).get(),
  },
  {
    id: "task-doc-off-roster",
    sharesKeyWith: "task-doc-on-roster",
    file: "src/features/tasks/hooks/useTask.ts",
    path: "tasks/{taskId}",
    clauses: [],
    docShape:
      "A committee-visibility task the viewer is NOT on, which is what a deep link to /committee/tasks?task=... hands the hook.",
    reason:
      "The same hook, the other fixture, and the pair is the point: a committee task with an empty roster is readable by SU committee and admins only. A non-SU committee member following a task link sees nothing, which is the documented visibility model rather than a bug.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc("tasks/guard-board-task").set(taskDoc());
    },
    run: (db) => db.doc("tasks/guard-board-task").get(),
  },
  {
    id: "comment-mutations-task-doc",
    file: "src/features/tasks/commentMutations.ts",
    path: "tasks/{taskId}",
    clauses: [],
    docShape:
      "A task the commenter is a completer on, read to expand an `@all` mention into the current roster.",
    reason:
      "A read that precedes a write, issued by whoever is commenting. Anyone who can comment can already read the parent (the comment create rule calls the same canAccessParent), so this cannot fail for a legitimate commenter.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`tasks/${taskId(p)}`).set(taskDoc({ completerUids: [p.uid] }));
    },
    run: (db, p) => db.doc(`tasks/${taskId(p)}`).get(),
  },
  {
    id: "task-mutations-task-doc",
    file: "src/features/tasks/taskMutations.ts",
    path: "tasks/{taskId}",
    clauses: [],
    docShape:
      "A task the editor is on, re-read before a roster shrink so the cascade can strip the removed uid from every subtask.",
    reason:
      "A read that precedes a write, from the task detail modal. Same completer branch as the modal's own subscription.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`tasks/${taskId(p)}`).set(taskDoc({ completerUids: [p.uid] }));
    },
    run: (db, p) => db.doc(`tasks/${taskId(p)}`).get(),
  },
  {
    id: "task-comments",
    file: "src/features/tasks/hooks/useCommentsAndActivity.ts",
    path: "tasks/{taskId}/comments",
    clauses: ["orderBy(createdAt,asc)"],
    reason:
      "The task thread. The subcollection rule resolves canAccessParent() with a get() on the parent task, so the PARENT must be seeded before this list can be judged at all: with no parent document the get() has nothing to read and the read is refused for everyone, admins included, which would look identical to a permissions problem.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`tasks/${taskId(p)}`).set(taskDoc({ completerUids: [p.uid] }));
      await db.doc(`tasks/${taskId(p)}/comments/c1`).set({
        authorUid: p.uid,
        bodyMarkdown: "Guard comment",
        subtaskId: null,
        createdAt: new Date(),
      });
    },
    run: (db, p) =>
      db
        .collection("tasks")
        .doc(taskId(p))
        .collection("comments")
        .orderBy("createdAt", "asc")
        .get(),
  },
  {
    id: "task-activity",
    file: "src/features/tasks/hooks/useCommentsAndActivity.ts",
    path: "tasks/{taskId}/activity",
    clauses: ["orderBy(createdAt,asc)"],
    reason:
      "The task's activity log, merged with the thread into one feed. Same parent-resolved gate, same need to seed the parent.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`tasks/${taskId(p)}`).set(taskDoc({ completerUids: [p.uid] }));
      await db.doc(`tasks/${taskId(p)}/activity/a1`).set({
        kind: "task_created",
        actorUid: p.uid,
        createdAt: new Date(),
      });
    },
    run: (db, p) =>
      db
        .collection("tasks")
        .doc(taskId(p))
        .collection("activity")
        .orderBy("createdAt", "asc")
        .get(),
  },
  {
    id: "subtask-activity",
    file: "src/features/tasks/hooks/useSubtaskActivity.ts",
    path: "tasks/{taskId}/activity",
    clauses: ["orderBy(createdAt,asc)"],
    reason:
      "The same activity stream, read again inside the subtask modal and filtered client-side because subtaskId lives on a nested payload object. Its own entry: the shape is identical, but a change to this file must not be waved through by the other hook's entry.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`tasks/${taskId(p)}`).set(taskDoc({ completerUids: [p.uid] }));
      await db.doc(`tasks/${taskId(p)}/activity/a1`).set({
        kind: "subtask_claimed",
        actorUid: p.uid,
        payload: { subtaskId: "s1" },
        createdAt: new Date(),
      });
    },
    run: (db, p) =>
      db
        .collection("tasks")
        .doc(taskId(p))
        .collection("activity")
        .orderBy("createdAt", "asc")
        .get(),
  },
  {
    id: "subtask-comments",
    file: "src/features/tasks/hooks/useSubtaskComments.ts",
    path: "tasks/{taskId}/comments",
    clauses: ["where(subtaskId,==)", "orderBy(createdAt,asc)"],
    reason:
      "Comments on one subtask. The `subtaskId` clause is a product filter, not a permission one: the rule gates on the parent task alone, so this shape is allowed for exactly the callers the unfiltered thread is.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`tasks/${taskId(p)}`).set(taskDoc({ completerUids: [p.uid] }));
      await db.doc(`tasks/${taskId(p)}/comments/c1`).set({
        authorUid: p.uid,
        bodyMarkdown: "Guard subtask comment",
        subtaskId: "s1",
        createdAt: new Date(),
      });
    },
    run: (db, p) =>
      db
        .collection("tasks")
        .doc(taskId(p))
        .collection("comments")
        .where("subtaskId", "==", "s1")
        .orderBy("createdAt", "asc")
        .get(),
  },
  {
    id: "task-attachments",
    file: "src/features/tasks/hooks/useTaskAttachments.ts",
    path: "tasks/{taskId}/attachments",
    clauses: ["orderBy(uploadedAt,desc)"],
    reason:
      "Attachment metadata for a task, in both the task and subtask modals. Same parent-resolved gate. Worth knowing while reading this: storage.rules gates the BLOBS on `role in ['committee','admin']` with no SU test, so a non-SU committee member is denied here and not there.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`tasks/${taskId(p)}`).set(taskDoc({ completerUids: [p.uid] }));
      await db.doc(`tasks/${taskId(p)}/attachments/f1`).set({
        fileName: "guard.pdf",
        storagePath: `tasks/${taskId(p)}/guard.pdf`,
        uploadedAt: new Date(),
        uploadedByUid: p.uid,
      });
    },
    run: (db, p) =>
      db
        .collection("tasks")
        .doc(taskId(p))
        .collection("attachments")
        .orderBy("uploadedAt", "desc")
        .get(),
  },
  {
    id: "tasks-committee-board",
    pins: [
      {
        file: "src/app/(app)/committee/tasks/page.tsx",
        text: 'useTasks({ visibility: "committee", includeArchived: showArchived })',
      },
    ],
    file: "src/features/tasks/hooks/useTasks.ts",
    path: "tasks",
    clauses: ["where(visibility,==)"],
    unresolved:
      "useTasks builds its constraint array conditionally and spreads it into query(), so the scanner can see the collection but not the clauses. The three shapes its callers actually produce are declared as three entries, found by reading every call site: /committee/tasks passes { visibility: 'committee' }, /tasks and MyWorkSummary pass { completerUid }, and /admin/danger-zone passes neither. `projectId` and `source` are supported by the hook and passed by nobody.",
    reason:
      "The committee board's query. `visibility == 'committee'` matches the rule's committee branch, but that branch is still resource-dependent (it reads the document's visibility), so the clause alone does not save a caller who is not SU committee: the board is gated to SU committee and admins in committee/layout.tsx for exactly that reason.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc("tasks/guard-board-task").set(taskDoc());
    },
    run: (db) => db.collection("tasks").where("visibility", "==", "committee").get(),
  },
  {
    id: "tasks-my-work",
    pins: [
      {
        file: "src/app/(app)/tasks/page.tsx",
        text: "useTasks(user ? { completerUid: user.uid, includeArchived: false } : {})",
      },
      {
        file: "src/features/tasks/components/MyWorkSummary.tsx",
        text: "useTasks(user ? { completerUid: user.uid } : {})",
      },
    ],
    file: "src/features/tasks/hooks/useTasks.ts",
    path: "tasks",
    clauses: ["where(completerUids,array-contains)"],
    unresolved:
      "The second of the three shapes behind useTasks's spread constraints. See `tasks-committee-board` for how the shapes were enumerated.",
    reason:
      "My Work on /tasks and the dashboard summary, for every approved member. `array-contains` on the caller's own uid is what makes the list legal: the rule's completer branch is per-document, and the clause narrows the candidate set to documents that branch already allows. Drop it and a member sees nothing at all.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`tasks/${taskId(p)}`).set(taskDoc({ completerUids: [p.uid] }));
    },
    run: (db, p) =>
      db.collection("tasks").where("completerUids", "array-contains", p.uid).get(),
  },
  {
    id: "tasks-unfiltered",
    pins: [
      {
        file: "src/app/(app)/admin/(admin-only)/danger-zone/page.tsx",
        text: "useTasks({ includeArchived: true })",
      },
      {
        file: "src/app/(app)/tasks/page.tsx",
        text: "useTasks(user ? { completerUid: user.uid, includeArchived: false } : {})",
      },
      {
        file: "src/features/tasks/components/MyWorkSummary.tsx",
        text: "useTasks(user ? { completerUid: user.uid } : {})",
      },
    ],
    file: "src/features/tasks/hooks/useTasks.ts",
    path: "tasks",
    clauses: [],
    unresolved:
      "The third shape behind the spread: no constraints at all. Issued deliberately by /admin/danger-zone, and issued INCIDENTALLY by /tasks and MyWorkSummary in the render before Firebase Auth resolves, because both pass `{}` while `user` is still null. That transient copy is refused for a member and logged; it is not a bug, but it is why this shape has to be registered rather than treated as admin-only.",
    reason:
      "Every task including archived ones, for the danger zone's wipe count. Only the admin branch of the rule is resource-independent, so this is an admin-only shape, which matches the (admin-only) route group it is mounted in.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc("tasks/guard-board-task").set(taskDoc());
    },
    run: (db) => db.collection("tasks").get(),
  },

  // =====================================================================
  // Worksheets: the library, its shelves, and the circulations under them
  //
  // Two gates, and they are not the same one. The LIBRARY and the EDITOR sit
  // under src/app/(app)/worksheets/(author)/layout.tsx, which admits committee
  // and admin and nothing else, SU recognition deliberately not consulted (a
  // worksheet holds questions, not member PII). The RESPOND page sits OUTSIDE
  // that group, under the plain (app) shell, so its audience is every approved
  // member: gating a recipient behind a committee role would lock them out of
  // the thing they were sent. `permissions.circulateWorksheet` grants nothing
  // in firestore.rules at all: sending is a route, so no permission persona is
  // named on any entry below.
  // =====================================================================
  {
    id: "worksheets-library-unfiltered",
    file: "src/features/worksheets/hooks/useWorksheets.ts",
    path: "worksheets",
    clauses: [],
    reason:
      "The library list as an ADMIN issues it. /worksheets admits committee and admin alike, but only the admin branch of the worksheets read rule is resource-independent, so this unfiltered shape is refused for every committee member, with an empty library and a console line nobody reads. That is why the hook holds two literal call sites rather than one query it appends a clause to. Both halves are registered so a later edit that collapses the branch takes the whole library away from the committee visibly, here, rather than in production.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`worksheets/${WORKSHEET_ID}`).set(worksheetDoc());
    },
    run: (db) => db.collection("worksheets").get(),
  },
  {
    id: "worksheets-library-not-private",
    file: "src/features/worksheets/hooks/useWorksheets.ts",
    path: "worksheets",
    clauses: ["where(private,==)"],
    reason:
      "The same library list as every committee member runs it, and the clause is not a filter the caller may drop. Firestore discharges the rule's bare `resource.data.private == false` from a matching `where('private','==',false)` and refuses the whole listen without it. A non-admin author does not see their own private worksheets in this list and that is a non-gap: `private` is admin-only to set in both directions, so a committee member can never own one. Their route to a private worksheet an admin made is the `get` on the editor page, not this list.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`worksheets/${WORKSHEET_ID}`).set(worksheetDoc());
    },
    run: (db) => db.collection("worksheets").where("private", "==", false).get(),
  },
  {
    id: "worksheet-doc-shared",
    sharesKeyWith: "worksheet-doc-private",
    file: "src/features/worksheets/hooks/useWorksheet.ts",
    path: "worksheets/{worksheetId}",
    clauses: [],
    docShape:
      "A worksheet somebody else wrote with `private: false`: the ordinary library document, which the editor page opens so a committee member can read it and take a copy of it.",
    reason:
      "The editor page's document listen at /worksheets/[worksheetId], gated to committee and admin. A `get` rather than a list, which is what lets the rule's author branch apply to a single document the library list could never show. The page tells a non-author 'This one is somebody else's. You can read it and take a copy to work on', so a refusal for the committee persona here would make that sentence false, and the row bodies unreadable.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`worksheets/${WORKSHEET_ID}`).set(worksheetDoc());
    },
    run: (db) => db.doc(`worksheets/${WORKSHEET_ID}`).get(),
  },
  {
    id: "worksheet-doc-private",
    sharesKeyWith: "worksheet-doc-shared",
    file: "src/features/worksheets/hooks/useWorksheet.ts",
    path: "worksheets/{worksheetId}",
    clauses: [],
    docShape:
      "The same path holding an admin's private worksheet, authored by somebody else. `private` is admin-only to set at create and at update, so this is a document no committee member can own or produce.",
    reason:
      "The fixture is the variable here, not the shape: the identical call is allowed on a shared worksheet and refused on a private one for everybody but an admin. The editor page renders one screen for a refusal and for a missing document on purpose, because the rule dereferences `resource.data.private` and a client cannot tell the two apart. Registered so that widening the read rule to make private worksheets browsable shows up as a changed outcome rather than as nobody noticing.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`worksheets/${WORKSHEET_ID}`).set(worksheetDoc({ private: true }));
    },
    run: (db) => db.doc(`worksheets/${WORKSHEET_ID}`).get(),
  },
  {
    id: "worksheet-folders-list",
    file: "src/features/worksheets/hooks/useWorksheetFolders.ts",
    path: "worksheetFolders",
    clauses: [],
    reason:
      "The shelf chips above the library. `worksheetFolders` is readable by committee and admin with no per-document condition, so there is no clause for a query to carry and none is written: a folder is shared furniture rather than an owned document, deliberately, so that a shelf whose maker has left the committee is still one somebody can rename. Registered so that adding an ownership test to the folder rule later fails here rather than as a chip row that quietly stops rendering.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`worksheetFolders/${FOLDER_ID}`).set({
        name: "Guard shelf",
        createdByUid: OTHER,
      });
    },
    run: (db) => db.collection("worksheetFolders").get(),
  },
  {
    id: "worksheets-folder-refile-scan",
    file: "src/features/worksheets/worksheetMutations.ts",
    path: "worksheets",
    clauses: ["where(folderId,==)", "where(authorUid,==)"],
    reason:
      "`deleteFolder` reads the caller's OWN worksheets off a shelf before deleting it, and `authorUid == self` does two jobs at once: it scopes the re-file to updates the caller is certainly allowed to make, and it is the clause Firestore proves the read rule's author branch from, so the read is granted whether or not those worksheets are private. An earlier draft carried `private == false` instead, which made any shelf holding a second author's worksheet undeletable by anybody but an admin. Same library gate: committee or admin.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db
        .doc(`worksheets/${WORKSHEET_ID}`)
        .set(worksheetDoc({ folderId: FOLDER_ID, authorUid: p.uid }));
    },
    run: (db, p) =>
      db
        .collection("worksheets")
        .where("folderId", "==", FOLDER_ID)
        .where("authorUid", "==", p.uid)
        .get(),
  },
  {
    id: "my-circulations-staff-list",
    file: "src/features/worksheets/hooks/useMyCirculations.ts",
    path: "circulations",
    clauses: ["where(staffUids,array-contains)"],
    reason:
      "The Sent tab on /worksheets: every circulation the viewer is staff on, which is wider than the ones they sent because a reviewer needs the door to the sends they are expected to read. `allow list: if isAdmin() || isStaff()` and the staff half is resource-dependent, so `array-contains` on staffUids is what discharges it and the listen is refused wholesale without it. Note what the rule does NOT test: role. Any signed-in account named in staffUids may run this shape, and the committee gate on the page is what keeps a pending or plain member off the tab.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`circulations/${CIRC_ID}`).set(circulationDoc({ staffUids: [p.uid] }));
    },
    run: (db, p) =>
      db.collection("circulations").where("staffUids", "array-contains", p.uid).get(),
  },
  {
    id: "worksheet-circulations-staff-list",
    file: "src/features/worksheets/hooks/useWorksheetCirculations.ts",
    path: "circulations",
    clauses: ["where(worksheetId,==)", "where(staffUids,array-contains)"],
    reason:
      "The circulations of ONE worksheet, listed under the editor so an author can see where their questions have gone. `worksheetId` narrows it and `staffUids array-contains` is the clause the list rule is proved from, exactly as on the Sent tab. Equality plus array-contains with no orderBy merges from the automatic single-field indexes, so this shape owes no composite index and tests/firestore-indexes.test.mjs agrees; the sort is client-side for the same reason.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`circulations/${CIRC_ID}`).set(circulationDoc({ staffUids: [p.uid] }));
    },
    run: (db, p) =>
      db
        .collection("circulations")
        .where("worksheetId", "==", WORKSHEET_ID)
        .where("staffUids", "array-contains", p.uid)
        .get(),
  },
  {
    id: "circulation-doc-staff",
    sharesKeyWith: "circulation-doc-recipient",
    file: "src/features/worksheets/hooks/useCirculation.ts",
    path: "circulations/{circulationId}",
    clauses: [],
    docShape:
      "One circulation whose `staffUids` names the caller: the sender, the worksheet's author, or a reviewer they named. That array is written by the routes only, and every staff rule keys off it.",
    reason:
      "The circulation page's document listen at /worksheets/[worksheetId]/circulations/[circulationId]. `get` and `list` are split on this collection precisely so this call can admit a recipient as well as staff without putting an exists() inside a list rule, where it would blow the twenty-document access budget once a Sent tab grew past twenty rows. The recipient half is the paired entry.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`circulations/${CIRC_ID}`).set(circulationDoc({ staffUids: [p.uid] }));
    },
    run: (db) => db.doc(`circulations/${CIRC_ID}`).get(),
  },
  {
    id: "circulation-doc-recipient",
    sharesKeyWith: "circulation-doc-staff",
    file: "src/features/worksheets/hooks/useCirculation.ts",
    path: "circulations/{circulationId}",
    clauses: [],
    docShape:
      "The same circulation with `staffUids` naming somebody else, plus a `responses/{caller}` document. That response IS the recipient's proof of access: there is no roster array on the circulation to test against.",
    reason:
      "The respond page and the worksheet task panel read the circulation as the RECIPIENT, who is not staff and may be any approved member, because /worksheets/respond sits outside the committee group on purpose. The rule proves them with one exists() on a path built from their own uid, so it cannot be aimed at anybody else's send. Pending is recorded as allowed because that is what the rule says: the (app) shell redirects a pending account before the page renders, and nothing mints a response for one today (the circulate route addresses committee and admins only).",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`circulations/${CIRC_ID}`).set(circulationDoc());
      await db.doc(`circulations/${CIRC_ID}/responses/${p.uid}`).set(responseDoc(p.uid));
    },
    run: (db) => db.doc(`circulations/${CIRC_ID}`).get(),
  },
  {
    id: "circulation-responses-staff",
    sharesKeyWith: "circulation-responses-recipient",
    file: "src/features/worksheets/hooks/useCirculationResponses.ts",
    path: "circulations/{circulationId}/responses",
    clauses: [],
    reason:
      "The recipient table on the circulation page: every response on one send, unfiltered. Staff read the whole subcollection and the rule discharges that with ONE get() of the parent circulation however many rows come back, which is why no clause is written and why none would help. Ordering is client-side by addedAt, because an orderBy would drop any response written without the field from the listen entirely, and a recipient missing from the table is a person nobody chases.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`circulations/${CIRC_ID}`).set(circulationDoc({ staffUids: [p.uid] }));
      await db.doc(`circulations/${CIRC_ID}/responses/${OTHER}`).set(responseDoc(OTHER));
    },
    run: (db) => db.collection(`circulations/${CIRC_ID}/responses`).get(),
  },
  {
    id: "circulation-responses-recipient",
    sharesKeyWith: "circulation-responses-staff",
    file: "src/features/worksheets/hooks/useCirculationResponses.ts",
    path: "circulations/{circulationId}/responses",
    clauses: [],
    reason:
      "The same listen issued by a RECIPIENT, which is refused and has to be. `isOwner()` is per-document-id, and a document id is not something a query constrains, so a recipient's list of the subcollection is denied wholesale rather than trimmed to their own row: one recipient must never enumerate what the others wrote. This is why CirculationPage passes null to the hook until it knows the viewer is staff. Written down as an expected refusal so that making the table load for everybody is a visible decision rather than a one-line rule edit.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`circulations/${CIRC_ID}`).set(circulationDoc());
      await db.doc(`circulations/${CIRC_ID}/responses/${p.uid}`).set(responseDoc(p.uid));
    },
    run: (db) => db.collection(`circulations/${CIRC_ID}/responses`).get(),
  },
  {
    id: "response-doc-own",
    sharesKeyWith: "response-doc-staff",
    file: "src/features/worksheets/hooks/useResponse.ts",
    path: "circulations/{circulationId}/responses/{responseUid}",
    clauses: [],
    docShape:
      "The caller's own response, at the document id that IS their uid, holding the answers the respond page autosaves into and the state that freezes it once submitted.",
    reason:
      "The respond page's own read at /worksheets/respond/[circulationId], which sits outside the committee gate because a recipient may be any approved member. `isOwner()` is structural (the id is the uid), so this branch needs no lookup and cannot be aimed at somebody else's answers. Pending is allowed by the rule and kept off the page by the (app) shell, the same split as the circulation get above.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`circulations/${CIRC_ID}`).set(circulationDoc());
      await db.doc(`circulations/${CIRC_ID}/responses/${p.uid}`).set(responseDoc(p.uid));
    },
    run: (db, p) => db.doc(`circulations/${CIRC_ID}/responses/${p.uid}`).get(),
  },
  {
    id: "response-doc-staff",
    sharesKeyWith: "response-doc-own",
    file: "src/features/worksheets/hooks/useResponse.ts",
    path: "circulations/{circulationId}/responses/{responseUid}",
    clauses: [],
    docShape:
      "Somebody else's response, addressed by their uid: what WorksheetTaskPanel passes when a reviewer opens the task (task.completerUids[0]), and what the response drawer reads on the circulation page.",
    reason:
      "The staff half of the same call, and the fixture is what decides which branch runs. This one takes `isParentStaff()`, which costs one get() of the parent circulation, so a caller who is neither the owner nor staff is refused, and a caller whose parent circulation does not exist is refused by evaluation error rather than served an empty document. The cross-recipient refusal itself (one recipient reading another's answers) is proven in scripts/rules-tests/tests/worksheets.test.mjs; what this entry adds is that the hook's own shape reaches the staff branch.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`circulations/${CIRC_ID}`).set(circulationDoc({ staffUids: [p.uid] }));
      await db.doc(`circulations/${CIRC_ID}/responses/${OTHER}`).set(responseDoc(OTHER));
    },
    run: (db) => db.doc(`circulations/${CIRC_ID}/responses/${OTHER}`).get(),
  },
  {
    id: "review-doc-staff",
    sharesKeyWith: "review-doc-recipient",
    file: "src/features/worksheets/hooks/useReview.ts",
    path: "circulations/{circulationId}/reviews/{reviewUid}",
    clauses: [],
    docShape:
      "The review of ONE recipient, at a document id that is the reviewed person's uid: the per-question feedback and the per-question scores ReviewPanel writes client-direct while staff read the answers beside it.",
    reason:
      "The staff half of the review panel, opened from the response drawer on the circulation page. The gate is `isParentStaff()`, one get() of the parent circulation's staffUids, so the fixture puts the persona on that list and every signed-in hat is admitted by it: being asked to review a circulation is the permission, not a role. Addressed, never listed, so one reviewer cannot page through every judgement filed on a send. Registered as its own entry rather than riding useResponse's because the two subcollections have DIFFERENT read rules and only this one refuses the person it is about, which is the entry below.",
    outcomes: {
      "signed-out": "refused",
      pending: "allowed",
      member: "allowed",
      committee: "allowed",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`circulations/${CIRC_ID}`).set(circulationDoc({ staffUids: [p.uid] }));
      await db.doc(`circulations/${CIRC_ID}/reviews/${OTHER}`).set(reviewDoc());
    },
    run: (db) => db.doc(`circulations/${CIRC_ID}/reviews/${OTHER}`).get(),
  },
  {
    id: "review-doc-recipient",
    sharesKeyWith: "review-doc-staff",
    file: "src/features/worksheets/hooks/useReview.ts",
    path: "circulations/{circulationId}/reviews/{reviewUid}",
    clauses: [],
    docShape:
      "The persona's OWN review: the notes and the scores somebody else has written about their answers, at the document id that is their uid.",
    reason:
      "The same call aimed at the read that must never work, and the reason the review lives in its own subcollection at all. `isOwner()` is deliberately absent from the reviews rule, so the document id being the reader's uid grants nothing: a recipient asking for their own review is refused, which is what makes 'scores are never seen by the person being scored' a fact about the rules rather than a convention about which fields a page renders. Written down as an expected refusal so that adding an owner branch would have to fail this entry first. Admin is allowed because admins take the resource-independent branch of every rule, which is exactly why the members above are the personas that prove anything here.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "refused",
      admin: "allowed",
    },
    seed: async (db, p) => {
      await db.doc(`circulations/${CIRC_ID}`).set(circulationDoc());
      await db.doc(`circulations/${CIRC_ID}/responses/${p.uid}`).set(responseDoc(p.uid));
      await db.doc(`circulations/${CIRC_ID}/reviews/${p.uid}`).set(reviewDoc());
    },
    run: (db, p) => db.doc(`circulations/${CIRC_ID}/reviews/${p.uid}`).get(),
  },

  // =====================================================================
  // The member record, on the admin Members row
  // =====================================================================
  {
    id: "member-record-applications",
    file: "src/features/admin/useMemberApplications.ts",
    path: "memberRecords/{uid}/applications",
    clauses: [],
    reason:
      "One person's application history, listed under their row on the admin Members page: a copy of what they applied for, what was decided, how they scored and what the reviewers wrote, taken when a round settles or is destroyed so that destroying the round does not destroy the committee's memory of the person. The GATE ON THE PAGE is `requireAdminPage()` (the (admin-only) group), so an admin is the only persona who can reach this hook today. The RULE is wider on purpose, admin OR SU-recognised committee, which is the same audience the users collection already trusts with member PII, and the entry pins that: the day this record is surfaced anywhere an SU-recognised committee member works, the read has to already be allowed rather than discovered to be refused. Everybody else is refused, the person it describes included: it is the committee's record ABOUT them, not their copy of it, and a member who could list their own subtree would be reading their reviewers' private notes. No clauses, because the rule admits the whole subcollection or none of it, and the fixture sits under OTHER so no persona is quietly reading their own.",
    outcomes: {
      "signed-out": "refused",
      pending: "refused",
      member: "refused",
      committee: "refused",
      "su-committee": "allowed",
      admin: "allowed",
    },
    seed: async (db) => {
      await db.doc(`memberRecords/${OTHER}`).set({ uid: OTHER });
      await db.doc(`memberRecords/${OTHER}/applications/round-1`).set({
        roundId: "round-1",
        roundTitle: "Autumn intake",
        roundKind: "enrolment",
        appliedFor: ["Technical track"],
        outcome: { decision: "accept", status: "accepted", targetRunId: null },
        scoreSummary: { reviewerCount: 1, total: 8, mean: 8, byCriterion: {} },
        reviewerNotes: [
          {
            reviewerUid: "sucom1",
            reviewerName: "A reviewer",
            recommendation: "advance",
            total: 8,
            notes: "Clear on why they want to do this.",
          },
        ],
        writtenBy: "settle",
        writtenByUid: "admin1",
      });
    },
    run: (db) =>
      db.collection("memberRecords").doc(OTHER).collection("applications").get(),
  },
];

/**
 * How many reads the scanner cannot resolve in each file that declares one.
 * Counted, not merely named, so a NEW unreadable read added beside the
 * declared one fails the coverage test instead of riding its declaration.
 */
export const UNRESOLVED_SITE_COUNTS = {
  "src/features/tasks/hooks/useTasks.ts": 1,
  "src/features/courses/useWeek.ts": 1,
};
