import "server-only";

/**
 * WHO A TASK NOTIFICATION MAY REACH.
 *
 * ## The rule
 *
 * A task's roster is `completerUids ∪ reviewerUids`. That set, and nothing
 * else, is who the server will email or push about the task. Every recipient
 * of a task notification is therefore somebody a committee member deliberately
 * put on the task, which is a visible, audited act with its own board row.
 *
 * ## Why this is a module rather than two lines in a route
 *
 * Three of the five task send routes built their recipient list out of a uid
 * array that the CALLER had written, on a document the caller owned:
 *
 *  - `POST /api/tasks/[id]/notify` read `comment.mentions` straight off the
 *    comment. `firestore.rules` caps that array at twenty entries and
 *    constrains nothing about WHO is in it, because the comment's author is
 *    the one who writes it.
 *  - `POST /api/tasks/[id]/send-for-review` preferred the reviewer list on the
 *    named SUBTASK over the task's own, and `subtasks` sits in the narrow band
 *    any completer may write (and a personal task's creator may rewrite
 *    freely). Its comment said the caller-supplied filter "stops a malicious
 *    caller from emailing someone who isn't on the task at all"; the filter
 *    intersected the request against a set the request had also written.
 *  - `POST /api/tasks/[id]/send-review-outcome` added every signoff row's
 *    reviewers to the recipient set, off the same `subtasks` array, and read
 *    the caller's own authority to press the button out of it too.
 *
 * So the recipient list was the caller's to choose. Anybody who could reach
 * any task, including a `pending` account on a personal to-do it had just
 * created for itself, could name arbitrary uids and have the server deliver a
 * NAISI-branded email and a web push carrying their own subject line and body
 * to all of them, repeatedly. The `notify` leg was found by the API red team
 * on 8 September 2026; the two subtask legs were found on 9 September while
 * writing the guard for the class, and are worse, because `mentions` is capped
 * at twenty and a subtask array is capped at nothing.
 *
 * The product has always drawn these lists from the roster
 * (`CommentComposer.tsx` filters the mention pool to
 * `completerUids ∪ reviewerUids`, `expandMentionAll` resolves `@all` to the
 * same two arrays, `SubtaskDetailModal.tsx` offers the same pool to the
 * subtask pickers, and `taskMutations.ts` strips a uid out of every subtask
 * array when it leaves the task). This module is that rule stated once on the
 * server, where it is a gate rather than a dropdown: a client is a suggestion,
 * and a recipient list is a send.
 *
 * ## What it deliberately does NOT admit
 *
 * An admin, or an SU-recognised committee member who can see a
 * committee-visibility task without being on it, is not a recipient unless
 * they are on the roster. That matches every picker in the product exactly, so
 * nothing a person can do is refused here; and widening it to "everyone who
 * can READ this task" would put the recipient list back into a value the
 * caller writes, which is the shape being closed.
 *
 * The bound this leaves, said plainly: an SU-recognised committee member or an
 * admin can still add somebody to a task and then address them, because they
 * hold the roster and putting people on tasks is their job. What they can no
 * longer do is address somebody who is not on the task at all, invisibly, from
 * a comment or a subtask.
 */

function uidList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0);
}

/** The two arrays that decide who is on a task, as one set. */
export function taskRoster(task: {
  completerUids?: unknown;
  reviewerUids?: unknown;
}): Set<string> {
  return new Set([...uidList(task?.completerUids), ...uidList(task?.reviewerUids)]);
}

/**
 * The uids in `candidates` that are on the task, in the order they were
 * named, de-duplicated. Everything else is dropped SILENTLY: the caller gets
 * no per-uid answer back, so a refusal cannot be turned into a question about
 * which uids exist.
 */
export function onTaskRoster(
  candidates: unknown,
  task: { completerUids?: unknown; reviewerUids?: unknown },
): string[] {
  const roster = taskRoster(task);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const uid of uidList(candidates)) {
    if (!roster.has(uid) || seen.has(uid)) continue;
    seen.add(uid);
    out.push(uid);
  }
  return out;
}
