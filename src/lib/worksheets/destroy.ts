import "server-only";
import { FieldValue, type Firestore, type Query } from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";
import {
  CIRCULATIONS_COLLECTION,
  RESPONSES_SUBCOLLECTION,
  REVIEWS_SUBCOLLECTION,
  type CirculationDoc,
} from "@/lib/firestore/circulations";
import { DATA_EXPORTS_COLLECTION } from "@/lib/firestore/dataExports";
import { SCHEDULER_MARKERS_COLLECTION } from "@/lib/firestore/schedulerMarkers";
import { ownedStoragePaths } from "@/lib/firestore/taskAttachments";
import { WORKSHEETS_COLLECTION } from "@/lib/firestore/worksheets";
import {
  accumulateDestroyAudit,
  claimDestroyAuditPass,
  completeDestroyAudit,
  openDestroyAudit,
  readDestroyAuditTotals,
  releaseDestroyAuditPass,
} from "@/lib/firestore/destroyAudit";

/**
 * DESTROY, for worksheets and circulations. The shape is
 * `src/lib/firestore/courseDeletion.ts`'s, deliberately and almost line for
 * line: audit row FIRST, live manifest counts, budgeted resumable pages, a
 * drained-guard that throws rather than looping, and blockers as sentences a
 * person can act on. A fourth deletion protocol with its own habits would be
 * a fourth thing to learn before anybody could trust it.
 *
 * ── WHAT THE TWO OPERATIONS ARE ─────────────────────────────────────────────
 *
 * DELETING A LIBRARY WORKSHEET is small and is not in this file's cascade
 * sense at all: a worksheet is a document plus a folder of question images,
 * and nothing hangs off it. What is sent hangs off a CIRCULATION, which
 * carries its own copy of the questions. So the worksheet route (`DELETE
 * /api/worksheets/[worksheetId]`) needs only the blocker below and the two
 * deletes, and it takes them from here so the sentence and the storage prefix
 * live beside the circulation's. ONE THREAD DOES RUN BETWEEN THEM: a
 * circulation's copied items point at the WORKSHEET's image folder, so the
 * delete keeps that folder whenever any circulation of the worksheet still
 * exists (see `deleteWorksheetDocument`, which is where the argument is).
 *
 * DESTROYING A CIRCULATION is the real cascade: every recipient's answers,
 * the staff reviews of them, the task on each recipient's board with its
 * comments, activity and attachments, every uploaded answer image, the copy's
 * own question images and the reminder markers. It is ADMIN ONLY by the
 * owner's decision of 7 September 2026 (never the sender), which is enforced
 * at the route.
 *
 * ── WHAT SURVIVES, AND WHY THAT IS NOT AN OVERSIGHT ─────────────────────────
 *
 * `emailSends` rows are the append-only record of what NAISI put in somebody's
 * inbox, and `dataExports` rows the append-only record of who took a
 * spreadsheet of it off the platform. Destroying the thing a message was about
 * does not unsend the message or un-download the file, so both are COUNTED on
 * the manifest and never deleted, which is the line every other destroy in this
 * codebase draws.
 *
 * ── RESUMABILITY ────────────────────────────────────────────────────────────
 *
 * Each invocation spends a fixed document budget and returns `complete: false`
 * when it runs out; the SAME call repeated resumes. There is no cursor to
 * persist, because every stage drains delete-as-you-read: the page it just
 * removed stops matching its query, so the next query's first page IS the next
 * unprocessed page. The circulation document is deleted LAST, so while it
 * exists a resumed pass can still find everything, including, on the document
 * itself, the id of the audit row to keep accumulating into.
 *
 * ── ONE PASS AT A TIME ──────────────────────────────────────────────────────
 *
 * Two invocations overlapping on one audit row would both increment it over
 * the same pages, and the running total the operator is reading would stop
 * being true. So a pass CLAIMS the audit row (`claimDestroyAuditPass`) before
 * it drains anything, and a second invocation arriving inside that window is
 * refused with `DestroyPassInFlightError` (409) rather than allowed to double
 * count. The claim lives in the shared audit module rather than here, so the
 * circulation and the admission round contend the same way; see its comments
 * for the window a killed process leaves behind.
 *
 * ── THE DRAINED-GUARD THROWS ────────────────────────────────────────────────
 *
 * A delete that reports success without removing rows would otherwise loop
 * while "making progress" on paper, inflating the audit counts over documents
 * that are still there. Two guards, both fatal: a page whose first document id
 * repeats after a committed delete, and a full-pass ceiling. A throw surfaces
 * as a 500 and leaves the marker and the open audit row in place for a retry;
 * a silent stop would report a clean destroy over surviving member work.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Rows per page for the leaf drains. `courseDeletion` uses the same number. */
const DESTROY_PAGE_SIZE = 250;

/**
 * Documents one invocation may remove before returning `complete: false`.
 * A circulation is at most a few hundred recipients, so a normal destroy
 * finishes in one pass; a pathological one can never pin a request for
 * minutes.
 */
const DESTROY_DOC_BUDGET = 500;

/**
 * Tasks page small: each one costs a subcollection sweep (`recursiveDelete`)
 * and a Storage round trip on top of its own document, so a page of these is
 * far heavier than a page of leaf rows.
 */
const TASK_PAGE_SIZE = 25;

/**
 * Full-pass ceiling. Every stage drains in pass 1 in the normal case and pass
 * 2 is the empty verify pass; more than a handful means rows are being
 * recreated as fast as they are deleted, and the honest response is a throw.
 */
const MAX_PASSES = 5;

/** The two Storage folders a circulation owns. Prefixes, always trailing "/". */
export function circulationUploadPrefix(circulationId: string): string {
  return `worksheet-uploads/${circulationId}/`;
}

export function questionImagePrefix(ownerId: string): string {
  return `worksheet-images/${ownerId}/`;
}

/**
 * The `tasks.source` a circulation's recipient cards carry, and the ONLY value
 * this cascade will delete.
 *
 * IT IS A SECURITY FILTER, not a tidier query. `artefact.circulationId` is the
 * pointer this sweep is really about, and `firestore.rules` does not pin
 * `artefact` on the committee create lane (see the long note on `TaskArtefact`
 * in `src/lib/firestore/tasks.ts`), so a committee member can stamp a
 * circulation id onto a task of their own. Filtering on the source the mint
 * actually writes narrows what a forged pointer can reach; the residual case
 * is a task its own author both created and aimed, which they could delete
 * themselves anyway. Pinning `artefact` beside `sourceRef` in the rules is the
 * real fix and it belongs in the rules file, not here.
 */
const WORKSHEET_TASK_SOURCE = "worksheet";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Everything a circulation destroy touches, counted LIVE at request time.
 * Keys are the manifest's count vocabulary and the audit row's `deleted` keys,
 * so one word means one thing from the dialog to the record.
 *
 * `dataExportRows` and `emailSendRows` are RETAINED (see the header). They are
 * on the manifest anyway, under the house rule that a collection a destroy
 * touches is named in the dialog: a retained collection left off the list
 * reads as "this does not exist" rather than as "this survives".
 */
export type CirculationDestroyCounts = {
  responses: number;
  reviews: number;
  /** One per recipient, each destroyed with its comments, activity and files. */
  tasks: number;
  /**
   * Answer images under `worksheet-uploads/{id}/`. NULL means the bucket could
   * not be listed, which is emphatically not the same fact as 0: see
   * `countStorageFolder`, and `circulationDestroyBlockers`, which refuses a
   * destroy whose image scope is unknown rather than letting a zero stand in
   * for it.
   */
  uploadedImages: number | null;
  /** The copy's own question and option images under `worksheet-images/{id}/`. Null as above. */
  questionImages: number | null;
  schedulerMarkers: number;
  /** Counted, never deleted. */
  dataExportRows: number;
  /** Counted, never deleted. */
  emailSendRows: number;
};

export type DestroyActor = {
  actorUid: string;
  /** Display name, never an email: the audit row is PII-light on purpose. */
  actorName: string;
};

export type CirculationDestroyResult = {
  auditId: string;
  /**
   * The ACCUMULATED totals for this destroy: the audit row's own `deleted`
   * map read back after this pass's increments landed, not just this pass's
   * page. The client renders it as the running total and a resume can begin in
   * a different tab from the one that started the cascade, so anything less
   * than the server stating the whole total leaves it reporting a fraction.
   */
  deleted: Record<string, number>;
  /** False = the page budget ran out; repeat the SAME call to resume. */
  complete: boolean;
  /** True when this call resumed a destroy an earlier one began. */
  resumed: boolean;
};

/**
 * The destroy marker as stored on a circulation document. Read through this
 * rather than poking at raw fields, so every server surface agrees what
 * mid-destroy means. Both halves are needed HERE: `destroying` with no audit id
 * names no row to accumulate into, so this reader treats it as no destroy at
 * all and the next fresh pass stamps both fields properly.
 *
 * `normalizeCirculation` reads the same field more loosely (`destroying == true`
 * and nothing else), and the disagreement is deliberate rather than a drift. The
 * two readers are answering different questions. The pages ask "should I stop
 * offering to edit this", where the safe answer to a half-written marker is yes.
 * The cascade asks "is there an audit row I must keep accumulating into", where
 * the safe answer to the same document is no, because inventing a row would
 * detach the totals from the destroy that is really running. Only a hand-edited
 * document can produce the state, and both answers are the right way round for
 * it.
 */
export type CirculationDestroyMarker = {
  destroying: boolean;
  auditId: string;
};

export function readCirculationDestroyMarker(
  raw: Record<string, unknown> | undefined,
): CirculationDestroyMarker {
  const auditId = typeof raw?.destroyAuditId === "string" ? raw.destroyAuditId : "";
  return { destroying: raw?.destroying === true && auditId.length > 0, auditId };
}

/**
 * Thrown when a destroy is refused outright. Routes map it to 409 with the
 * sentences intact. A refusal happens only on a FRESH destroy: a resume never
 * re-evaluates blockers, because the decision was made already and half the
 * data is gone, and re-blocking would wedge an interrupted cascade forever.
 */
export class DestroyBlockedError extends Error {
  readonly blockers: string[];
  constructor(blockers: string[]) {
    super(blockers[0] ?? "This destroy is blocked.");
    this.name = "DestroyBlockedError";
    this.blockers = blockers;
  }
}

/*
 * The other refusal, `DestroyPassInFlightError`, is thrown by
 * `claimDestroyAuditPass` in the shared audit module and is not redefined
 * here: one class means one `instanceof` branch in every destroy route, and
 * two classes of the same name would silently stop matching.
 */

// ---------------------------------------------------------------------------
// Budget + drain primitives
// ---------------------------------------------------------------------------

type Budget = { remaining: number };

type DrainResult = { deleted: number; drained: boolean };

/** Accumulate one page's work into the audit row as soon as it has landed. */
type PageSink = (key: string, n: number) => Promise<void>;

async function countAgg(query: Query): Promise<number> {
  return (await query.count().get()).data().count;
}

/**
 * Drain one collection query with delete-as-you-read pagination. No cursor:
 * deleting the page makes the next query's first page the next unprocessed
 * page, which is the property resumability rides on.
 *
 * The first-document-id guard is the per-stage half of the drained-guard. If a
 * committed batch delete leaves the same document at the head of the next
 * page, deletes are not taking effect, and continuing would burn budget while
 * the audit row inflated over rows that still exist, so it THROWS.
 */
async function drainQuery(
  db: Firestore,
  key: string,
  buildQuery: () => Query,
  budget: Budget,
  sink: PageSink,
): Promise<DrainResult> {
  let deleted = 0;
  let prevFirstId: string | null = null;
  while (budget.remaining > 0) {
    const limit = Math.min(DESTROY_PAGE_SIZE, budget.remaining);
    const snap = await buildQuery().limit(limit).get();
    if (snap.empty) return { deleted, drained: true };

    const firstId = snap.docs[0].id;
    if (firstId === prevFirstId) {
      throw new Error(
        `worksheetDestroy: ${key} page did not shrink after a committed delete, ` +
          "aborting rather than looping (a silent stop would report progress over rows that are still there)",
      );
    }
    prevFirstId = firstId;

    const batch = db.batch();
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();
    deleted += snap.size;
    budget.remaining -= snap.size;
    // The audit row is updated per PAGE rather than per pass, so a process
    // killed mid-cascade still leaves an honest record of what went.
    await sink(key, snap.size);

    // Fewer rows than asked for = the query has no more matches.
    if (snap.size < limit) return { deleted, drained: true };
  }
  return { deleted, drained: false };
}

/**
 * Drain the recipients' task cards: `tasks` where `source == "worksheet"` AND
 * `artefact.circulationId == <id>`, both halves of what the mint stamps rather
 * than just the pointer (see WORKSHEET_TASK_SOURCE for why the first half is
 * a security filter).
 *
 * INDEX NOTE: two equality filters, one of them on a map subfield. Map
 * subfields are automatically single-field indexed like top-level fields and
 * Firestore merges the two, so no composite index is needed and none was
 * added to firestore.indexes.json.
 *
 * A parent-document delete does NOT delete subcollections, and a worksheet
 * task can carry comments, an activity log and attachments, so each task goes
 * through `db.recursiveDelete` (the BulkWriter-backed path `POST
 * /api/tasks/[id]/delete` uses) with the attachment Storage paths enumerated
 * FIRST, because after the documents are gone nothing names the blobs. That
 * route holds the enumeration inline rather than exporting a helper, so the
 * two steps are repeated here from it: `ownedStoragePaths` (which is the
 * shared half, and the half that matters, because it refuses a path outside
 * the task's own folder) plus a best-effort delete of each blob. Storage
 * failures are logged and never fatal: an orphaned blob is strictly better
 * than a phantom document, and a Storage blip must not wedge the cascade.
 *
 * Budget is charged one per TASK rather than per subcollection row: the
 * manifest counts tasks, and a worksheet task's sub-rows are few.
 */
async function drainRecipientTasks(
  db: Firestore,
  storage: Storage | null,
  circulationId: string,
  budget: Budget,
  sink: PageSink,
): Promise<DrainResult> {
  let deleted = 0;
  let prevFirstId: string | null = null;
  while (budget.remaining > 0) {
    const limit = Math.min(TASK_PAGE_SIZE, budget.remaining);
    const snap = await recipientTaskQuery(db, circulationId).limit(limit).get();
    if (snap.empty) return { deleted, drained: true };

    const firstId = snap.docs[0].id;
    if (firstId === prevFirstId) {
      throw new Error(
        "worksheetDestroy: tasks page did not shrink after recursiveDelete, aborting rather than looping",
      );
    }
    prevFirstId = firstId;

    for (const doc of snap.docs) {
      let storagePaths: string[] = [];
      try {
        const attachments = await doc.ref.collection("attachments").get();
        storagePaths = ownedStoragePaths(
          doc.id,
          attachments.docs.map((d) => d.data().storagePath),
        );
      } catch (err) {
        console.error(
          "[worksheetDestroy] attachment enumeration failed (blobs may be orphaned):",
          doc.id,
          err,
        );
      }

      await db.recursiveDelete(doc.ref);
      deleted += 1;
      budget.remaining -= 1;
      await sink("tasks", 1);

      if (storage && storagePaths.length > 0) {
        const bucket = storage.bucket();
        await Promise.all(
          storagePaths.map(async (path) => {
            try {
              await bucket.file(path).delete({ ignoreNotFound: true });
            } catch (err) {
              console.warn(
                `[worksheetDestroy] storage delete failed for ${path} (best-effort):`,
                err,
              );
            }
          }),
        );
      }
    }

    if (snap.size < limit) return { deleted, drained: true };
  }
  return { deleted, drained: false };
}

/** The recipient-task predicate, written once so the manifest cannot drift. */
function recipientTaskQuery(db: Firestore, circulationId: string): Query {
  return db
    .collection("tasks")
    .where("source", "==", WORKSHEET_TASK_SOURCE)
    .where("artefact.circulationId", "==", circulationId);
}

/**
 * Empty one Storage folder.
 *
 * `deleteFiles({ prefix })` pages internally, so this is one call rather than
 * a drain loop, and the count is read first so the audit row can say how many
 * images went. Both are charged against the document budget even though
 * neither is a document: an answer folder with two thousand images in it is
 * real work, and letting it ride free would put it in the same pass as
 * everything else.
 *
 * A Storage failure THROWS here, unlike the per-task attachment cleanup above,
 * and the difference is what the blob is. An attachment blob is a file on a
 * card that is going anyway; these two folders are the recipients' uploaded
 * answers and the questions' own images, which are the content this destroy
 * exists to remove. Reporting a clean destroy over a folder of somebody's
 * photographs would be the one lie this module must not tell, so the pass
 * fails, the marker and the open audit row survive, and the resume tries
 * again.
 */
async function drainStoragePrefix(
  storage: Storage | null,
  key: string,
  prefix: string,
  budget: Budget,
  sink: PageSink,
): Promise<DrainResult> {
  if (!storage) {
    // No bucket configured (local runs, a misconfigured backend). Say so
    // loudly rather than counting zero: the files are still there.
    console.warn(`[worksheetDestroy] no Storage bucket, skipping ${prefix}`);
    return { deleted: 0, drained: true };
  }
  if (budget.remaining <= 0) return { deleted: 0, drained: false };

  const bucket = storage.bucket();
  const [files] = await bucket.getFiles({ prefix });
  if (files.length === 0) return { deleted: 0, drained: true };

  await bucket.deleteFiles({ prefix });
  // Charged, but never past zero. The folder is emptied in one call whatever
  // its size, so a folder bigger than the budget would otherwise leave
  // `remaining` deeply negative, and every later stage in this pass would read
  // that as "out of budget" and hand the operator a resume pass that has
  // nothing left to do. Clamping costs the same one extra pass at worst and
  // never more.
  budget.remaining = Math.max(0, budget.remaining - files.length);
  await sink(key, files.length);
  return { deleted: files.length, drained: true };
}

// ---------------------------------------------------------------------------
// Manifest counts + blockers
// ---------------------------------------------------------------------------

/**
 * Live counts of everything a circulation destroy would touch, read at request
 * time with aggregate queries so the dialog shows what dies NOW rather than
 * what a stale snapshot said. Every filter is a single equality (or an
 * equality pair Firestore merges), so no composite index is needed.
 *
 * The Storage numbers are LISTINGS rather than counts, because a bucket has no
 * aggregate: one `getFiles` per folder, which is the same call the cascade
 * makes before it empties them.
 */
export async function countCirculationDestroyTargets(
  db: Firestore,
  storage: Storage | null,
  circulation: Pick<CirculationDoc, "id">,
): Promise<CirculationDestroyCounts> {
  const circulationId = circulation.id;
  const circulationRef = db.collection(CIRCULATIONS_COLLECTION).doc(circulationId);

  const [
    responses,
    reviews,
    tasks,
    schedulerMarkers,
    dataExportRows,
    emailSendRows,
    uploadedImages,
    questionImages,
  ] = await Promise.all([
    countAgg(circulationRef.collection(RESPONSES_SUBCOLLECTION)),
    countAgg(circulationRef.collection(REVIEWS_SUBCOLLECTION)),
    // The SAME predicate the drain deletes on: a manifest counted on a wider
    // filter would promise to destroy rows the cascade rightly leaves alone.
    countAgg(recipientTaskQuery(db, circulationId)),
    // `wsremind__` rows carry `circulationId` as a field as well as inside
    // their document id (the id is construct-only, never parsed), so this is
    // the same single-equality shape as every leaf above.
    countAgg(
      db
        .collection(SCHEDULER_MARKERS_COLLECTION)
        .where("circulationId", "==", circulationId),
    ),
    countAgg(
      db
        .collection(DATA_EXPORTS_COLLECTION)
        .where("scope.circulationId", "==", circulationId),
    ),
    // `notify.ts` logs every worksheet message with the circulation id as its
    // `referenceId`, so this is "how much of the delivery log mentions this
    // circulation", a number that is KEPT rather than one that dies.
    countAgg(db.collection("emailSends").where("referenceId", "==", circulationId)),
    countStorageFolder(storage, circulationUploadPrefix(circulationId)),
    countStorageFolder(storage, questionImagePrefix(circulationId)),
  ]);

  return {
    responses,
    reviews,
    tasks,
    uploadedImages,
    questionImages,
    schedulerMarkers,
    dataExportRows,
    emailSendRows,
  };
}

/**
 * How many objects sit under one prefix, or NULL when the bucket could not be
 * asked.
 *
 * NULL IS NOT ZERO, and this is the one number in the manifest where the
 * difference is worth a branch. "0 uploaded answer images" and "the bucket did
 * not answer" render identically if a failure is reported as a count, and the
 * manifest is the last thing an admin reads before typing a title they cannot
 * untype: they would authorise a destroy believing nobody had uploaded
 * anything, over a folder of somebody's photographs. Over warning an admin
 * costs care, under warning costs data, so the failure is carried out of here
 * as its own value and `circulationDestroyBlockers` turns it into a refusal
 * with a sentence.
 *
 * The whole manifest is NOT failed for it: the other counts are still the
 * argument for the decision, and a listing that comes back next minute costs
 * the admin one retry. No bucket configured at all is a different fact and
 * reads as null too, for the same reason: nothing was counted.
 */
async function countStorageFolder(
  storage: Storage | null,
  prefix: string,
): Promise<number | null> {
  if (!storage) return null;
  try {
    const [files] = await storage.bucket().getFiles({ prefix });
    return files.length;
  } catch (err) {
    console.error("[worksheetDestroy] could not list", prefix, err);
    return null;
  }
}

/**
 * The refuse-outright conditions for a circulation destroy: NONE ABOUT THE
 * CIRCULATION ITSELF, and that is a decision rather than an omission.
 *
 * A run destroy refuses while a cohort is live, because a run has a lifecycle
 * an admin can move it along and destroying a running one would take work
 * people are in the middle of. A circulation has no such state worth
 * protecting: an OPEN one is exactly the case an admin destroying a test send
 * has in front of them, and the cascade closes it in its opening write anyway,
 * so a "close it first" blocker would be a step the destroy performs itself
 * one line later. The safeguards are the ones the owner named on 7 September
 * 2026: admin only, a live manifest, and a byte-equal typed confirmation.
 *
 * The one refusal that exists is not a blocker at all: a pass already running
 * (`DestroyPassInFlightError`, 409). It is not returned here because it is not
 * a state of the circulation, it is a state of the request, it clears itself
 * within the shared claim's lease window, and the dialog answers it with
 * Resume rather than with "this cannot be destroyed yet".
 *
 * WHAT IT DOES REFUSE is a manifest that cannot state its own scope. A Storage
 * folder whose listing failed arrives as null (see `countStorageFolder`), and a
 * null there is not a small gap: those two folders are the recipients' uploaded
 * answers and the pictures in the questions, so an admin reading a manifest
 * with one missing is being asked to authorise the deletion of files nobody has
 * counted. It is refused with a sentence and clears itself on a retry, which is
 * the same posture the dialog takes when the manifest will not load at all
 * ("a destroy whose scope is unknown is not one anybody should be pressing"),
 * and it is the posture the cascade takes too: `drainStoragePrefix` throws
 * rather than reporting a clean destroy over a folder it could not empty, so
 * starting a cascade while Storage is unhappy buys a half-destroyed
 * circulation and nothing else.
 *
 * Takes the two image counts rather than reading anything itself, so the
 * manifest route hands over the numbers it already has and the cascade can
 * re-check with two listings instead of a whole manifest.
 */
export function circulationDestroyBlockers(
  counts: Pick<CirculationDestroyCounts, "uploadedImages" | "questionImages">,
): string[] {
  const unreadable: string[] = [];
  if (counts.uploadedImages === null) unreadable.push("the answer images recipients uploaded");
  if (counts.questionImages === null) unreadable.push("the images in the questions");
  if (unreadable.length === 0) return [];
  return [
    `Storage could not be read just now, so this manifest cannot say how many of ${unreadable.join(" or ")} a destroy would remove. ` +
      "Nothing is destroyed until it can be counted: try again in a moment, and if it keeps failing the file store is the thing to look at.",
  ];
}

// ---------------------------------------------------------------------------
// The library worksheet
// ---------------------------------------------------------------------------

/**
 * The one thing that stops a worksheet being deleted: a circulation of it that
 * is still open.
 *
 * CLOSED CIRCULATIONS DO NOT BLOCK. A circulation is its own document with its
 * own copy of the questions, its own responses and its own tasks, and the
 * delete leaves every one of those alone. An OPEN one is a live ask sitting on
 * people's boards, and deleting the document its Circulate button came from
 * while people are still answering is a decision to make in the other order:
 * close it, then delete.
 *
 * A closed circulation does, however, keep the worksheet's IMAGES alive: see
 * `countWorksheetCirculations` and `deleteWorksheetDocument`, which is where
 * that thread is handled rather than turned into a second blocker.
 *
 * The sentence names the number, because "close them first" without a count
 * sends the author hunting through a list to find out how big the job is.
 */
export async function worksheetDeleteBlockers(
  db: Firestore,
  worksheetId: string,
): Promise<string[]> {
  const open = await countAgg(
    db
      .collection(CIRCULATIONS_COLLECTION)
      .where("worksheetId", "==", worksheetId)
      .where("status", "==", "open"),
  );
  if (open === 0) return [];
  return [
    `${open} circulation${open === 1 ? " of this worksheet is" : "s of this worksheet are"} still open. ` +
      `Close ${open === 1 ? "it" : "them"} first: people are answering ${open === 1 ? "it" : "them"} right now, and closing takes the cards off their boards.`,
  ];
}

/** Circulations of one worksheet, whatever their status. Single equality. */
async function countWorksheetCirculations(
  db: Firestore,
  worksheetId: string,
): Promise<number> {
  return countAgg(
    db.collection(CIRCULATIONS_COLLECTION).where("worksheetId", "==", worksheetId),
  );
}

export type WorksheetDeleteResult = {
  /** Question images removed from `worksheet-images/{worksheetId}/`. */
  imagesDeleted: number;
  /**
   * Question images LEFT IN PLACE because a circulation of this worksheet
   * still shows them. Zero when the folder was swept.
   */
  imagesKept: number;
  /** Circulations of this worksheet at the moment it was deleted. */
  circulations: number;
  /** Present when the document went but its images could not be removed. */
  warning?: string;
};

/**
 * Delete one library worksheet: its question images, then the document.
 *
 * IMAGES FIRST, DOCUMENT LAST, the events-delete ordering: a failure part-way
 * leaves the worksheet visible and the delete repeatable, rather than a folder
 * of images nothing names. The Storage half is best-effort, because a blob
 * nobody can reach is a smaller problem than a worksheet that refuses to go.
 *
 * THE PREFIX IS DERIVED FROM THE ID, never read off the document. A stored
 * path would be a client-written string aimed at whatever folder it liked,
 * which is the mistake the task attachment routes made once already.
 *
 * ── THE FOLDER IS KEPT WHEN ANY CIRCULATION OF THIS WORKSHEET EXISTS ────────
 *
 * This is the one place where deleting a library worksheet CAN reach something
 * already sent, and the reason is that a circulation copies the worksheet's
 * `items` verbatim: an `imageUrl` in that copy points into
 * `worksheet-images/{worksheetId}/` until somebody re-uploads that picture on
 * the circulation's own copy. Sweeping the folder therefore blanks the pictures
 * inside every circulation ever made from this worksheet, closed ones included,
 * which are exactly the archived records the committee keeps. A destroy that
 * quietly reached into other documents would break the promise the rest of this
 * module is built on, so it does not: if a single circulation of this worksheet
 * exists, the images stay and the result says how many and why.
 *
 * The residue is disk: a deleted worksheet whose circulations are later
 * destroyed leaves its folder behind, because the circulation destroy only
 * sweeps `worksheet-images/{circulationId}/`. That is an orphan-scan job of the
 * kind `docs/worksheets.md` already records for uploads, and it is the right
 * way round: an orphaned blob costs pennies, a blank image in a record of what
 * somebody was asked cannot be recovered at all.
 */
export async function deleteWorksheetDocument(
  db: Firestore,
  storage: Storage | null,
  worksheetId: string,
): Promise<WorksheetDeleteResult> {
  const circulations = await countWorksheetCirculations(db, worksheetId);
  const prefix = questionImagePrefix(worksheetId);

  let imagesDeleted = 0;
  let imagesKept = 0;
  let warning: string | undefined;

  if (storage) {
    try {
      const [files] = await storage.bucket().getFiles({ prefix });
      if (circulations > 0) {
        // Counted and left alone. The number is worth having: it is what the
        // route reports and what a later orphan scan would be looking for.
        imagesKept = files.length;
      } else {
        await storage.bucket().deleteFiles({ prefix });
        imagesDeleted = files.length;
      }
    } catch (err) {
      console.error("[worksheetDestroy] image cleanup failed (best-effort):", worksheetId, err);
      warning = "The worksheet was deleted but its question images could not be removed.";
    }
  }

  await db.collection(WORKSHEETS_COLLECTION).doc(worksheetId).delete();
  return { imagesDeleted, imagesKept, circulations, ...(warning ? { warning } : {}) };
}

// ---------------------------------------------------------------------------
// The circulation cascade
// ---------------------------------------------------------------------------

/**
 * Begin (or resume) a destroy.
 *
 * A fresh destroy is blocker-checked first (nothing has been written at that
 * point, so a refusal really does leave the circulation exactly as it was).
 * Then the audit row is opened, BEFORE anything can die, so an open row with
 * `completedAt: null` is durable evidence of an interrupted destroy. Then one
 * transaction stamps the marker on the circulation, and the pass is claimed on
 * the row itself.
 *
 * WHY THE MARKER AND THE CLAIM ARE SEPARATE WRITES. The claim lives on the
 * audit row (`claimDestroyAuditPass`, shared with the round destroy) and the
 * marker lives on the circulation, so they are two documents and there is a
 * gap between them. The gap is safe because the marker is the thing being
 * raced for: exactly one caller can stamp it, and everybody else takes the
 * resume path, where the claim is what refuses them. A caller that stamps the
 * marker and then dies before claiming leaves a resumable destroy with no
 * claim, which is precisely the state a resume expects to find.
 *
 * THE LOSER OF THE RACE CLOSES ITS OWN ROW. `openDestroyAudit` is not
 * transactional, so two admins pressing Destroy in the same instant both open
 * one. Only the winner's row is ever accumulated into, so the loser completes
 * its row rather than leaving a permanent "an interrupted destroy of this
 * exists" over a circulation nothing touched, and is then refused by the
 * winner's claim, which is the truth: a pass is running, it just is not
 * theirs.
 */
async function beginCirculationDestroy(
  db: Firestore,
  storage: Storage | null,
  circulation: CirculationDoc,
  actor: DestroyActor,
): Promise<{ auditId: string; resumed: boolean }> {
  const ref = db.collection(CIRCULATIONS_COLLECTION).doc(circulation.id);

  const preSnap = await ref.get();
  if (!preSnap.exists) {
    throw new Error(
      `worksheetDestroy: circulation ${circulation.id} vanished before destroy began`,
    );
  }

  // ---- Resume: the marker names the row, so claim that one in place -------
  const preMarker = readCirculationDestroyMarker(preSnap.data() ?? {});
  if (preMarker.destroying) {
    await claimDestroyAuditPass(db, preMarker.auditId);
    return { auditId: preMarker.auditId, resumed: true };
  }

  // ---- Fresh: blockers, then the audit row, then the marker ---------------
  // Blockers gate a FRESH destroy only (see DestroyBlockedError for why a
  // resume must never re-block), and they are checked HERE rather than in the
  // route so no request can skip them. The only one a circulation has is a
  // Storage folder that would not list: the cascade would throw when it reached
  // that folder anyway, but by then the answers would be gone and an honest
  // refusal would have arrived as a crash. Two listings, which is exactly what
  // step 4 is about to do. TOCTOU between here and the marker is accepted, as
  // it is on the run: both ends are the same admin action.
  const [uploadedImages, questionImages] = await Promise.all([
    countStorageFolder(storage, circulationUploadPrefix(circulation.id)),
    countStorageFolder(storage, questionImagePrefix(circulation.id)),
  ]);
  const imageBlockers = circulationDestroyBlockers({ uploadedImages, questionImages });
  if (imageBlockers.length > 0) throw new DestroyBlockedError(imageBlockers);

  const auditId = await openDestroyAudit(db, {
    kind: "circulation",
    targetId: circulation.id,
    label: circulation.title,
    actorUid: actor.actorUid,
    actorName: actor.actorName,
  });

  let stamped: { auditId: string; resumed: boolean };
  try {
    stamped = await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      const marker = readCirculationDestroyMarker(snap.data() ?? {});
      if (marker.destroying) {
        // Somebody stamped it in the milliseconds since the read above. Take
        // THEIR row: a second row accumulating the same pages is exactly what
        // the claim exists to prevent.
        return { auditId: marker.auditId, resumed: true };
      }
      txn.update(ref, {
        // The marker and the read-only flip land TOGETHER, before anything is
        // deleted: from here on every listen sees `destroying: true` and a
        // closed circulation, so the respond page stops taking answers and the
        // circulation page says what is happening rather than rendering a list
        // whose rows vanish under the reader.
        destroying: true,
        destroyAuditId: auditId,
        status: "closed",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { auditId, resumed: false };
    });
  } catch (err) {
    await closeOrphanAudit(db, auditId);
    throw err;
  }

  // The row this call opened is only used if this call won the stamp.
  if (stamped.auditId !== auditId) await closeOrphanAudit(db, auditId);
  await claimDestroyAuditPass(db, stamped.auditId, { first: !stamped.resumed });
  return stamped;
}

/** Best-effort: a row nothing accumulated into must not read as interrupted. */
async function closeOrphanAudit(db: Firestore, auditId: string): Promise<void> {
  try {
    await completeDestroyAudit(db, auditId);
  } catch (err) {
    console.error("[worksheetDestroy] could not close an orphaned audit row:", auditId, err);
  }
}

/**
 * Destroy one circulation. Admin only (enforced at the route). Resumable: the
 * same call with the same body carries on.
 *
 * ORDER OF OPERATIONS, each step where it is for a reason:
 *
 *  0. The blockers (fresh destroys only), then the audit row and the marker
 *     (see beginCirculationDestroy). From this point an open row exists for
 *     anything that dies, and the circulation is closed and flagged, so the
 *     recipient's own surfaces refuse to write into it.
 *  1. REVIEWS, then RESPONSES. Reviews first because a review is staff writing
 *     ABOUT a response: with the response gone first, a crash between the two
 *     would leave notes and scores about somebody whose answers no longer
 *     exist, which is the one leftover here that is still personal data.
 *  2. TASKS, each through `recursiveDelete` with its attachment blobs. After
 *     the responses, because a task is the recipient's way IN to the response
 *     and a card pointing at nothing is the state to spend the least time in.
 *  3. SCHEDULER MARKERS. They carry no member work, but a `wsremind__` row
 *     outliving its circulation is not inert: it is a dedupe record, and a
 *     stale one can suppress a real send later.
 *  4. The two STORAGE FOLDERS: the recipients' uploaded answers, then the
 *     copy's own question images. After every document that names them, so a
 *     resume never has documents pointing at files that have gone.
 *  5. The CIRCULATION DOCUMENT last, with the audit row's completion. While it
 *     exists a resumed pass can find everything; deleting it is the write that
 *     makes the destroy final.
 *
 * The loop runs FULL PASSES until a pass deletes nothing, and the mandatory
 * zero-delete pass is the verification rather than a formality. It is NOT
 * backed by a closed write gate: `firestore.rules` deliberately does not test
 * the parent's status when a recipient updates
 * `circulations/{id}/responses/{uid}` (its own long comment says why: a rule
 * that read the parent would cost a document read on every autosave), so a
 * recipient with the respond page open can still autosave for as long as their
 * row exists. What makes that harmless is the shape of the write rather than a
 * gate: it is an `update`, so it can only touch a document that is still there,
 * and the pass that deleted the row has already moved past it. An autosave
 * landing between two pages is deleted by the next one, and the empty pass is
 * what proves it happened. Step 0 does close the circulation, which stops the
 * recipient's own page offering to submit; it is the manners, and this is the
 * mechanism.
 */
export async function destroyCirculationCascade(
  db: Firestore,
  storage: Storage | null,
  circulation: CirculationDoc,
  actor: DestroyActor,
): Promise<CirculationDestroyResult> {
  const circulationId = circulation.id;
  const circulationRef = db.collection(CIRCULATIONS_COLLECTION).doc(circulationId);

  const { auditId, resumed } = await beginCirculationDestroy(db, storage, circulation, actor);

  const budget: Budget = { remaining: DESTROY_DOC_BUDGET };
  const totals: Record<string, number> = {};
  const sink: PageSink = async (key, n) => {
    totals[key] = (totals[key] ?? 0) + n;
    await accumulateDestroyAudit(db, auditId, { [key]: n });
  };

  const stages: { key: string; drain: () => Promise<DrainResult> }[] = [
    {
      key: "reviews",
      drain: () =>
        drainQuery(
          db,
          "reviews",
          () => circulationRef.collection(REVIEWS_SUBCOLLECTION),
          budget,
          sink,
        ),
    },
    {
      key: "responses",
      drain: () =>
        drainQuery(
          db,
          "responses",
          () => circulationRef.collection(RESPONSES_SUBCOLLECTION),
          budget,
          sink,
        ),
    },
    {
      key: "tasks",
      drain: () => drainRecipientTasks(db, storage, circulationId, budget, sink),
    },
    {
      key: "schedulerMarkers",
      drain: () =>
        drainQuery(
          db,
          "schedulerMarkers",
          () =>
            db
              .collection(SCHEDULER_MARKERS_COLLECTION)
              .where("circulationId", "==", circulationId),
          budget,
          sink,
        ),
    },
    {
      key: "uploadedImages",
      drain: () =>
        drainStoragePrefix(
          storage,
          "uploadedImages",
          circulationUploadPrefix(circulationId),
          budget,
          sink,
        ),
    },
    {
      key: "questionImages",
      drain: () =>
        drainStoragePrefix(
          storage,
          "questionImages",
          questionImagePrefix(circulationId),
          budget,
          sink,
        ),
    },
  ];

  // Everything from here to the return holds this pass's claim, so every exit,
  // including a throw out of a drain, has to hand it back or the resume waits
  // out the lease for nothing.
  try {
    let complete = false;
    for (let pass = 1; ; pass += 1) {
      if (pass > MAX_PASSES) {
        throw new Error(
          `worksheetDestroy: circulation ${circulationId} still producing rows after ${MAX_PASSES} full passes, aborting`,
        );
      }
      let passDeleted = 0;
      let allDrained = true;
      for (const stage of stages) {
        if (budget.remaining <= 0) {
          allDrained = false;
          break;
        }
        const res = await stage.drain();
        passDeleted += res.deleted;
        if (!res.drained) allDrained = false;
      }
      // A stage reports un-drained only when the budget ran out: a
      // pathological non-progress throws inside the drain.
      if (!allDrained) break;
      if (passDeleted === 0) {
        complete = true;
        break;
      }
    }

    if (!complete) {
      await releaseDestroyAuditPass(db, auditId);
      return {
        auditId,
        deleted: await readDestroyAuditTotals(db, auditId, totals),
        complete: false,
        resumed,
      };
    }

    // Everything drained and verified empty. The circulation document goes
    // last and the audit row is completed with it.
    await circulationRef.delete();
    totals.circulation = (totals.circulation ?? 0) + 1;
    await accumulateDestroyAudit(db, auditId, { circulation: 1 });
    await completeDestroyAudit(db, auditId);

    return {
      auditId,
      deleted: await readDestroyAuditTotals(db, auditId, totals),
      complete: true,
      resumed,
    };
  } catch (err) {
    // Best-effort: a failed release is not worth masking the real error with,
    // and the lease expires on its own. A process that dies outright never
    // reaches here at all, which is the crash window the header documents.
    await releaseDestroyAuditPass(db, auditId);
    throw err;
  }
}
