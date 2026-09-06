import "server-only";
import type { Firestore } from "firebase-admin/firestore";

/**
 * `config/courses`: the courses feature's runtime knobs, in the existing
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
 * so is every field in it, following the `readTaskEmailConfig` rule, for
 * the same reason: a fresh Firestore project must behave like a working
 * one, and a mistyped key must degrade to the documented number rather
 * than to zero.
 */

export const COURSE_CONFIG_PATH = {
  collection: "config",
  doc: "courses",
} as const;

export type CoursesConfig = {
  /**
   * How long after a session's end a register may go unmarked before the
   * follow-up job raises a committee task about it, assigned to the admins so
   * one of them can chase the group's facilitator. Long enough that an evening
   * session marked the next morning is not chased.
   */
  unmarkedRegisterGraceHours: number;
  /**
   * The anonymous feedback form a member is offered when they drop out.
   * Empty = no link shown, which is a complete state: the drop-out still
   * works, it just asks for nothing.
   *
   * ALWAYS `http://` or `https://` or empty; see `readCoursesConfig`.
   */
  dropOutFeedbackUrl: string;
  /**
   * The weekly feedback form the attendance push links to, resolved into the
   * nudge email's `{feedbackUrl}` token.
   *
   * Empty = the paragraph carrying the token is dropped from the email
   * whole, which is the renderer's existing degradation rule and a complete
   * state: the reminder still goes out, it just asks for nothing. That is
   * why this can ship before the survey machinery that will own the real
   * link exists.
   *
   * ALWAYS `http://` or `https://` or empty; see `readCoursesConfig`.
   */
  weeklyFeedbackUrl: string;
  /**
   * How far ahead a scan may look for a group's next session, bounding the
   * work a run whose dates were typed a year out can generate.
   *
   * NOTHING READS IT TODAY. The unmarked-register job it was reserved for
   * ended up scanning BACKWARDS over a 24-hour band behind the grace rather
   * than forwards from now, and a band bounds the work on its own: a session
   * dated a year out is simply not in it. The field is kept because it is
   * already in the contract and a forward-looking job (the break-return
   * notice) is the obvious next reader, but it is honest about being unused
   * rather than quietly implying a limit that is not being applied.
   */
  nextSessionMaxDays: number;
  /**
   * Wall-clock budget for one unmarked-register scan. The scan runs inside a
   * shared scheduler tick with a hard request ceiling above it, so it has to
   * be able to stop early and leave the rest for the next tick.
   *
   * The default is well under the 28s the tick gives its whole job list, and
   * it is meant to SHRINK as jobs are added: one job that can spend most of
   * the list's budget is one that starves every job registered after it.
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
  weeklyFeedbackUrl: "",
  nextSessionMaxDays: 14,
  unmarkedScanBudgetMs: 12000,
  maxFollowUpTasksPerTick: 25,
});

/**
 * The stored feedback link, or "" when it is not one this app will render.
 *
 * A CONFIG DOC IS NOT A TRUSTED SOURCE OF HREFS. It is Admin-SDK-only today,
 * but the value ends up in an `href` on a page a member is looking at, and
 * `javascript:` and `data:` URLs in an href are script execution in the
 * member's session. Anchoring on `^https?://` is what makes "rendered
 * verbatim" safe to say, and it costs nothing: a real feedback form is a
 * web page. Anything else degrades to "" and the drop-out simply asks for
 * nothing, which is already a complete state.
 */
function externalUrlOrEmpty(v: unknown): string {
  if (typeof v !== "string") return "";
  const trimmed = v.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : "";
}

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
    // Scheme-checked, not merely type-checked: this one is rendered as an
    // href. See `externalUrlOrEmpty`.
    dropOutFeedbackUrl: externalUrlOrEmpty(data.dropOutFeedbackUrl),
    // Same treatment, and for a sharper reason: this one is substituted into
    // an email that reaches a whole cohort, where a bad href cannot be fixed
    // after the fact.
    weeklyFeedbackUrl: externalUrlOrEmpty(data.weeklyFeedbackUrl),
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
