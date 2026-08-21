import type { Subtask, TaskDoc } from "./tasks";
import { weekDocId, type ChecklistItem } from "./courses";

/**
 * Task mirroring — projecting a course week into a member's My Work board as
 * a `tasks/{id}` doc. One-way, lazy, and CRON-FREE (App Hosting has no
 * scheduler): the sync-tasks route runs on course-page/dashboard mount,
 * short-circuits on `enrolment.lastTaskSyncedWeek === anchorWeekNumber`, and
 * otherwise `.create()`s the task at a DETERMINISTIC id.
 *
 * Deterministic id + `.create()` IS the idempotency guarantee: two racing
 * mounts both target the same doc, the second gets ALREADY_EXISTS and moves
 * on. No transactions, no "does it exist" query, no duplicate tasks ever.
 *
 * The task uses the hooks pre-provisioned in tasks.ts: `source:
 * "fellowship-reminder"`, `kind: "fellowship-weekly"`, and `sourceRef:
 * {cohortId, weekNumber}` (populated here for the first time). The member is
 * creator AND sole completer, visibility is `assignees-only`, so it behaves
 * exactly like their personal quick-add tasks — including dismissal, via the
 * rules' fellowship-reminder delete branch.
 */

/**
 * Deterministic task id for the (run, week, member) mirror. The `course-wNN`
 * prefix keeps the tasks collection scannable in the console (slugId
 * convention: meaning first, uniqueness after). CONSTRUCT-ONLY — never parse;
 * the task's `sourceRef` carries {cohortId, weekNumber} as data.
 */
export function courseTaskId(runId: string, weekNumber: number, uid: string): string {
  return `course-${weekDocId(weekNumber)}__${runId}__${uid}`;
}

export type MirroredTaskArgs = {
  runId: string;
  weekNumber: number;
  /** The enrolled member — becomes creator, completer, and subtask assignee. */
  uid: string;
  /** Task title, e.g. "AI Safety Fundamentals — Week 3". */
  title: string;
  /** The week's plain-text summary (CourseWeekDoc.summary) — stays plain. */
  description: string;
  /** The week's checklist; only `mirrorToMyWork` items become subtasks. */
  checklist: ChecklistItem[];
  /**
   * Due instant — the week window's end at 23:59 Europe/London, computed by
   * the CALLER via the weekPlan helpers. Kept out of this helper so it stays
   * pure (no timezone maths, trivially unit-testable).
   */
  dueDate: Date | null;
  /** Creation instant; also pre-stamps `initialNotifyAt` (see below). */
  now: Date;
};

/** The `tasks/{id}` payload — everything but the id, ready for `.create()`. */
export type MirroredTaskPayload = Omit<TaskDoc, "id">;

/**
 * Build the mirrored task payload. Pure — no Firestore imports, no clock
 * reads — so the sync route stays a thin `.create()` wrapper and tests can
 * assert the exact payload.
 *
 * Load-bearing choices:
 *  - Subtask ids REUSE the checklist item ids: a re-created task (member
 *    dismissed it, admin re-synced) lines up with the same curriculum items.
 *  - `initialNotifyAt` is pre-stamped: the task is born "already notified",
 *    so the task-email machinery never emails about a mirror — the course's
 *    own week-nudge email owns that moment.
 *  - `visibility: "assignees-only"` + creator === completer === member keeps
 *    the mirror inside the member's personal lane; it never appears on the
 *    committee board.
 */
export function buildMirroredTask(args: MirroredTaskArgs): MirroredTaskPayload {
  const subtasks: Subtask[] = args.checklist
    .filter((item) => item.mirrorToMyWork)
    .map((item) => ({
      id: item.id,
      title: item.title,
      description: item.detail ?? "",
      dueDate: null,
      done: false,
      doneAt: null,
      doneByUid: null,
      assigneeUids: [args.uid],
      reviewerUids: [],
      blockedBy: [],
      approvedByReviewerUids: [],
      questionedByReviewerUids: [],
      rejectedByReviewerUids: [],
      blockId: null,
      sealState: "open",
      sealedAt: null,
      roleHint: null,
    }));
  return {
    title: args.title,
    description: args.description,
    source: "fellowship-reminder",
    kind: "fellowship-weekly",
    projectId: null,
    creatorUid: args.uid,
    completerUids: [args.uid],
    reviewerUids: [],
    status: "todo",
    priority: "normal",
    dueDate: args.dueDate,
    archived: false,
    visibility: "assignees-only",
    subtasks,
    blocks: [],
    blockConsents: {},
    subtaskStats: { done: 0, total: subtasks.length },
    attachmentCount: 0,
    commentCount: 0,
    tags: [],
    sourceRef: { cohortId: args.runId, weekNumber: args.weekNumber },
    sourceTemplateId: null,
    createdAt: args.now,
    updatedAt: args.now,
    completedAt: null,
    initialNotifyAt: args.now,
    pendingNotifyUids: [],
  };
}
