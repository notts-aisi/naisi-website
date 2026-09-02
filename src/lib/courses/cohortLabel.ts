/**
 * THE ONE COHORT FORMATTER.
 *
 * V3 replaces the free-text `courseRuns.label` on every learner-facing and
 * public surface with a STRUCTURED cohort: a term, a calendar year, and a
 * number distinguishing concurrent cohorts of the same course in that term.
 * `cohortLabel()` is the only function that turns that triple into words.
 *
 * Why one formatter and not a template literal at each call site: the same
 * cohort is named on the public course page, the run home breadcrumb, the
 * certificate, the decision email and the calendar invite. Two spellings of
 * "Autumn 2026, cohort 2" is a cohort that looks like two cohorts to the
 * person reading both, and there is no type error to catch it.
 *
 * `run.label` SURVIVES on the doc, deliberately: admin lists still show it
 * and nothing migrates. It just never reaches a visitor again, which is a
 * property this module can only keep if callers reach for it instead of the
 * raw field.
 *
 * ## The cohort NUMBER is always shown. Decision, with the reason.
 *
 * The alternative on the table was to hide "cohort 1" when a term has only
 * one cohort. It is rejected: this function is handed ONE run and cannot see
 * how many sibling cohorts exist without a second read it has no business
 * doing, and a label that silently gains ", cohort 1" the day a second cohort
 * is created would make an already-sent decision email, an issued
 * certificate and the live page disagree about the name of the same thing.
 * A stable name that occasionally says "cohort 1" to a single cohort is the
 * cheaper wrong. Authors who dislike it have the real fix available: give the
 * course one cohort per term and let the term carry the identity.
 */

/** Which part of the academic year a cohort runs in. */
export type CohortTerm = "autumn" | "spring" | "summer";

export const COHORT_TERMS: CohortTerm[] = ["autumn", "spring", "summer"];

export const COHORT_TERM_LABELS: Record<CohortTerm, string> = {
  autumn: "Autumn",
  spring: "Spring",
  summer: "Summer",
};

/**
 * The structured cohort stored on `courseRuns.cohort`.
 *
 * `year` is the CALENDAR year the term starts in (Autumn 2026 and Spring 2027
 * are the two halves of academic year 2026/27), which is what a reader
 * expects to see beside a term name. The run's `academicYear` string is
 * unchanged and still carries the "2026/27" form for the membership tag.
 */
export type RunCohort = {
  term: CohortTerm;
  year: number;
  /** 1-based. Distinguishes concurrent cohorts of the same course in a term. */
  number: number;
};

/**
 * Bounds. These are cost ceilings and typo catchers, not a calendar: a run
 * created for 1998 or for 2312 is a slipped keystroke, and a cohort number in
 * the hundreds is not a cohort.
 */
export const COHORT_LIMITS = {
  minYear: 2000,
  maxYear: 2100,
  minNumber: 1,
  maxNumber: 99,
} as const;

/**
 * Read a stored cohort, or `null` when the run has none.
 *
 * ABSENT, NEVER NULL ON THE WIRE. The `null` here is a read-side convenience;
 * the write path must delete the key rather than store a null, because
 * `firestore.rules` caps the field with
 * `request.resource.data.get('cohort', {}).keys().hasOnly([...])` and `.keys()`
 * on a stored null raises, which denies the write. That is the same trap
 * already recorded for `submissionExerciseRef` and `templateId` on the run
 * doc, and it wedges every later non-admin edit of the run rather than
 * failing at the write that caused it.
 */
export function normalizeCohort(raw: unknown): RunCohort | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (!COHORT_TERMS.includes(c.term as CohortTerm)) return null;
  const year = c.year;
  const number = c.number;
  if (typeof year !== "number" || !Number.isFinite(year)) return null;
  if (typeof number !== "number" || !Number.isFinite(number)) return null;
  const y = Math.floor(year);
  const n = Math.floor(number);
  if (y < COHORT_LIMITS.minYear || y > COHORT_LIMITS.maxYear) return null;
  if (n < COHORT_LIMITS.minNumber || n > COHORT_LIMITS.maxNumber) return null;
  return { term: c.term as CohortTerm, year: y, number: n };
}

/**
 * Validate a cohort a client asked to store, returning an error string or
 * `null`. Shares its bounds with `normalizeCohort` so the message a route
 * gives back and the shape a read produces cannot drift apart.
 */
export function cohortError(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "Cohort must be a term, a year and a cohort number.";
  }
  const c = raw as Record<string, unknown>;
  if (!COHORT_TERMS.includes(c.term as CohortTerm)) {
    return "Cohort term must be autumn, spring or summer.";
  }
  if (typeof c.year !== "number" || !Number.isFinite(c.year)) {
    return "Cohort year must be a number.";
  }
  const y = Math.floor(c.year);
  if (y < COHORT_LIMITS.minYear || y > COHORT_LIMITS.maxYear) {
    return `Cohort year must be between ${COHORT_LIMITS.minYear} and ${COHORT_LIMITS.maxYear}.`;
  }
  if (typeof c.number !== "number" || !Number.isFinite(c.number)) {
    return "Cohort number must be a number.";
  }
  const n = Math.floor(c.number);
  if (n < COHORT_LIMITS.minNumber || n > COHORT_LIMITS.maxNumber) {
    return `Cohort number must be between ${COHORT_LIMITS.minNumber} and ${COHORT_LIMITS.maxNumber}.`;
  }
  return null;
}

/**
 * "Autumn 2026, cohort 2".
 *
 * Returns "" when the run carries no cohort, which every pre-V3 run does.
 * The empty string is deliberate and is NOT a licence to fall back to
 * `run.label`: a surface with no cohort shows its own copy (or nothing) rather
 * than leaking the free-text admin label the structured cohort exists to
 * replace. Callers branch on the empty string.
 */
export function cohortLabel(run: { cohort?: RunCohort | null } | null): string {
  const cohort = run?.cohort ?? null;
  if (!cohort) return "";
  return `${COHORT_TERM_LABELS[cohort.term]} ${cohort.year}, cohort ${cohort.number}`;
}

/** The term and year alone: "Autumn 2026". For places already inside a cohort. */
export function cohortTermLabel(run: { cohort?: RunCohort | null } | null): string {
  const cohort = run?.cohort ?? null;
  if (!cohort) return "";
  return `${COHORT_TERM_LABELS[cohort.term]} ${cohort.year}`;
}
