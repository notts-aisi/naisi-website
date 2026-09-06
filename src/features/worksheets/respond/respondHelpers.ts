/**
 * The pure part of the respond page: which page the recipient is on, what is
 * still outstanding on it, whether one answer is worth storing, which
 * questions the next autosave still owes the document, what a save failure
 * should say, and how long somebody has spent.
 *
 * SEPARATED FROM THE COMPONENT ON PURPOSE. Every function here is a decision
 * the page makes dozens of times a session (jump to the first page with a
 * problem, decide whether a cleared box means "delete the stored answer"), and
 * all of them are cheap to get subtly wrong in a way no rendering test would
 * notice: an off-by-one page index sends somebody to the page AFTER their
 * mistake, and a clear that writes an empty answer instead of removing the key
 * leaves a question counted as answered on the staff's progress bar. Living
 * here they are covered by tests/worksheet-respond-helpers.test.mjs without a
 * DOM.
 *
 * `pagesOf`, `computeProgress` and `validateSubmission` are NOT re-implemented
 * here: they are the shared model in `src/lib/firestore/worksheets.ts`, which
 * the submit route runs against the same items, and a second copy of any of
 * them is a second answer to a question the route has already settled.
 */
import {
  answerIsEmpty,
  questionsOf,
  type SubmissionProblem,
  type WorksheetAnswer,
  type WorksheetItem,
} from "@/lib/firestore/worksheets";

/**
 * Hold a page index inside the pages that exist.
 *
 * Called on every render rather than only on navigation, because the page
 * count can SHRINK under a recipient mid-session: staff may edit the
 * circulation's copy of the questions while somebody has it open, and a stored
 * index pointing past the end would render a page with a Next button and
 * nothing above it. An empty worksheet clamps to 0, which is the index the
 * caller's "nothing to answer" state uses.
 */
export function clampPageIndex(index: number, pageCount: number): number {
  if (!Number.isFinite(index)) return 0;
  const last = Math.max(0, pageCount - 1);
  return Math.min(Math.max(0, Math.floor(index)), last);
}

/**
 * The first page carrying any of these problems, or -1.
 *
 * PROBLEM ORDER IS NOT PAGE ORDER. `validateSubmission` walks the items in
 * document order, so its first problem is usually also the earliest page, but
 * a question moved by a mid-flight edit breaks that assumption. Scanning by
 * page and asking "does this page hold any problem" is the version that stays
 * true, and it is what the submit button needs: send the recipient to the
 * earliest screen they have to fix, not to whichever fault happened to be
 * listed first.
 */
export function firstPageWithProblem(
  pages: WorksheetItem[][],
  problems: SubmissionProblem[],
): number {
  if (problems.length === 0) return -1;
  const ids = new Set(problems.map((p) => p.questionId));
  for (let i = 0; i < pages.length; i += 1) {
    if (pages[i].some((item) => item.kind === "question" && ids.has(item.id))) return i;
  }
  return -1;
}

export type PageState = {
  answered: number;
  total: number;
  /** Required questions on this page with nothing in them yet. */
  requiredOutstanding: number;
};

/**
 * What one page looks like from the recipient's side.
 *
 * Deliberately NOT `computeProgress` over the page's items: that returns the
 * four numbers the response document stores, and the two must not be confused.
 * The stored progress is over the WHOLE worksheet and is what the staff read;
 * this is a per-page summary that never leaves the browser. A page with no
 * questions on it (a section and a heading, say) is complete by definition.
 */
export function pageState(
  page: WorksheetItem[],
  answers: Record<string, WorksheetAnswer>,
): PageState {
  let answered = 0;
  let requiredOutstanding = 0;
  const questions = questionsOf(page);
  for (const question of questions) {
    const answer = answers?.[question.id];
    const filled = answer !== undefined && answer !== null && !answerIsEmpty(answer);
    if (filled) answered += 1;
    else if (question.required) requiredOutstanding += 1;
  }
  return { answered, total: questions.length, requiredOutstanding };
}

/**
 * Does this answer belong in the document, or should its key be removed?
 *
 * The autosave writes one field per changed question, and a cleared box has to
 * DELETE the key rather than store `{ type: "text", text: "" }`. Both shapes
 * read back as unanswered through `answerIsEmpty`, so nothing would look wrong
 * on screen; what would be wrong is the document, which would carry a growing
 * set of empty answers that the CSV export prints as columns and the reviewer
 * reads as "they wrote something here and deleted it".
 */
export function shouldRemoveAnswer(answer: WorksheetAnswer | undefined | null): boolean {
  if (answer === undefined || answer === null) return true;
  return answerIsEmpty(answer);
}

/**
 * Take the questions the next write will carry OUT of the pending set, and put
 * them back when that write fails.
 *
 * ── WHY THE SET IS EMPTIED BEFORE THE WRITE, NOT AFTER IT ───────────────────
 * The autosave holds one set of "questions changed since the last successful
 * write" beside a debouncer whose value slot holds the newest answers map. A
 * write that clears the set AFTER its `await` loses an edit, and says it
 * saved:
 *
 *   1. the recipient types, the timer fires, the write goes out carrying q1;
 *   2. they carry on typing. The push re-adds q1 to the set and drops the
 *      newer map into the debouncer's slot;
 *   3. the first write resolves and deletes q1 from the set;
 *   4. the drain loop picks the newer map up, finds NOTHING pending, returns
 *      without writing, and the debouncer reports "saved".
 *
 * The newer text is then in no document and in no queue, so the Save button
 * drains an empty queue, the green tick appears, and a Submit right after it
 * freezes the response around the older answer. Claiming the ids first makes
 * step 2's re-add survive step 3, so step 4 writes it. A FAILED write puts its
 * claim back, which is the retry story the hook's comment describes: the set
 * is the record of what is not yet stored, and it must only shrink for a write
 * that actually landed.
 *
 * Two small functions rather than an inline `delete` loop so the order is
 * pinned by tests/worksheet-respond-helpers.test.mjs. Nothing about this is
 * visible on screen, which is exactly why it needs a test.
 */
export function claimPending(pending: Set<string>): string[] {
  const ids = Array.from(pending);
  for (const id of ids) pending.delete(id);
  return ids;
}

/** Put a failed write's questions back, without disturbing newer ones. */
export function restorePending(pending: Set<string>, ids: string[]): void {
  for (const id of ids) pending.add(id);
}

/**
 * An autosave failure, in words the recipient can act on.
 *
 * The raw text is a Firestore SDK string ("Missing or insufficient
 * permissions."), because every write in the answering path is client-direct;
 * there is no route here to supply a sentence of its own. Leading with that
 * string tells somebody who has just lost a paragraph nothing about what to do
 * with it, so the ACTION comes first and the raw message trails in brackets
 * for the two cases where it is the only clue anybody gets.
 */
export function saveErrorSentence(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "permission-denied") {
    // The response froze under them (submitted in another tab, or a reviewer
    // returned it) or their session expired. Reloading is the only thing that
    // resolves either, and it is safe to say so.
    return "Your last change is not stored: this worksheet is no longer taking changes from you. Copy anything you have just written somewhere safe, then reload the page to see where it stands.";
  }
  if (code === "unavailable" || code === "deadline-exceeded") {
    return "Your last change is not stored: the connection dropped. Keep this tab open, and press Save once you are back online.";
  }
  const detail =
    error instanceof Error && error.message ? error.message.trim() : "";
  const action =
    "Your last change is not stored. Copy it out somewhere safe, then press Save to try again.";
  return detail ? `${action} (${detail})` : action;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * `activity.activeMs` as a sentence.
 *
 * Rounded to whole minutes because the number is accumulated in 30-second
 * ticks while the tab is visible and the person has moved recently, so it is
 * an estimate by construction and printing "12 minutes 30 seconds" would claim
 * a precision it does not have. Anything under a minute says so rather than
 * rounding to "0 minutes", which reads as a bug.
 */
export function formatActiveTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE_MS) return "under a minute";
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.round((ms - hours * HOUR_MS) / MINUTE_MS);
  // Rounding can carry the minutes to 60 (an hour and 59.6 minutes), which
  // would print "1 hour 60 minutes".
  const carried = minutes === 60;
  const wholeHours = carried ? hours + 1 : hours;
  const restMinutes = carried ? 0 : minutes;
  const hourPart = wholeHours === 1 ? "1 hour" : `${wholeHours} hours`;
  const minutePart = restMinutes === 1 ? "1 minute" : `${restMinutes} minutes`;
  if (wholeHours === 0) return minutePart;
  if (restMinutes === 0) return hourPart;
  return `${hourPart} ${minutePart}`;
}
