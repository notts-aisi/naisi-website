"use client";

import {
  collection,
  deleteField,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import { slugId } from "@/lib/firestore/slugId";
import { isValidDateKey, type WeekPlanEntry } from "@/lib/courses/weekPlan";
import { cohortError, type RunCohort } from "@/lib/courses/cohortLabel";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import type { FormQuestion } from "@/lib/firestore/events";
import {
  COURSE_FIELD_LIMITS,
  EMPTY_APPLICATION_COUNTS,
  courseRunChannel,
  weekDocId,
  type ChecklistItem,
  type CourseEnrolMode,
  type CourseRunStatus,
  type CourseRunStream,
  type CourseStatus,
  type CourseTrack,
  type CourseWeekDoc,
  type Exercise,
  type Material,
} from "@/lib/firestore/courses";
import {
  GROUP_FIELD_LIMITS,
  groupCapacityError,
  type GroupSession,
} from "@/lib/firestore/courseGroups";

/**
 * Admin write path for course authoring — courses, runs, groups.
 *
 * Split by where the invariant lives (house style, see adminMutations.ts):
 *
 *  - **Client-direct** (this file's `setDoc`/`updateDoc` calls) for everything
 *    firestore.rules can fully express: course/run/group CONTENT authored by
 *    `draftCourse` / `approveCourse` holders. Every create below writes the
 *    server-owned fields in their required CLEAN state (empty role arrays,
 *    zeroed counters, the deterministic cohort channel) because the rules
 *    only PIN those fields on update — a create that seeded them would smuggle
 *    in roles no route ever assigned.
 *  - **Fetch-backed** (the helpers at the bottom) for everything else: role
 *    arrays, group facilitators (which also upsert an enrolment), run status
 *    transitions, and publication. Those are Admin-SDK route handlers because
 *    they cross documents or need a transition table rules can't hold.
 *
 * No `undefined` ever reaches Firestore: patches are built key-by-key and
 * nullable fields are written as explicit `null`.
 */

function actingUid(): string {
  const uid = getClientAuth().currentUser?.uid;
  if (!uid) throw new Error("Not signed in");
  return uid;
}

/** Trim, then cap at the shared field budget. */
function capped(value: string, max: number): string {
  return value.trim().slice(0, max);
}

/**
 * Cap on a run's application form. Lives here rather than in
 * COURSE_FIELD_LIMITS because the form itself is the events form machinery
 * reused verbatim; the number is the one firestore.rules enforces on
 * `courseRuns` (`applicationForm.size() <= 30`) — keep the two in sync.
 */
const MAX_APPLICATION_FORM_QUESTIONS = 30;

function positiveIntOrNull(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

// ---- Courses ----

/**
 * A course's difficulty line. `CourseDoc.level` is deliberately free text
 * ("No prior experience needed"), not a closed union — this alias names the
 * field's intent at the callsite without inventing a taxonomy the data model
 * doesn't have. Capped at `COURSE_FIELD_LIMITS.level`.
 */
export type CourseLevel = string;

export type CreateCourseInput = {
  title: string;
  tagline: string;
  track: CourseTrack;
  level: CourseLevel;
  estimatedWeeklyHours: number | null;
};

/**
 * Create a draft course. `status`, `authorUid` and the empty
 * `collaboratorUids` are all rule-enforced on create; `summaryBlocks` starts
 * empty and is filled in by the block editor.
 */
export async function createCourse(input: CreateCourseInput): Promise<string> {
  const db = getClientDb();
  const uid = actingUid();

  const title = capped(input.title, COURSE_FIELD_LIMITS.title);
  if (!title) throw new Error("Course title required");

  const ref = doc(collection(db, "courses"), slugId(title));
  await setDoc(ref, {
    title,
    tagline: capped(input.tagline ?? "", COURSE_FIELD_LIMITS.tagline),
    summaryBlocks: [] as Block[],
    track: input.track,
    level: capped(input.level ?? "", COURSE_FIELD_LIMITS.level),
    estimatedWeeklyHours: positiveIntOrNull(input.estimatedWeeklyHours),
    status: "draft" satisfies CourseStatus,
    showcaseRunId: null,
    authorUid: uid,
    collaboratorUids: [] as string[],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * Editable course fields. `authorUid` and `collaboratorUids` are absent by
 * design — the rules pin them, so including them here would only produce
 * permission-denied writes. `showcaseRunId` moves through `publishCourse()`
 * on the publish path; it stays here for the "swap the shop window" edit on
 * an already-published course.
 */
export type CoursePatch = Partial<{
  title: string;
  tagline: string;
  summaryBlocks: Block[];
  track: CourseTrack;
  level: CourseLevel;
  estimatedWeeklyHours: number | null;
  /** Requires `approveCourse` (rules gate every status move). */
  status: CourseStatus;
  showcaseRunId: string | null;
}>;

export async function updateCourse(courseId: string, patch: CoursePatch): Promise<void> {
  const db = getClientDb();
  const out: Record<string, unknown> = {};

  if (patch.title !== undefined) {
    const title = capped(patch.title, COURSE_FIELD_LIMITS.title);
    if (!title) throw new Error("Course title required");
    out.title = title;
  }
  if (patch.tagline !== undefined) {
    out.tagline = capped(patch.tagline, COURSE_FIELD_LIMITS.tagline);
  }
  if (patch.summaryBlocks !== undefined) {
    out.summaryBlocks = patch.summaryBlocks.slice(
      0,
      COURSE_FIELD_LIMITS.maxSummaryBlocks,
    );
  }
  if (patch.track !== undefined) out.track = patch.track;
  if (patch.level !== undefined) {
    out.level = capped(patch.level, COURSE_FIELD_LIMITS.level);
  }
  if (patch.estimatedWeeklyHours !== undefined) {
    out.estimatedWeeklyHours = positiveIntOrNull(patch.estimatedWeeklyHours);
  }
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.showcaseRunId !== undefined) {
    out.showcaseRunId = patch.showcaseRunId ?? null;
  }

  if (Object.keys(out).length === 0) return;
  out.updatedAt = serverTimestamp();
  await updateDoc(doc(db, "courses", courseId), out);
}

// ---- Runs ----

export type CreateRunInput = {
  /** Human run label, e.g. "Autumn 2026". */
  label: string;
  /** Academic year tag, e.g. "2026/27". */
  academicYear: string;
  /** CIVIL date "YYYY-MM-DD" (Europe/London) — never a timestamp. */
  startDate: string;
};

/**
 * Create a draft run of `course`. The run id is slugged from course title +
 * label so the Firebase console stays scannable, and `channel` is derived from
 * that id via `courseRunChannel()` — the rules require exactly
 * `cohort:<runId>`, because a client-chosen channel could aim a cohort email
 * at a different cohort's subscribers.
 */
export async function createRun(
  course: { id: string; title: string },
  input: CreateRunInput,
): Promise<string> {
  const db = getClientDb();
  const uid = actingUid();

  const label = capped(input.label, COURSE_FIELD_LIMITS.runLabel);
  if (!label) throw new Error("Run label required");
  const startDate = (input.startDate ?? "").trim();
  if (!isValidDateKey(startDate)) {
    throw new Error("Start date must be a real YYYY-MM-DD date");
  }

  const ref = doc(collection(db, "courseRuns"), slugId(`${course.title} ${label}`));
  await setDoc(ref, {
    courseId: course.id,
    courseTitle: capped(course.title, COURSE_FIELD_LIMITS.title),
    label,
    academicYear: capped(input.academicYear ?? "", COURSE_FIELD_LIMITS.academicYear),
    status: "draft" satisfies CourseRunStatus,
    startDate,
    weekPlan: [] as WeekPlanEntry[],
    applicationForm: [] as FormQuestion[],
    applicationsOpenAt: null,
    applicationsCloseAt: null,
    applicationCap: null,
    // Server-owned, and required to start clean by the create rule.
    admissionsReviewerUids: [] as string[],
    runFacilitatorUids: [] as string[],
    trackLeadUids: [] as string[],
    applicationCounts: EMPTY_APPLICATION_COUNTS,
    groupCount: 0,
    // Also server-owned, and also birth-pinned: a run is born on the
    // application path with no streams and nobody on it, and only
    // PATCH /api/courses/runs/[runId]/enrol-mode moves it. Written
    // explicitly rather than left to the rules' `.get()` defaults so the
    // fields exist for the queries that filter on them.
    //
    // `submissionExerciseRef` is deliberately NOT written: the rules pin it
    // with `.get('submissionExerciseRef', {})`, and a stored null compares
    // unequal to that default and wedges every later non-admin edit of the
    // run. Absent is the only legal unset form. See courses.ts.
    enrolMode: "admissions" satisfies CourseEnrolMode,
    streams: [] as CourseRunStream[],
    enrolledCount: 0,
    channel: courseRunChannel(ref.id),
    authorUid: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * Editable run fields. Server-owned state (role arrays, counters, channel,
 * authorUid, courseId) is pinned by the rules and absent here; `status` is
 * absent too because the transition table lives in the status route — use
 * `setRunStatus()`.
 */
export type CourseRunPatch = Partial<{
  label: string;
  academicYear: string;
  courseTitle: string;
  startDate: string;
  weekPlan: WeekPlanEntry[];
  applicationForm: FormQuestion[];
  applicationsOpenAt: Date | null;
  applicationsCloseAt: Date | null;
  applicationCap: number | null;
  /**
   * V3 W1 PR7. `null` CLEARS the cohort, and it clears it with
   * `deleteField()`, never by storing a null. The rules cap reads
   * `request.resource.data.get('cohort', {}).keys().hasOnly([...])`, and
   * `.keys()` on a stored null raises and denies the write, so a null here
   * would wedge every later non-admin edit of the run, which is the exact trap
   * already recorded for `submissionExerciseRef`.
   */
  cohort: RunCohort | null;
  startHereBlocks: Block[];
}>;

export async function updateRun(runId: string, patch: CourseRunPatch): Promise<void> {
  const db = getClientDb();
  const out: Record<string, unknown> = {};

  if (patch.label !== undefined) {
    const label = capped(patch.label, COURSE_FIELD_LIMITS.runLabel);
    if (!label) throw new Error("Run label required");
    out.label = label;
  }
  if (patch.academicYear !== undefined) {
    out.academicYear = capped(patch.academicYear, COURSE_FIELD_LIMITS.academicYear);
  }
  if (patch.courseTitle !== undefined) {
    out.courseTitle = capped(patch.courseTitle, COURSE_FIELD_LIMITS.title);
  }
  if (patch.startDate !== undefined) {
    const startDate = patch.startDate.trim();
    // A garbled start date poisons every derived week number for the whole
    // cohort, so it is rejected here as well as in the rules.
    if (!isValidDateKey(startDate)) {
      throw new Error("Start date must be a real YYYY-MM-DD date");
    }
    out.startDate = startDate;
  }
  if (patch.weekPlan !== undefined) {
    out.weekPlan = patch.weekPlan.slice(0, COURSE_FIELD_LIMITS.maxWeekPlanEntries);
  }
  if (patch.applicationForm !== undefined) {
    out.applicationForm = patch.applicationForm.slice(
      0,
      MAX_APPLICATION_FORM_QUESTIONS,
    );
  }
  if (patch.applicationsOpenAt !== undefined) {
    out.applicationsOpenAt = patch.applicationsOpenAt ?? null;
  }
  if (patch.applicationsCloseAt !== undefined) {
    out.applicationsCloseAt = patch.applicationsCloseAt ?? null;
  }
  if (patch.applicationCap !== undefined) {
    out.applicationCap = positiveIntOrNull(patch.applicationCap);
  }
  if (patch.cohort !== undefined) {
    if (patch.cohort === null) {
      // ABSENT, never null. See CourseRunPatch.cohort.
      out.cohort = deleteField();
    } else {
      const error = cohortError(patch.cohort);
      if (error) throw new Error(error);
      out.cohort = {
        term: patch.cohort.term,
        year: Math.floor(patch.cohort.year),
        number: Math.floor(patch.cohort.number),
      };
    }
  }
  if (patch.startHereBlocks !== undefined) {
    out.startHereBlocks = patch.startHereBlocks.slice(
      0,
      COURSE_FIELD_LIMITS.maxStartHereBlocks,
    );
  }

  if (Object.keys(out).length === 0) return;
  out.updatedAt = serverTimestamp();
  await updateDoc(doc(db, "courseRuns", runId), out);
}

// ---- Groups ----

/**
 * The slot fields a group editor collects. The three timing fields are what
 * `SessionSlotField` owns; location / meeting link / notes are edited beside
 * it and default to "empty but present" so the stored `session` map always has
 * the full shape (`sessionForWeek()` merges overrides onto it).
 */
export type CourseGroupSessionInput = {
  weekday: number;
  startTimeLocal: string;
  durationMinutes: number;
  location?: string;
  meetingUrl?: string | null;
  notes?: string;
};

function normalizeSessionInput(input: CourseGroupSessionInput): GroupSession {
  const meetingUrl = (input.meetingUrl ?? "").trim();
  return {
    weekday: Math.min(6, Math.max(0, Math.round(input.weekday))),
    startTimeLocal: input.startTimeLocal,
    durationMinutes: Math.min(
      GROUP_FIELD_LIMITS.maxDurationMinutes,
      Math.max(0, Math.round(input.durationMinutes)),
    ),
    location: capped(input.location ?? "", GROUP_FIELD_LIMITS.location),
    meetingUrl: meetingUrl ? meetingUrl.slice(0, GROUP_FIELD_LIMITS.meetingUrl) : null,
    notes: capped(input.notes ?? "", GROUP_FIELD_LIMITS.notes),
  };
}

export type CreateGroupInput = {
  name: string;
  /** Allocation cap; null = uncapped. */
  capacity: number | null;
  session: CourseGroupSessionInput;
};

/**
 * THE CAPACITY RULE, in the one layer that can see both documents.
 *
 * `groupCapacityError` needs the parent run's `enrolMode`, which is why the
 * group normaliser cannot carry this check and why both group writers take
 * the run's mode as an argument rather than reading it off the group. Without
 * it the rules' `groupCapacityOk()` is the only thing standing between an
 * uncapped open-mode group and a register that fails for everybody in it, and
 * what a facilitator sees when it fires is a raw permission-denied.
 *
 * Thrown, not returned: these two functions are the last thing between the
 * editor and Firestore, and a caller that forgets to check gets a message a
 * human can read instead of a rules rejection nobody can act on. The editor
 * checks first anyway, so in practice this throw is the backstop.
 */
function assertGroupCapacity(
  capacity: number | null,
  enrolMode: CourseEnrolMode,
): void {
  const message = groupCapacityError(capacity, enrolMode);
  if (message) throw new Error(message);
}

/**
 * Create a group inside `run`. `facilitatorUids` and `memberCount` start
 * empty/zero (rule-enforced): facilitators arrive via
 * `setGroupFacilitators()` and the count moves only inside the allocation
 * transaction, so it can never drift from the enrolment docs it summarises.
 *
 * `run.enrolMode` is required because an open-mode run's groups MUST carry a
 * capacity; see `assertGroupCapacity`.
 */
export async function createGroup(
  run: { id: string; courseId: string; label: string; enrolMode: CourseEnrolMode },
  input: CreateGroupInput,
): Promise<string> {
  const db = getClientDb();
  const name = capped(input.name, GROUP_FIELD_LIMITS.name);
  if (!name) throw new Error("Group name required");
  const capacity = positiveIntOrNull(input.capacity);
  assertGroupCapacity(capacity, run.enrolMode);

  const ref = doc(collection(db, "courseGroups"), slugId(`${run.label} ${name}`));
  await setDoc(ref, {
    runId: run.id,
    courseId: run.courseId,
    name,
    facilitatorUids: [] as string[],
    capacity,
    memberCount: 0,
    session: normalizeSessionInput(input.session),
    sessionOverrides: {},
    archived: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export type CourseGroupPatch = Partial<{
  name: string;
  capacity: number | null;
  /** Partial: only the slot fields present are written (dotted paths). */
  session: Partial<GroupSession>;
  sessionOverrides: Record<string, Partial<GroupSession>>;
  archived: boolean;
}>;

/**
 * Patch one group. `enrolMode` is the PARENT RUN's, and it is a required
 * argument for the same reason `createGroup` takes one: a capacity edit is
 * only valid against the run's mode, and this function cannot read it.
 */
export async function updateGroup(
  groupId: string,
  patch: CourseGroupPatch,
  enrolMode: CourseEnrolMode,
): Promise<void> {
  const db = getClientDb();
  const out: Record<string, unknown> = {};

  if (patch.name !== undefined) {
    const name = capped(patch.name, GROUP_FIELD_LIMITS.name);
    if (!name) throw new Error("Group name required");
    out.name = name;
  }
  if (patch.capacity !== undefined) {
    const capacity = positiveIntOrNull(patch.capacity);
    assertGroupCapacity(capacity, enrolMode);
    out.capacity = capacity;
  }
  if (patch.archived !== undefined) out.archived = patch.archived;

  // Dotted field paths so a partial slot edit (just the room, just the time)
  // merges into the stored session instead of replacing the whole map and
  // silently dropping the fields the caller didn't send.
  const session = patch.session;
  if (session) {
    if (session.weekday !== undefined) {
      out["session.weekday"] = Math.min(6, Math.max(0, Math.round(session.weekday)));
    }
    if (session.startTimeLocal !== undefined) {
      out["session.startTimeLocal"] = session.startTimeLocal;
    }
    if (session.durationMinutes !== undefined) {
      out["session.durationMinutes"] = Math.min(
        GROUP_FIELD_LIMITS.maxDurationMinutes,
        Math.max(0, Math.round(session.durationMinutes)),
      );
    }
    if (session.location !== undefined) {
      out["session.location"] = capped(session.location, GROUP_FIELD_LIMITS.location);
    }
    if (session.meetingUrl !== undefined) {
      const url = (session.meetingUrl ?? "").trim();
      out["session.meetingUrl"] = url
        ? url.slice(0, GROUP_FIELD_LIMITS.meetingUrl)
        : null;
    }
    if (session.notes !== undefined) {
      out["session.notes"] = capped(session.notes, GROUP_FIELD_LIMITS.notes);
    }
  }

  if (patch.sessionOverrides !== undefined) {
    const entries = Object.entries(patch.sessionOverrides).slice(
      0,
      GROUP_FIELD_LIMITS.maxSessionOverrides,
    );
    out.sessionOverrides = Object.fromEntries(entries);
  }

  if (Object.keys(out).length === 0) return;
  out.updatedAt = serverTimestamp();
  await updateDoc(doc(db, "courseGroups", groupId), out);
}

/**
 * Archive / unarchive a group. Soft archive is the primary path — deleting a
 * group would have to re-pool its members through the allocation transaction,
 * so client delete is blocked outright in the rules.
 */
export async function setGroupArchived(
  groupId: string,
  archived: boolean,
): Promise<void> {
  const db = getClientDb();
  await updateDoc(doc(db, "courseGroups", groupId), {
    archived,
    updatedAt: serverTimestamp(),
  });
}

// ---- Route-backed helpers ----

/**
 * House shape: read `{ error }` off a failed response, else a generic fallback.
 * The parsed body is returned so the handful of routes that answer with a
 * result (clone-weeks' counts) don't need a second, near-identical helper;
 * callers that ignore it leave `T` at its `void` default.
 */
async function postJson<T = void>(
  url: string,
  body: unknown,
  fallback: string,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(parsed.error ?? fallback);
  }
  return parsed as unknown as T;
}

export type RunRoleAssignment = {
  admissionsReviewerUids?: string[];
  trackLeadUids?: string[];
  runFacilitatorUids?: string[];
};

/**
 * Assign a run's server-owned role arrays. Admin-only, and each list is
 * intersected server-side against the eligible member set — the rules pin
 * these fields precisely so a drafter can't seed themselves reviewers.
 * Omitted keys are left untouched.
 */
export async function assignRunRoles(
  runId: string,
  roles: RunRoleAssignment,
): Promise<void> {
  await postJson(
    `/api/courses/runs/${runId}/roles`,
    roles,
    "Couldn't update the run's roles.",
  );
}

/**
 * Replace a group's facilitators. The route also upserts / retires the
 * matching `role: "facilitator"` enrolment rows, which is why this can't be a
 * client write.
 */
export async function setGroupFacilitators(
  groupId: string,
  uids: string[],
): Promise<void> {
  await postJson(
    `/api/courses/groups/${groupId}/facilitators`,
    { uids },
    "Couldn't update this group's facilitators.",
  );
}

/** Move a run along its lifecycle. The allowed-transition table is server-side. */
export async function setRunStatus(
  runId: string,
  status: CourseRunStatus,
): Promise<void> {
  await postJson(
    `/api/courses/runs/${runId}/status`,
    { status },
    "Couldn't change this run's status.",
  );
}

/** One week doc the normalisation would re-address. */
export type WeekIdMove = {
  from: string;
  to: string;
  weekNumber: number;
  /** False when the slot has no authored document yet: a plan-only fix. */
  hasDoc: boolean;
};

export type NormaliseWeeksResult = {
  moves: WeekIdMove[];
  restamps: { weekId: string; from: number; to: number }[];
  changed: number;
};

/**
 * Re-address a DRAFT run's weeks so the plan's `weekId` and the id every
 * member-facing surface derives (`weekDocId(weekNumber)`) agree again.
 *
 * Admin SDK, and refused outright once the run leaves draft. See the route
 * for why the draft boundary is the only place this is free. `dryRun` returns
 * the same moves without writing, which is what the builder previews.
 */
export async function normaliseRunWeekIds(
  runId: string,
  opts: { dryRun?: boolean } = {},
): Promise<NormaliseWeeksResult> {
  return postJson<NormaliseWeeksResult>(
    `/api/courses/runs/${runId}/normalise-weeks`,
    { dryRun: opts.dryRun === true },
    "Couldn't normalise this run's week ids.",
  );
}

/**
 * Publish a course to the public catalogue, optionally pointing the public
 * curriculum at `showcaseRunId` (null = published with no curriculum preview).
 */
export async function publishCourse(
  courseId: string,
  showcaseRunId: string | null,
): Promise<void> {
  await postJson(
    `/api/courses/${courseId}/publish`,
    { showcaseRunId },
    "Couldn't publish this course.",
  );
}

// ---- Weeks (curriculum content) ----

/**
 * A week doc id: "w01".."w60". Mirrored from firestore.rules
 * (`weekId.matches('^w[0-9][0-9]$')`) so a typo'd id fails here with a readable
 * message instead of as a permission-denied write.
 */
const WEEK_ID_PATTERN = /^w\d\d$/;

function assertWeekAddress(weekId: string, weekNumber: number): number {
  if (!WEEK_ID_PATTERN.test(weekId)) {
    throw new Error(`"${weekId}" isn't a week id (expected w01–w60).`);
  }
  const n = Math.floor(weekNumber);
  if (!Number.isFinite(n) || n < 1 || n > COURSE_FIELD_LIMITS.maxWeekPlanEntries) {
    throw new Error("Week number must be between 1 and 60.");
  }
  // Deliberately does NOT require `weekId === weekDocId(n)`. A reordered plan
  // legitimately carries a week whose id and number disagree, and that is the
  // whole point of preserving the id across a renumber; the alternative moves
  // authored curriculum and saved progress under a live cohort. Callers that
  // care about the disagreement ask `weekAddressDrift()` below, which reports
  // it rather than refusing the write.
  return n;
}

/** One plan slot whose stable id and derived id disagree. */
export type WeekAddressDrift = {
  weekNumber: number;
  /** What the plan says the document is. Admin surfaces open this. */
  planWeekId: string;
  /** `weekDocId(weekNumber)`. Every member-facing surface opens this. */
  canonicalWeekId: string;
};

/**
 * Every slot in `plan` where the two ways of naming a week point at different
 * documents.
 *
 * The two doctrines are both real. Admin surfaces address a week by the plan's
 * `weekId`; `/learn/{run}/weeks/{n}`, the week rail, the nudge, the task
 * mirror and the attendance grid all derive `weekDocId(weekNumber)`. They
 * agree on a plan that has only ever grown at the end, and diverge from the
 * first reorder or removal, silently, because both sides resolve a real
 * document, just not the same one.
 *
 * Reported, never thrown: on a live run the divergence is the lesser evil and
 * repointing it would move real people's saved work. It is only worth acting
 * on while the run is still a draft, which is what
 * `normaliseRunWeekIds()` and its route are for.
 */
export function weekAddressDrift(plan: WeekPlanEntry[]): WeekAddressDrift[] {
  const out: WeekAddressDrift[] = [];
  let taught = 0;
  for (const entry of plan) {
    if (entry.kind !== "week") continue;
    taught += 1;
    const canonicalWeekId = weekDocId(taught);
    if (entry.weekId !== canonicalWeekId) {
      out.push({ weekNumber: taught, planWeekId: entry.weekId, canonicalWeekId });
    }
  }
  return out;
}

/**
 * Create the `courseRuns/{runId}/weeks/{weekId}` doc if it isn't there yet, and
 * do nothing at all if it is. The week editor calls this on open: the week plan
 * mints slots (`weekId`s) long before anyone authors them, so the editor has to
 * be able to open a slot that has no document behind it.
 *
 * Every field is written in its empty-but-present state so the doc satisfies
 * the rules' shape checks from the first byte and every later `saveWeek()` is a
 * plain field update. `published: false` because a fresh week must never be
 * visible to a cohort before anyone has written it.
 *
 * Read-then-create rather than a transaction on purpose: the only losable race
 * is two editors opening the same brand-new slot within the same few
 * milliseconds, in which case the loser overwrites a document that is itself
 * still empty.
 */
export async function ensureWeekDoc(
  runId: string,
  weekId: string,
  weekNumber: number,
): Promise<void> {
  const n = assertWeekAddress(weekId, weekNumber);
  const db = getClientDb();
  const uid = actingUid();

  const ref = doc(db, "courseRuns", runId, "weeks", weekId);
  const existing = await getDoc(ref);
  if (existing.exists()) return;

  await setDoc(ref, {
    weekNumber: n,
    title: "",
    summary: "",
    guideBlocks: [] as Block[],
    materials: [] as Material[],
    exercises: [] as Exercise[],
    checklist: [] as ChecklistItem[],
    estimatedMinutes: null,
    published: false,
    updatedAt: serverTimestamp(),
    updatedByUid: uid,
  });
}

/**
 * Patch a week's authored content. Only the keys present are written, so the
 * autosave path can send one field without reading the rest of the document
 * back first.
 *
 * `id`, `updatedAt` and `updatedByUid` are ignored if passed: the first is the
 * address, not a field, and the last two are stamped here on every save so the
 * editor can show who touched a week last without trusting the client to say.
 * The doc must already exist (`ensureWeekDoc()`), which is what makes this an
 * `updateDoc` — a `setDoc` would silently resurrect a week an admin deleted.
 */
export async function saveWeek(
  runId: string,
  weekId: string,
  patch: Partial<CourseWeekDoc>,
): Promise<void> {
  const db = getClientDb();
  const out: Record<string, unknown> = {};

  if (patch.weekNumber !== undefined) {
    // The plan owns numbering (a week's position among the taught slots); this
    // is here so the editor can reconcile a doc whose number has drifted from
    // the plan, not so it can renumber the curriculum.
    out.weekNumber = Math.min(
      COURSE_FIELD_LIMITS.maxWeekPlanEntries,
      Math.max(1, Math.floor(patch.weekNumber) || 1),
    );
  }
  if (patch.title !== undefined) {
    out.title = capped(patch.title, COURSE_FIELD_LIMITS.weekTitle);
  }
  if (patch.summary !== undefined) {
    out.summary = capped(patch.summary, COURSE_FIELD_LIMITS.weekSummary);
  }
  if (patch.guideBlocks !== undefined) {
    out.guideBlocks = patch.guideBlocks.slice(0, COURSE_FIELD_LIMITS.maxGuideBlocks);
  }
  if (patch.materials !== undefined) {
    out.materials = patch.materials.slice(0, COURSE_FIELD_LIMITS.maxMaterials);
  }
  if (patch.exercises !== undefined) {
    out.exercises = patch.exercises.slice(0, COURSE_FIELD_LIMITS.maxExercises);
  }
  if (patch.checklist !== undefined) {
    out.checklist = patch.checklist.slice(0, COURSE_FIELD_LIMITS.maxChecklistItems);
  }
  if (patch.estimatedMinutes !== undefined) {
    out.estimatedMinutes = positiveIntOrNull(patch.estimatedMinutes);
  }
  if (patch.published !== undefined) out.published = patch.published === true;

  if (Object.keys(out).length === 0) return;
  out.updatedAt = serverTimestamp();
  out.updatedByUid = actingUid();
  await updateDoc(doc(db, "courseRuns", runId, "weeks", weekId), out);
}

/** What the clone-weeks route reports back. `created` counts overwrites too. */
export type CloneWeeksResult = { created: number; skipped: number };

/**
 * Copy another run's weeks into this one — the copy-forward path.
 *
 * There is deliberately no curriculum template collection: the most recent run
 * IS the master, so a new year starts by copying last year's weeks and editing
 * them in place. Route-backed because the copy spans two runs' subcollections
 * and has to preserve doc ids and every material / exercise / checklist id
 * (member progress rows are keyed on those ids, so an id-remapping copy would
 * quietly orphan everyone's history on a re-run).
 *
 * Idempotent: weeks that already exist here are skipped unless `overwrite`.
 */
export async function cloneWeeksFromRun(
  runId: string,
  fromRunId: string,
  overwrite: boolean,
): Promise<CloneWeeksResult> {
  const result = await postJson<Partial<CloneWeeksResult>>(
    `/api/courses/runs/${runId}/clone-weeks`,
    { fromRunId, overwrite },
    "Couldn't copy weeks from that run.",
  );
  return {
    created: typeof result.created === "number" ? result.created : 0,
    skipped: typeof result.skipped === "number" ? result.skipped : 0,
  };
}
