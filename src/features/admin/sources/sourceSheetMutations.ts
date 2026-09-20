"use client";

import {
  deleteDoc,
  deleteField,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import {
  deleteObject,
  getDownloadURL,
  ref as storageRef,
  uploadBytesResumable,
} from "firebase/storage";
import { getClientAuth, getClientDb, getClientStorage } from "@/lib/firebase/client";
import {
  advanceNextNumber,
  SOURCE_SHEET_LIMITS,
  type SourceItem,
  type SourceSheetDoc,
  type SourceSheetFile,
  type SourceSheetImage,
} from "@/lib/firestore/sourceSheets";

/**
 * Every write the /admin/sources editor makes. Client-direct, no API route:
 * `sourceSheets` is admin-only in both directions and the whole admin tree is
 * closed during a view-as session by `(app)/admin/layout.tsx`, which is the
 * property a route handler's `assertNotImpersonating()` would otherwise be
 * providing.
 */

export const SOURCE_STORAGE_PREFIX = "source-materials";

function actingUid(): string {
  const uid = getClientAuth().currentUser?.uid;
  if (!uid) throw new Error("Not signed in");
  return uid;
}

function sheetRef(slug: string) {
  return doc(getClientDb(), "sourceSheets", slug);
}

/**
 * The stored shape of one row.
 *
 * `comment` is written only when it has text. Firestore refuses `undefined`
 * outright, and an empty string stored would reach the public page as an
 * element with nothing in it.
 */
function toStoredItem(item: SourceItem): Record<string, unknown> {
  const stored: Record<string, unknown> = {
    id: item.id,
    n: item.n,
    name: item.name.trim().slice(0, SOURCE_SHEET_LIMITS.itemName),
    url: item.url.trim().slice(0, SOURCE_SHEET_LIMITS.itemUrl),
  };
  const comment = (item.comment ?? "").trim().slice(0, SOURCE_SHEET_LIMITS.itemComment);
  if (comment) stored.comment = comment;
  return stored;
}

/**
 * A file name safe to put in a storage path and in a Content-Disposition
 * header. Both are more forgiving than this, but a quoted filename carrying a
 * quote or a newline is the shape that breaks a header, and nothing is lost by
 * being strict with something nobody reads except as a download name.
 */
export function safeSourceFileName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || "material";
}

/** Create a new entry. The slug is the document id and never changes. */
export async function createSourceSheet(slug: string, title: string): Promise<void> {
  await setDoc(sheetRef(slug), {
    title: title.trim().slice(0, SOURCE_SHEET_LIMITS.title),
    context: "",
    summary: "",
    image: null,
    file: null,
    items: [],
    nextNumber: 1,
    createdByUid: actingUid(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export type SourceSheetPatch = {
  title: string;
  context: string;
  summary: string;
  items: SourceItem[];
  nextNumber: number;
};

/**
 * Save the text fields and the numbered list.
 *
 * `nextNumber` is pushed through `advanceNextNumber` on the way in, so a hand
 * typed number higher than the counter moves the counter past it and the next
 * minted row cannot collide with it. The counter is never lowered, whatever
 * the list now contains.
 */
export async function saveSourceSheet(
  slug: string,
  patch: SourceSheetPatch,
): Promise<void> {
  await updateDoc(sheetRef(slug), {
    title: patch.title.trim().slice(0, SOURCE_SHEET_LIMITS.title),
    context: patch.context.trim().slice(0, SOURCE_SHEET_LIMITS.context),
    summary: patch.summary.trim().slice(0, SOURCE_SHEET_LIMITS.summary),
    items: patch.items.slice(0, SOURCE_SHEET_LIMITS.maxItems).map(toStoredItem),
    nextNumber: advanceNextNumber(patch.nextNumber, patch.items),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Publish, or re-stamp an entry already published.
 *
 * `firstPublishedAt` is written once and never cleared afterwards, including
 * by unpublishing. Unpublishing takes the page down; it cannot take the poster
 * back, so this is the flag the editor reads before warning that changing a
 * number breaks copies already in circulation.
 */
export async function publishSourceSheet(sheet: SourceSheetDoc): Promise<void> {
  const patch: Record<string, unknown> = {
    publishedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (!sheet.firstPublishedAt) patch.firstPublishedAt = serverTimestamp();
  await updateDoc(sheetRef(sheet.slug), patch);
}

/**
 * Delete one storage object, tolerating one that has already gone.
 *
 * A delete that fails must not stop the Firestore write that follows it: a
 * document still pointing at a file nobody can find is a worse state than an
 * object nobody references, and the second is recoverable from the console.
 */
async function removeObject(path: string | undefined | null): Promise<void> {
  if (!path) return;
  try {
    await deleteObject(storageRef(getClientStorage(), path));
  } catch (err) {
    console.warn("[sources] storage delete failed (continuing):", err);
  }
}

/**
 * Take an entry down.
 *
 * "Pulled down" means gone: the entry loses `publishedAt`, so it drops out of
 * the public list and its own page answers "not published yet", AND the image
 * and the PDF are deleted from Storage with the fields cleared. The sources
 * list itself is kept, so republishing later is one button rather than a
 * retype.
 *
 * What this cannot do is recall a download URL somebody already holds, or the
 * poster in their hand. The editor says so in as many words before it runs.
 */
export async function unpublishSourceSheet(sheet: SourceSheetDoc): Promise<void> {
  await removeObject(sheet.image?.storagePath);
  await removeObject(sheet.file?.storagePath);
  await updateDoc(sheetRef(sheet.slug), {
    publishedAt: deleteField(),
    image: null,
    file: null,
    updatedAt: serverTimestamp(),
  });
}

/** Delete the entry outright, with its uploaded files. */
export async function deleteSourceSheet(sheet: SourceSheetDoc): Promise<void> {
  await removeObject(sheet.image?.storagePath);
  await removeObject(sheet.file?.storagePath);
  await deleteDoc(sheetRef(sheet.slug));
}

/**
 * Point the entry at a new image, or at none, and delete whatever it pointed
 * at before.
 *
 * Written straight to Firestore rather than held in the editor's state until
 * Save: the bytes are already in Storage by the time this runs, so a person
 * who closes the tab before saving would otherwise leave an object nothing
 * references and no way to find it.
 */
export async function setSourceSheetImage(
  slug: string,
  image: SourceSheetImage | null,
  previousPath?: string | null,
): Promise<void> {
  if (previousPath && previousPath !== image?.storagePath) {
    await removeObject(previousPath);
  }
  await updateDoc(sheetRef(slug), { image, updatedAt: serverTimestamp() });
}

/** The same for the PDF. */
export async function setSourceSheetFile(
  slug: string,
  file: SourceSheetFile | null,
  previousPath?: string | null,
): Promise<void> {
  if (previousPath && previousPath !== file?.storagePath) {
    await removeObject(previousPath);
  }
  await updateDoc(sheetRef(slug), { file, updatedAt: serverTimestamp() });
}

/**
 * Upload the PDF and return what the document should store.
 *
 * THE CONTENT DISPOSITION IS THE WHOLE POINT of writing our own uploader here
 * rather than reusing `ImageUpload`. Firebase Storage serves a PDF inline, and
 * the HTML `download` attribute is inert cross-origin, so a plain anchor to a
 * storage URL opens the file in a tab. `contentDisposition` is object
 * metadata, set at upload time, and it is what makes the link on the public
 * page actually download. It is set on the PDF ONLY: on the image it would
 * break the `<img>` that renders it.
 *
 * Object metadata cannot be changed later without re-uploading, so this is a
 * decision taken once per file rather than a setting.
 *
 * The size is checked here as well as in `storage.rules` so the person reads a
 * sentence naming the limit instead of a raw Firebase permission string.
 */
export async function uploadSourceSheetFile(
  slug: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<SourceSheetFile> {
  if (file.type !== "application/pdf") {
    throw new Error("Please choose a PDF.");
  }
  if (file.size > SOURCE_SHEET_LIMITS.fileBytes) {
    throw new Error(
      `That PDF is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${
        SOURCE_SHEET_LIMITS.fileBytes / 1024 / 1024
      } MB, so export it at a smaller size and try again.`,
    );
  }

  const safeName = safeSourceFileName(file.name);
  const path = `${SOURCE_STORAGE_PREFIX}/${slug}/${Date.now()}-${safeName}`;
  const objRef = storageRef(getClientStorage(), path);

  const task = uploadBytesResumable(objRef, file, {
    contentType: "application/pdf",
    contentDisposition: `attachment; filename="${safeName}"`,
  });

  await new Promise<void>((resolve, reject) => {
    task.on(
      "state_changed",
      (snap) => {
        if (onProgress && snap.totalBytes > 0) {
          onProgress(snap.bytesTransferred / snap.totalBytes);
        }
      },
      (err) => reject(err),
      () => resolve(),
    );
  });

  return {
    url: await getDownloadURL(objRef),
    storagePath: path,
    filename: file.name.slice(0, 200),
    contentType: "application/pdf",
    sizeBytes: file.size,
  };
}
