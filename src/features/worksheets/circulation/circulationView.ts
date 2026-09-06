/**
 * The pure display logic behind the circulation page: how a response's numbers
 * become a sentence, a percentage, a tone and a sort order.
 *
 * It is a separate module from the components for one reason. Every one of
 * these functions is a rule about what the sender is told, and the sender
 * makes decisions on it (who to chase, who has stalled, who never opened it).
 * A rule of that kind belongs somewhere it can be read on its own and asserted
 * against, which is `tests/worksheets-circulation-view.test.mjs`. Nothing here
 * touches React, Firestore or the DOM, and `now` is always a parameter rather
 * than a `new Date()` inside the function, so the relative-date branches are
 * testable instead of true-on-Tuesdays.
 */
import type { ChipTone } from "@/components/ui/Chip";
import {
  RESPONSE_STATES,
  RESPONSE_STATE_LABELS,
  type ResponseActivity,
  type ResponseDoc,
  type ResponseProgress,
  type ResponseState,
  type ReviewConfig,
} from "@/lib/firestore/circulations";

// ---------------------------------------------------------------------------
// Review toggles
// ---------------------------------------------------------------------------

/**
 * The four review switches, with the words the sender reads. The order is the
 * order they are decided in: what staff can write, then whether any of it goes
 * back, which is why "Return feedback to the recipient" is last and carries
 * the consequence note below.
 *
 * The scoring label spells out who can see a score because that is the whole
 * difference between it and feedback, and a switch that does not say so is one
 * somebody turns on believing they are grading in the open.
 */
export const REVIEW_TOGGLES: { key: keyof ReviewConfig; label: string }[] = [
  { key: "perQuestionFeedback", label: "Per-question feedback" },
  {
    key: "perQuestionScoring",
    label: "Per-question scoring (reviewers only, never shown to the recipient)",
  },
  { key: "overallFeedback", label: "Overall feedback" },
  { key: "returnToRecipient", label: "Return feedback to the recipient" },
];

/**
 * What happens when the last switch is off. Worth saying out loud: with no
 * return step the worksheet is finished the moment it arrives, so the task
 * goes green on submit rather than sitting in a review queue nobody empties,
 * and the recipient keeps their answers to read.
 */
export const RETURN_OFF_NOTE =
  "Their task goes green on submit and they keep read-only access to their answers.";

/** The enabled toggles, by name, for the read-only summary. */
export function reviewConfigSummary(config: ReviewConfig): string[] {
  return REVIEW_TOGGLES.filter((toggle) => config[toggle.key]).map((toggle) => toggle.label);
}

// ---------------------------------------------------------------------------
// Progress and state
// ---------------------------------------------------------------------------

/**
 * Whole percent answered, 0 when there is nothing to answer.
 *
 * A worksheet with no questions is a real state (it is what an author's draft
 * looks like before they add one), and dividing by its zero total would put
 * NaN into a progress bar and the word "NaN%" next to somebody's name.
 */
export function percentOf(progress: ResponseProgress): number {
  if (!progress || progress.total <= 0) return 0;
  return Math.round((progress.answered / progress.total) * 100);
}

/**
 * The state chip's text. `RESPONSE_STATE_LABELS` is the authority on the
 * words, so a renamed state renames here too; the percentage is appended only
 * while somebody is mid-way, because it is the only state where "how far" is a
 * question anybody is asking.
 */
export function responseStateLabel(response: ResponseDoc): string {
  const label = RESPONSE_STATE_LABELS[response.state];
  if (response.state !== "started") return label;
  return `${label}, ${percentOf(response.progress)}%`;
}

export function responseStateTone(state: ResponseState): ChipTone {
  switch (state) {
    case "not-opened":
      return "neutral";
    case "started":
      return "accent";
    case "submitted":
    case "reviewed":
      return "success";
  }
}

/**
 * The progress bar's tone, which deliberately does NOT match the chip's on the
 * two terminal states: a submitted bar and a reviewed bar are both full and
 * both green, and the chip beside them is what says which. Colouring them
 * apart would make "reviewed" look like a different amount of work done.
 */
export function progressTone(state: ResponseState): "neutral" | "accent" | "success" {
  switch (state) {
    case "not-opened":
      return "neutral";
    case "started":
      return "accent";
    case "submitted":
    case "reviewed":
      return "success";
  }
}

/**
 * "3 of 8 submitted". A REVIEWED response counts as submitted, because it was:
 * the number answers "how many have I got back", and a reviewer working
 * through the pile must not make that number fall.
 *
 * Derived from the responses actually on screen rather than from the
 * circulation's `submittedCount`, which the routes maintain and which is one
 * batched write behind at exactly the moment somebody is watching.
 */
export function submittedTally(responses: ResponseDoc[]): { submitted: number; total: number } {
  let submitted = 0;
  for (const response of responses) {
    if (response.state === "submitted" || response.state === "reviewed") submitted += 1;
  }
  return { submitted, total: responses.length };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Active time, in the units a person thinks in. Rounded to the minute and
 * never to a decimal: the underlying number is a 30-second sampler (see the
 * activity contract in `docs/worksheets.md`), so a figure like "12.4 min"
 * would claim a precision the measurement does not have.
 */
export function formatActiveTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE_MS) return "under a minute";
  if (ms < HOUR_MS) return `${Math.round(ms / MINUTE_MS)} min`;
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.round((ms - hours * HOUR_MS) / MINUTE_MS);
  // 59.7 minutes rounds to 60, which would print "1 h 60 min".
  if (minutes === 0 || minutes === 60) return `${minutes === 60 ? hours + 1 : hours} h`;
  return `${hours} h ${minutes} min`;
}

/**
 * "today", "yesterday", "4 days ago", or a short date past a week.
 *
 * Counted in CALENDAR days, from local midnight, not in 24-hour blocks. Eleven
 * at night and one in the morning are different days to the person reading
 * this even though they are two hours apart, and "1 day ago" for something
 * that happened last night reads as wrong.
 */
export function formatRelativeDay(date: Date, now: Date): string {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(date)) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/**
 * The one-line activity summary under a recipient's name.
 *
 * It is shown to the recipient too, on their own task and respond page, which
 * is the reason it stays this coarse: first open, page changes and active
 * minutes are what a sender chasing a deadline needs, and anything finer would
 * be surveillance somebody has to be told about.
 */
export function activityLineOf(activity: ResponseActivity, now: Date): string {
  if (!activity?.firstOpenedAt) return "Not opened yet";
  const opens = Math.max(0, Math.round(activity.pageOpens));
  return [
    `First opened ${formatRelativeDay(activity.firstOpenedAt, now)}`,
    `${opens} page open${opens === 1 ? "" : "s"}`,
    `${formatActiveTime(activity.activeMs)} active`,
  ].join(", ");
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type CirculationSortKey = "added" | "name" | "progress" | "state";

/**
 * The sort options, worded as what they put at the TOP rather than as a field
 * name. Progress and state both run least-done-first on purpose: the reason a
 * sender sorts this table is to find who has not finished, and a sort that
 * buries them under the people who are done answers the opposite question.
 */
export const CIRCULATION_SORT_OPTIONS: { value: CirculationSortKey; label: string }[] = [
  { value: "added", label: "Order added" },
  { value: "name", label: "Name" },
  { value: "progress", label: "Progress (least done first)" },
  { value: "state", label: "State (not opened first)" },
];

/**
 * Sort a copy of the rows. The input is already in `addedAt` order (the hook
 * puts it there), and every comparator returns 0 on a tie, so a stable sort
 * leaves ties in that order: two people at 40% keep the order they were added
 * in rather than swapping places on every snapshot.
 */
export function sortResponses(
  responses: ResponseDoc[],
  key: CirculationSortKey,
  nameOf: (uid: string) => string,
): ResponseDoc[] {
  const rows = [...responses];
  switch (key) {
    case "added":
      return rows;
    case "name":
      return rows.sort((a, b) =>
        nameOf(a.uid).localeCompare(nameOf(b.uid), "en-GB", { sensitivity: "base" }),
      );
    case "progress":
      return rows.sort((a, b) => percentOf(a.progress) - percentOf(b.progress));
    case "state":
      return rows.sort(
        (a, b) => RESPONSE_STATES.indexOf(a.state) - RESPONSE_STATES.indexOf(b.state),
      );
  }
}
