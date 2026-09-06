"use client";

import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import { DEFAULT_REVIEW_CONFIG, type ReviewConfig } from "@/lib/firestore/circulations";
import { slugId } from "@/lib/firestore/slugId";
import {
  WORKSHEET_LIMITS,
  newItemId,
  sanitizeItems,
  type WorksheetDoc,
  type WorksheetItem,
} from "@/lib/firestore/worksheets";

/**
 * The library's client-direct writes: worksheets and the folders they sit in.
 *
 * EVERYTHING HERE IS CLIENT-DIRECT, and that is the split the feature is built
 * on. A worksheet is content its author owns, and `firestore.rules` can express
 * every invariant that matters about it: `authorUid` pinned, `private`
 * admin-only in both directions, the three size caps. Circulating one is the
 * opposite (it copies a worksheet, writes a response document and a task per
 * recipient, and sends mail), so that is a route, and nothing in this file
 * touches a circulation.
 *
 * NO `undefined` EVER REACHES FIRESTORE. A client-direct write refuses an
 * explicit undefined outright, including one nested inside an array, so every
 * patch below is built key by key and every nullable field is written as an
 * explicit `null`. Items go through `sanitizeItems`, which rebuilds each
 * question key by key for the same reason.
 */

function actingUid(): string {
  const uid = getClientAuth().currentUser?.uid;
  if (!uid) throw new Error("Not signed in");
  return uid;
}

/** Trim, then cap at the shared budget, so the editor and the rules agree. */
function capped(value: string, max: number): string {
  return value.trim().slice(0, max);
}

/**
 * WHY NOTHING CHECKS WHETHER A NEW DOC ID IS TAKEN.
 *
 * A worksheet's id is `slugId(title)`: the slug, then eight base36 characters.
 * The obvious guard is a `get` on the candidate before writing it, and it was
 * written that way first. It cannot answer. A `get` of a document that does NOT
 * exist leaves `resource` null, and the worksheets read rule dereferences
 * `resource.data.private`, so for anybody but an admin the missing-document
 * case comes back as permission-denied rather than as an empty snapshot. That
 * case is the overwhelmingly common one, so the check cost every committee
 * member a round trip and a console refusal on every create to learn nothing.
 *
 * WHAT IS LEFT TO CHANCE, so the omission reads as a decision. Landing on an
 * existing id means matching the slug AND one of roughly 2.8 trillion suffixes.
 * Every collision but one is refused by the rules on the way out: a `setDoc`
 * over somebody else's worksheet is an update with a changed `authorUid`, and
 * the update rule pins it. The one the rules cannot catch is a collision with
 * the caller's OWN worksheet, which reads as a legitimate update.
 */

// ---------------------------------------------------------------------------
// Worksheets
// ---------------------------------------------------------------------------

export async function createWorksheet(input: {
  title: string;
  folderId: string | null;
}): Promise<string> {
  const db = getClientDb();
  const uid = actingUid();
  const title = capped(input.title, WORKSHEET_LIMITS.title);
  if (!title) throw new Error("Give the worksheet a title first.");

  const id = slugId(title);
  await setDoc(doc(db, "worksheets", id), {
    title,
    description: "",
    folderId: input.folderId ?? null,
    authorUid: uid,
    // Rule-enforced on create: only an admin may write `true`, and only on
    // update. A new worksheet is never born private, whoever makes it.
    private: false,
    items: [] as WorksheetItem[],
    // The toggles a circulation of this worksheet will start with. Written out
    // at create so the editor has something concrete to show; a worksheet whose
    // map is absent or partial resolves to the same constant on read.
    defaultReviewConfig: { ...DEFAULT_REVIEW_CONFIG },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastCirculatedAt: null,
  });
  return id;
}

/**
 * The fields the editor may change. `private` is not among them: it has its own
 * function because it is the one admin-only field on the document, and mixing
 * it into a general patch is how it ends up written by accident from a surface
 * that never meant to offer it.
 */
export type WorksheetPatch = Partial<{
  title: string;
  description: string;
  folderId: string | null;
  items: WorksheetItem[];
  defaultReviewConfig: ReviewConfig;
}>;

export async function updateWorksheet(id: string, patch: WorksheetPatch): Promise<void> {
  const db = getClientDb();
  const fields: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (patch.title !== undefined) fields.title = capped(patch.title, WORKSHEET_LIMITS.title);
  if (patch.description !== undefined) {
    fields.description = capped(patch.description, WORKSHEET_LIMITS.description);
  }
  if (patch.folderId !== undefined) fields.folderId = patch.folderId ?? null;
  if (patch.items !== undefined) {
    // `clampLimits: false` on the SAVING path, deliberately: the author's
    // out-of-range number is stored as typed and reported by
    // `validateWorksheetItems`, rather than silently changed under them.
    // Clamping here would make the validator's range branches unreachable.
    fields.items = sanitizeItems(patch.items, { clampLimits: false });
  }
  if (patch.defaultReviewConfig !== undefined) {
    fields.defaultReviewConfig = { ...patch.defaultReviewConfig };
  }
  await updateDoc(doc(db, "worksheets", id), fields);
}

/**
 * Admin-only, and the rules say so in both directions. Kept separate from
 * `updateWorksheet` so no editor field can carry it along.
 */
export async function setWorksheetPrivate(id: string, value: boolean): Promise<void> {
  const db = getClientDb();
  await updateDoc(doc(db, "worksheets", id), {
    private: value,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Deleting the library document does NOT touch anything already sent: a
 * circulation carries its own copy of the items, its own responses and its own
 * tasks. That is why an author may do this without an admin, and why the
 * confirmation copy says the sent copies stay.
 */
export async function deleteWorksheet(id: string): Promise<void> {
  const db = getClientDb();
  await deleteDoc(doc(db, "worksheets", id));
}

/**
 * Fresh ids for every item AND every option.
 *
 * Answers are keyed by question id and choice answers store option ids, so two
 * worksheets sharing an id is not a cosmetic collision: it is one worksheet's
 * answers being readable as another's the moment both are circulated and
 * anything ever joins the two by id. `newItemId` is used rather than a copy of
 * the original id for exactly that reason.
 */
function copyItems(items: WorksheetItem[]): WorksheetItem[] {
  return items.map((item): WorksheetItem => {
    if (item.kind === "pageBreak") return { kind: "pageBreak", id: newItemId("pb") };
    if (item.kind === "section") return { ...item, id: newItemId("s") };
    const question = { ...item, id: newItemId("q") };
    if (question.options) {
      question.options = question.options.map((option) => ({ ...option, id: newItemId("o") }));
    }
    return question;
  });
}

/**
 * "Make a copy": the answer to "you cannot edit somebody else's worksheet".
 *
 * The copy is authored by whoever made it, and it INHERITS `private`. That
 * second half is the one that matters. A private worksheet is readable by
 * admins and by its author, and the author is routinely NOT an admin (that is
 * what the flag is for: an admin takes a document off the shelf the whole
 * committee browses while its author keeps working on it). A copy that came out
 * public would therefore be a one-click way for that author to republish every
 * question of it into the library, defeating a flag the rules go out of their
 * way to pin admin-only in both directions and at both create and update.
 *
 * Inheriting also makes the failure closed rather than open: a non-admin
 * copying a private worksheet is refused by the create rule (`private` may only
 * be written `true` by an admin) instead of quietly succeeding. The surfaces
 * hide "Make a copy" on a private worksheet for anybody but an admin, so the
 * refusal is not how somebody finds out, but the rule is the guarantee and the
 * hidden button is only the manners.
 */
export async function duplicateWorksheet(worksheet: WorksheetDoc): Promise<string> {
  const db = getClientDb();
  const uid = actingUid();
  const title = capped(`Copy of ${worksheet.title || "Untitled worksheet"}`, WORKSHEET_LIMITS.title);
  const id = slugId(title);
  await setDoc(doc(db, "worksheets", id), {
    title,
    // Capped like every other write of this field: the caller may hand over a
    // draft straight out of the editor's box rather than the stored document,
    // and an over-long description is refused by the create rule.
    description: capped(worksheet.description, WORKSHEET_LIMITS.description),
    folderId: worksheet.folderId ?? null,
    authorUid: uid,
    private: worksheet.private,
    items: sanitizeItems(copyItems(worksheet.items), { clampLimits: false }),
    defaultReviewConfig: { ...(worksheet.defaultReviewConfig ?? DEFAULT_REVIEW_CONFIG) },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    lastCirculatedAt: null,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createFolder(name: string): Promise<string> {
  const db = getClientDb();
  const uid = actingUid();
  const clean = capped(name, WORKSHEET_LIMITS.folderName);
  if (!clean) throw new Error("Give the folder a name first.");
  // Same slug-prefix convention as a worksheet, so the Firebase console stays
  // scannable; the collision check is skipped because a folder is a name and a
  // stamp, and the worst a collision could do is rename a shelf.
  const id = slugId(clean);
  await setDoc(doc(db, "worksheetFolders", id), {
    name: clean,
    createdByUid: uid,
    createdAt: serverTimestamp(),
  });
  return id;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const db = getClientDb();
  const clean = capped(name, WORKSHEET_LIMITS.folderName);
  if (!clean) throw new Error("A folder needs a name.");
  await updateDoc(doc(db, "worksheetFolders", id), { name: clean });
}

/**
 * Delete a shelf, re-filing the caller's OWN worksheets off it on the way.
 *
 * THE DELETE IS NEVER HELD HOSTAGE BY SOMEBODY ELSE'S WORKSHEET, which is what
 * an all-or-nothing re-file of everything on the shelf made it. A committee
 * member may update only worksheets whose `authorUid` is theirs, so the moment
 * a second author had filed anything here the whole batch was refused, the
 * shelf survived, and the only recourse was an admin. Folders are shared
 * furniture on purpose (no ownership gate in the rules, so a shelf whose maker
 * has left the committee is still one somebody can tidy), and a delete that
 * only its lucky sole user can perform is not that.
 *
 * SO THE READ IS SCOPED TO THE CALLER'S OWN WORKSHEETS. `where("authorUid",
 * "==", uid)` is also the shape the rules prove the author branch from, so the
 * read is granted whether or not the documents are private, and every update in
 * the batch is one the caller is certainly allowed to make. The folder document
 * goes whatever else is filed on it.
 *
 * DANGLING `folderId` POINTERS ARE THE DESIGN HERE, not a leak. `firestore.rules`
 * says so on the `worksheetFolders` block: rules cannot cascade, a client
 * cascade is a fan-out write the deleter may not be allowed to make, and the
 * library therefore reads a folderId that resolves to nothing as "No folder"
 * (WorksheetLibrary does exactly that). The repo-wide cascade-delete sweep on
 * the backlog is the real fix; re-filing what the caller may touch is the
 * honest half of it until then. An admin could re-file everybody's, and
 * deliberately does not: one query shape for one operation, and the reader sees
 * the same "No folder" either way.
 *
 * ONE BATCH, so the re-file and the delete land together and there is no window
 * in which a worksheet is unfiled while its shelf is still on the bar.
 *
 * `updatedAt` IS NOT BUMPED on the re-filed worksheets. Their content did not
 * change, a shelf disappeared under them, and marking them updated would
 * attribute a change to an author who made none and re-sort the library under
 * everyone.
 */
export async function deleteFolder(id: string): Promise<void> {
  const db = getClientDb();
  const uid = actingUid();
  const mine = await getDocs(
    query(
      collection(db, "worksheets"),
      where("folderId", "==", id),
      where("authorUid", "==", uid),
    ),
  );
  // A Firestore batch holds 500 writes. One person with 499 worksheets on one
  // shelf is not a shape this library reaches, and the failure is a refused
  // commit rather than a silent partial write.
  const batch = writeBatch(db);
  for (const snap of mine.docs) {
    batch.update(snap.ref, { folderId: null });
  }
  batch.delete(doc(db, "worksheetFolders", id));
  await batch.commit();
}
