import "server-only";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  CIRCULATIONS_COLLECTION,
  RESPONSES_SUBCOLLECTION,
  type CirculationDoc,
} from "@/lib/firestore/circulations";
import { slugId } from "@/lib/firestore/slugId";
import { TASK_FIELD_LIMITS } from "@/lib/firestore/tasks";
import { computeProgress } from "@/lib/firestore/worksheets";

/**
 * Putting a worksheet in front of one more person: the response document they
 * answer and the task that tells them it exists, written together.
 *
 * ── WHY THE TWO DOCUMENTS ARE ONE OPERATION ─────────────────────────────────
 * A response with no task is work nobody is told about; a task with no response
 * is a card that opens nothing (the respond page and the worksheet panel both
 * key on the response document, not on the task's label). So they are written
 * in ONE batch per chunk of recipients and either both land or neither does.
 * `firestore.rules` closes `create` on both collections from the client side,
 * which is what makes this the only writer and this file the whole story.
 *
 * ── IDEMPOTENCY, AND WHY IT IS THE RESPONSE ID THAT CARRIES IT ──────────────
 * A response's doc id IS the recipient's uid, so "has this person already been
 * sent this" is an addressed read rather than a query, and adding the same
 * person twice is structurally impossible: they are read first and reported as
 * `skipped`, and the write itself uses `create` so a racing second request
 * fails its batch rather than overwriting answers somebody had already typed.
 * The re-read at the top of each attempt is what turns that race into a skip.
 *
 * ── COUNTED AFTERWARDS, ON PURPOSE ──────────────────────────────────────────
 * `recipientCount` is bumped once, after the batches, by the number actually
 * added. Incrementing inside each batch would be correct too but would make the
 * circulation document a contended write on every chunk of a hundred-person
 * send; and a counter that is wrong by a batch for a few hundred milliseconds
 * is a progress bar, not a permission.
 */

/**
 * Firestore's own ceiling on a batched write is 500 operations. `docs/
 * worksheets.md` fixes the working number at 200 documents, which is two per
 * recipient and therefore a hundred people: the same hundred
 * `CIRCULATION_LIMITS.maxRecipientsPerRequest` caps a request at, so the
 * ordinary send is one batch and the chunking below is the safety net rather
 * than the usual path.
 */
export const MINT_BATCH_DOCUMENTS = 200;
const RECIPIENTS_PER_BATCH = MINT_BATCH_DOCUMENTS / 2;

/**
 * How many times a chunk is retried with fresh task ids before the error is
 * allowed out. `slugId` appends eight base36 characters, so two tasks minted
 * from the same title collide about once in 2.8 x 10^12; three attempts is
 * generous rather than load-bearing, and the loop exists because the OTHER
 * cause of an ALREADY_EXISTS here is real and worth surviving: a second request
 * adding the same person at the same moment.
 */
const MINT_ATTEMPTS = 3;

/**
 * ALREADY_EXISTS out of `create()`. The Admin SDK surfaces the raw gRPC status
 * (6); the string forms are accepted too because the emulator and some
 * transport paths report the canonical name instead. Exported because the
 * circulate route needs the same test for its own `create()` at a `slugId`,
 * and a second copy of this three-line predicate is how one of them ends up
 * swallowing a genuine failure.
 */
export function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}

export type MintArgs = {
  /** The circulation as stored: its title, items, reviewers and due date. */
  circulation: CirculationDoc;
  circulationId: string;
  /** Who to add. De-duplicated here; callers need not. */
  recipientUids: string[];
  /** Who is doing the adding, stamped on each response as `addedByUid`. */
  actorUid: string;
  /**
   * One instant for the whole send, stamped as every new response's `addedAt`
   * and `updatedAt`.
   *
   * A caller-supplied Date rather than `serverTimestamp()` because "added in
   * the same send" has to be a fact the circulation page can group on: a
   * sentinel resolves per BATCH commit, so a two-chunk send would file the
   * first fifty people seconds apart from the next fifty and the recipient
   * table would interleave one send with the next. The task's own timestamps
   * stay server-side (see below), where nothing groups on them.
   */
  now: Date;
};

export type MintResult = {
  /** Uids that got a response document and a task on this call. */
  added: string[];
  /** Uids that already held a response document, so nothing was written. */
  skipped: string[];
  /**
   * The task minted for each added uid. Returned rather than kept private so
   * the caller's notification can deep-link a push at the person's own task
   * instead of guessing; nothing else reads it.
   */
  taskIds: Record<string, string>;
};

/** De-duplicate while keeping the caller's order, dropping empty entries. */
function uniqueUids(uids: string[]): string[] {
  const out: string[] = [];
  for (const uid of uids) {
    if (typeof uid !== "string" || !uid) continue;
    if (out.includes(uid)) continue;
    out.push(uid);
  }
  return out;
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The task payload for one recipient.
 *
 * NO SUBTASKS, NO BLOCKS, and that is the decision in `docs/worksheets.md`:
 * a worksheet task has one completer and its Done is decided by the worksheet's
 * own lifecycle, so the per-block lock-in ritual and reviewer signoff would be
 * ceremony with no participants. The task is a pointer and a nudge; the work
 * lives on the response document its `artefact` names.
 *
 * `initialNotifyAt` is PRE-STAMPED, the same trick the course week mirror uses:
 * the task is born "already notified", so the task system's own membership mail
 * never fires about it and the circulation's `assigned` switch is the only
 * thing that can put a message in front of a recipient.
 */
function buildTask(args: {
  circulation: CirculationDoc;
  circulationId: string;
  uid: string;
}): Record<string, unknown> {
  const { circulation, circulationId, uid } = args;
  return {
    // Clamped even though the circulate route already caps the title at the
    // same 120: a task the board would refuse to re-save is a second-class
    // card, and the two limits are free to drift apart later.
    title: circulation.title.slice(0, TASK_FIELD_LIMITS.title),
    // Deliberately empty. The description would be a stale copy of the
    // worksheet's, and the recipient reads the real thing on the respond page.
    description: "",
    source: "worksheet",
    kind: "worksheet",
    projectId: null,
    // The sender, not the actor adding this batch: the task's creator is who
    // put the worksheet in front of people, which is what the card should say
    // however many people were added afterwards and by whom.
    creatorUid: circulation.senderUid,
    completerUids: [uid],
    reviewerUids: circulation.reviewerUids.slice(0, TASK_FIELD_LIMITS.maxReviewers),
    status: "todo",
    priority: "normal",
    dueDate: circulation.dueDate,
    archived: false,
    // Never `committee`: one recipient must not see that another was sent the
    // same worksheet, and the board must not fill with a card per recipient.
    visibility: "assignees-only",
    subtasks: [],
    blocks: [],
    blockConsents: {},
    subtaskStats: { done: 0, total: 0 },
    attachmentCount: 0,
    commentCount: 0,
    tags: [],
    sourceRef: null,
    sourceTemplateId: null,
    artefact: { kind: "worksheet-response", circulationId },
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    completedAt: null,
    initialNotifyAt: FieldValue.serverTimestamp(),
    pendingNotifyUids: [],
  };
}

/**
 * The response payload for one recipient.
 *
 * Every field the reader normalises is written, including the nulls. The
 * recipient's autosave may only touch `answers, progress, activity, state,
 * updatedAt` (the rules pin the rest), so a field absent here is a field
 * nothing can ever add: `taskId` in particular is what the respond page walks
 * back to the board with, and `returned` is where staff feedback lands.
 */
function buildResponse(args: {
  circulation: CirculationDoc;
  circulationId: string;
  uid: string;
  taskId: string;
  actorUid: string;
  now: Date;
}): Record<string, unknown> {
  const { circulation, circulationId, uid, taskId, actorUid, now } = args;
  return {
    uid,
    circulationId,
    taskId,
    state: "not-opened",
    answers: {},
    // Derived rather than zeroed: `total` and `required` are properties of the
    // questions, not of the answering, so the progress bar reads "0 of 7"
    // before the recipient has opened it rather than "0 of 0".
    progress: computeProgress(circulation.items, {}),
    activity: { firstOpenedAt: null, pageOpens: 0, activeMs: 0, lastActiveAt: null },
    submittedAt: null,
    reviewedAt: null,
    returned: null,
    unfrozenAt: null,
    unfrozenByUid: null,
    addedAt: now,
    addedByUid: actorUid,
    updatedAt: now,
  };
}

/**
 * One batch's worth of recipients, retried with fresh task ids on a collision.
 *
 * The existence read is INSIDE the retry loop on purpose: the two things that
 * can fail a `create` here are a task-id collision (fixed by re-minting the id)
 * and a concurrent request having just added the same person (fixed only by
 * re-reading and dropping them into `skipped`). One loop handles both because
 * the top of each attempt re-establishes both facts.
 */
async function mintChunk(
  db: Firestore,
  chunk: string[],
  args: MintArgs,
): Promise<MintResult> {
  const { circulation, circulationId, actorUid, now } = args;
  const responses = db
    .collection(CIRCULATIONS_COLLECTION)
    .doc(circulationId)
    .collection(RESPONSES_SUBCOLLECTION);
  const tasks = db.collection("tasks");

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MINT_ATTEMPTS; attempt += 1) {
    const snaps = await db.getAll(...chunk.map((uid) => responses.doc(uid)));
    const fresh: string[] = [];
    const skipped: string[] = [];
    chunk.forEach((uid, index) => {
      if (snaps[index]?.exists) skipped.push(uid);
      else fresh.push(uid);
    });
    if (fresh.length === 0) return { added: [], skipped, taskIds: {} };

    const batch = db.batch();
    const taskIds: Record<string, string> = {};
    for (const uid of fresh) {
      const taskId = slugId(circulation.title);
      taskIds[uid] = taskId;
      batch.create(tasks.doc(taskId), buildTask({ circulation, circulationId, uid }));
      batch.create(
        responses.doc(uid),
        buildResponse({ circulation, circulationId, uid, taskId, actorUid, now }),
      );
    }
    try {
      await batch.commit();
      return { added: fresh, skipped, taskIds };
    } catch (err) {
      // Anything that is not a collision is a real failure and must not be
      // retried into a duplicate send.
      if (!isAlreadyExists(err)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Add people to a circulation: one response document and one task each.
 *
 * Returns who was written and who was already there. It does NOT send anything:
 * the caller decides whether the circulation's `assigned` switch is on, because
 * the same mint runs at create time and at add-recipients time and only the
 * caller knows which people are new to a message.
 */
export async function mintRecipients(
  db: Firestore,
  args: MintArgs,
): Promise<MintResult> {
  const requested = uniqueUids(args.recipientUids);
  const added: string[] = [];
  const skipped: string[] = [];
  const taskIds: Record<string, string> = {};
  for (const chunk of chunked(requested, RECIPIENTS_PER_BATCH)) {
    const outcome = await mintChunk(db, chunk, args);
    added.push(...outcome.added);
    skipped.push(...outcome.skipped);
    Object.assign(taskIds, outcome.taskIds);
  }

  if (added.length > 0) {
    await db
      .collection(CIRCULATIONS_COLLECTION)
      .doc(args.circulationId)
      .update({
        recipientCount: FieldValue.increment(added.length),
        updatedAt: FieldValue.serverTimestamp(),
      });
  }

  return { added, skipped, taskIds };
}
