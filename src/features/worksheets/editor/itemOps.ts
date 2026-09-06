/**
 * The pure list operations behind `WorksheetEditor`.
 *
 * They live outside the component because the editor is CONTROLLED: it holds
 * no copy of `items` and every interaction is "take the array the parent owns,
 * return a new one". Written as functions of an array they are testable
 * without a DOM, which is what `tests/worksheet-editor-helpers.test.mjs` pins,
 * and the component is left with nothing but the wiring.
 *
 * Two rules run through all of them:
 *
 *  - NEVER MUTATE. Every function copies first. React compares by identity to
 *    decide what to re-render, and an in-place splice on the prop array is the
 *    class of bug where the data is right and the screen is a move behind.
 *  - IDS ARE IDENTITY. An item's id keys its answers, its drag handle and its
 *    validation message, so an operation either keeps an id deliberately
 *    (reorder, type change) or mints a fresh one deliberately (duplicate).
 *    There is no operation that copies an id by accident.
 */
import {
  emptyQuestion,
  newItemId,
  type WorksheetItem,
  type WorksheetItemProblem,
  type WorksheetQuestion,
  type WorksheetQuestionType,
} from "@/lib/firestore/worksheets";

/**
 * Swap one item with its neighbour. Out-of-range moves return the SAME array
 * reference rather than a copy, so the up arrow on the first row is a no-op
 * that does not re-render the list or dirty an autosave.
 */
export function moveItem(items: WorksheetItem[], index: number, direction: -1 | 1): WorksheetItem[] {
  const target = index + direction;
  if (index < 0 || index >= items.length) return items;
  if (target < 0 || target >= items.length) return items;
  const next = items.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * Move an item from one position to another, which is what a drag reports.
 *
 * NOT a swap: dragging row 1 to row 5 has to shuffle rows 2 to 5 up by one,
 * and swapping would instead put row 5 where row 1 was. The arrow buttons and
 * the drag handle therefore cannot share an implementation, even though for a
 * single-step move the two agree.
 */
export function reorderItems(
  items: WorksheetItem[],
  fromIndex: number,
  toIndex: number,
): WorksheetItem[] {
  if (fromIndex === toIndex) return items;
  if (fromIndex < 0 || fromIndex >= items.length) return items;
  if (toIndex < 0 || toIndex >= items.length) return items;
  const next = items.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * Insert one item after `afterIndex`, or at the end when that is null. The
 * add menu at the foot of the list passes null; the "+" between two rows
 * passes the index above it.
 */
export function insertItemAt(
  items: WorksheetItem[],
  item: WorksheetItem,
  afterIndex: number | null,
): WorksheetItem[] {
  const next = items.slice();
  const at = afterIndex == null ? next.length : Math.min(afterIndex + 1, next.length);
  next.splice(Math.max(at, 0), 0, item);
  return next;
}

export function removeItemAt(items: WorksheetItem[], index: number): WorksheetItem[] {
  if (index < 0 || index >= items.length) return items;
  const next = items.slice();
  next.splice(index, 1);
  return next;
}

/** The id prefix each kind of item is minted with, so a stray id reads by eye. */
function prefixFor(item: WorksheetItem): string {
  if (item.kind === "question") return "q";
  if (item.kind === "section") return "s";
  return "pb";
}

/**
 * Copy one item, with fresh ids all the way down.
 *
 * The OPTIONS get new ids too. Sharing an option id between two questions
 * would not break the library document, but a circulation copies these items
 * verbatim and answers are keyed by option id per question, so a shared id is
 * a trap set for whoever later writes an aggregate that groups by option.
 * `body` is shared by reference, which is safe because every block edit in
 * `BlockEditor` replaces the array rather than mutating it.
 */
export function duplicateItemAt(items: WorksheetItem[], index: number): WorksheetItem[] {
  if (index < 0 || index >= items.length) return items;
  const source = items[index];
  const copy: WorksheetItem =
    source.kind === "question"
      ? {
          ...source,
          id: newItemId(prefixFor(source)),
          ...(source.options
            ? { options: source.options.map((o) => ({ ...o, id: newItemId("o") })) }
            : {}),
        }
      : { ...source, id: newItemId(prefixFor(source)) };
  return insertItemAt(items, copy, index);
}

/**
 * Change a question's type, keeping what survives the change and resetting
 * what does not.
 *
 * Title, body and `required` are the author's WORDS: they are about the thing
 * being asked, not about how it is answered, so a short-text question that
 * becomes a rating keeps every one of them. Options, limits, scales and
 * allowances are about the answer shape and cannot be carried across, so they
 * come from `emptyQuestion` rather than being patched: that is the one place
 * that knows a poll needs two blank options and a rating needs a scale, and
 * hand-rolling the reset here would be a second copy of it that drifts.
 *
 * The ID IS KEPT. It is the item's identity in the list, in the drag handle
 * and in every validation message, and minting a new one would scroll the
 * author's row out from under them for a change they made in place.
 */
export function changeQuestionType(
  question: WorksheetQuestion,
  type: WorksheetQuestionType,
): WorksheetQuestion {
  if (question.type === type) return question;
  return {
    ...emptyQuestion(type),
    id: question.id,
    title: question.title,
    body: question.body,
    required: question.required,
  };
}

/**
 * Group the validator's output by item id, so a row can render its own
 * messages without every row scanning the whole list.
 *
 * One item can carry several problems (a blank title AND too few options), so
 * the value is an array.
 *
 * THE KEYS ARE NOT RECONCILED AGAINST THE LIST, and today they do not need to
 * be: `validateWorksheetItems` draws every `itemId` out of the same array the
 * editor renders, so every key names a row and `WorksheetEditor` renders all
 * of them by looking each row up by its own id. This stays a plain grouping
 * rather than a reconciliation on purpose. If a validator ever reports against
 * something that is not a row, the decision about where that message goes
 * belongs to the caller that draws the screen, and a filter here would have
 * dropped it before the caller ever saw it.
 */
export function problemsByItem(problems: WorksheetItemProblem[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const problem of problems) {
    const existing = map.get(problem.itemId);
    if (existing) existing.push(problem.message);
    else map.set(problem.itemId, [problem.message]);
  }
  return map;
}
