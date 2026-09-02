import "server-only";
import type { Firestore } from "firebase-admin/firestore";

/**
 * `config/courses` — the courses feature's runtime knobs, in the existing
 * server-only `config` collection alongside `config/taskEmails`.
 *
 * ADMIN SDK ONLY, both ways. The collection has no client read rule and now
 * carries an explicit `match /config/{doc} { allow read, write: if false; }`
 * block so the lockdown is visible in the rules file rather than inferred
 * from deny-by-default (the `pushSubscriptions` precedent). There is no admin
 * editor for this doc yet: it is set from the console, and every field has a
 * default that keeps the platform working when it is absent.
 *
 * MISSING MEANS DEFAULTS, never "feature off". The whole doc is optional and
 * so is every field in it — the `readTaskEmailConfig` rule, for the same
 * reason: a fresh Firestore project must behave like a working one, and a
 * mistyped key must degrade to the documented number rather than to zero.
 */

export const COURSE_CONFIG_PATH = {
  collection: "config",
  doc: "courses",
} as const;

export type CoursesConfig = {
  /**
   * How long after a session's end a register may go unmarked before the
   * follow-up job raises a task against the group's facilitator. Long enough
   * that an evening session marked the next morning is not chased.
   */
  unmarkedRegisterGraceHours: number;
  /**
   * The anonymous feedback form a member is offered when they drop out.
   * Empty = no link shown, which is a complete state: the drop-out still
   * works, it just asks for nothing.
   */
  dropOutFeedbackUrl: string;
  /**
   * How far ahead the unmarked-register scan looks for a group's next
   * session. Bounds the work per tick and stops a run whose dates were typed
   * a year out from being scanned week after week.
   */
  nextSessionMaxDays: number;
  /**
   * Wall-clock budget for one unmarked-register scan. The scan runs inside a
   * shared scheduler tick with a hard request ceiling above it, so it has to
   * be able to stop early and leave the rest for the next tick.
   */
  unmarkedScanBudgetMs: number;
  /**
   * Ceiling on follow-up tasks minted in one tick. A run with a broken
   * calendar can make every group look unmarked at once; a board buried under
   * a hundred identical tasks is not a warning, it is noise that gets muted.
   */
  maxFollowUpTasksPerTick: number;
};

export const DEFAULT_COURSES_CONFIG: CoursesConfig = Object.freeze({
  unmarkedRegisterGraceHours: 36,
  dropOutFeedbackUrl: "",
  nextSessionMaxDays: 14,
  unmarkedScanBudgetMs: 20000,
  maxFollowUpTasksPerTick: 25,
});

function positiveNumber(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return fallback;
  return v;
}

function positiveInt(v: unknown, fallback: number): number {
  const n = positiveNumber(v, fallback);
  return Math.floor(n);
}

export async function readCoursesConfig(db: Firestore): Promise<CoursesConfig> {
  const snap = await db
    .collection(COURSE_CONFIG_PATH.collection)
    .doc(COURSE_CONFIG_PATH.doc)
    .get();
  if (!snap.exists) return { ...DEFAULT_COURSES_CONFIG };
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  return {
    unmarkedRegisterGraceHours: positiveNumber(
      data.unmarkedRegisterGraceHours,
      DEFAULT_COURSES_CONFIG.unmarkedRegisterGraceHours,
    ),
    // Not URL-validated here. The value is admin-typed, is only ever rendered
    // as an href on a page the member reached by pressing "drop out", and a
    // typo shows a broken link rather than doing anything.
    dropOutFeedbackUrl:
      typeof data.dropOutFeedbackUrl === "string" ? data.dropOutFeedbackUrl : "",
    nextSessionMaxDays: positiveInt(
      data.nextSessionMaxDays,
      DEFAULT_COURSES_CONFIG.nextSessionMaxDays,
    ),
    unmarkedScanBudgetMs: positiveInt(
      data.unmarkedScanBudgetMs,
      DEFAULT_COURSES_CONFIG.unmarkedScanBudgetMs,
    ),
    maxFollowUpTasksPerTick: positiveInt(
      data.maxFollowUpTasksPerTick,
      DEFAULT_COURSES_CONFIG.maxFollowUpTasksPerTick,
    ),
  };
}
