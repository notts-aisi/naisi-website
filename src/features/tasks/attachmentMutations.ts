"use client";

import {
  collection,
  doc,
  increment,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import {
  deleteObject,
  getDownloadURL,
  getStorage,
  ref as storageRef,
  uploadBytesResumable,
} from "firebase/storage";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import { ATTACHMENT_LIMITS, isMimeAllowed } from "@/lib/firestore/taskAttachments";
import { slugId } from "@/lib/firestore/slugId";
import { queueActivity } from "./activityLog";

function actingUid(): string {
  const uid = getClientAuth().currentUser?.uid;
  if (!uid) throw new Error("Not signed in");
  return uid;
}

export type UploadAttachmentArgs = {
  taskId: string;
  file: File;
  onProgress?: (fraction: number) => void;
  /** Scopes the attachment to a specific subtask. Omit / null for task-level
   *  (the original behaviour). Storage path is unchanged either way — the
   *  metadata `subtaskId` field is what routes it to the right UI surface. */
  subtaskId?: string | null;
};

export type UploadedAttachment = {
  attachmentId: string;
  storagePath: string;
  downloadURL: string;
};

/**
 * Upload file to Firebase Storage, then write a metadata doc + bump
 * parent.attachmentCount + log activity in one batch. Surfaces progress via
 * the optional callback.
 *
 * Validates size + MIME client-side; Storage rules repeat both checks so a
 * bypass-attempt still fails.
 */
export async function uploadAttachment(
  args: UploadAttachmentArgs,
): Promise<UploadedAttachment> {
  const uid = actingUid();
  if (args.file.size > ATTACHMENT_LIMITS.maxBytes) {
    throw new Error(
      `File is ${Math.round(args.file.size / 1024 / 1024)} MB — cap is ${ATTACHMENT_LIMITS.maxBytes / 1024 / 1024} MB.`,
    );
  }
  if (!isMimeAllowed(args.file.type)) {
    throw new Error(`Files of type "${args.file.type}" aren't allowed.`);
  }

  const db = getClientDb();
  const storage = getStorage();
  // Slug source: filename stem (strip extension) so the Console shows which
  // file the doc corresponds to.
  const fileStem = args.file.name.replace(/\.[^.]+$/, "");
  const docRef = doc(
    collection(db, "tasks", args.taskId, "attachments"),
    slugId(fileStem),
  );
  const safeName = args.file.name.replace(/[^\w.\-]/g, "_");
  const path = `tasks/${args.taskId}/${docRef.id}/${safeName}`;
  const objRef = storageRef(storage, path);

  // Resumable gives us progress events for the UI. If the user leaves the
  // page mid-upload we lose the batch write — but Storage will still show a
  // dangling object. Acceptable for v1; a cleanup job can reap orphans later.
  const task = uploadBytesResumable(objRef, args.file, {
    contentType: args.file.type,
  });

  await new Promise<void>((resolve, reject) => {
    task.on(
      "state_changed",
      (snap) => {
        if (args.onProgress && snap.totalBytes > 0) {
          args.onProgress(snap.bytesTransferred / snap.totalBytes);
        }
      },
      (err) => reject(err),
      () => resolve(),
    );
  });

  const downloadURL = await getDownloadURL(objRef);

  const subtaskId = args.subtaskId ?? null;
  const batch = writeBatch(db);
  batch.set(docRef, {
    filename: args.file.name.slice(0, 200),
    contentType: args.file.type,
    sizeBytes: args.file.size,
    storagePath: path,
    uploadedByUid: uid,
    uploadedAt: serverTimestamp(),
    subtaskId,
  });
  batch.update(doc(db, "tasks", args.taskId), {
    attachmentCount: increment(1),
    updatedAt: serverTimestamp(),
  });
  queueActivity(batch, args.taskId, "attachment_added", uid, {
    attachmentId: docRef.id,
    filename: args.file.name,
    subtaskId,
  });
  await batch.commit();

  return { attachmentId: docRef.id, storagePath: path, downloadURL };
}

export async function deleteAttachment(
  taskId: string,
  attachmentId: string,
  storagePath: string,
): Promise<void> {
  const db = getClientDb();
  const storage = getStorage();
  // Delete Storage object first — if that fails, the metadata doc stays and
  // the user sees the row + an error, which is clearer than a dangling doc
  // pointing at a missing file.
  try {
    await deleteObject(storageRef(storage, storagePath));
  } catch (err) {
    // If the object is already gone (manual console delete, previous attempt),
    // log it and proceed to drop the metadata.
    console.warn("[deleteAttachment] storage delete failed (continuing):", err);
  }
  const batch = writeBatch(db);
  batch.delete(doc(db, "tasks", taskId, "attachments", attachmentId));
  batch.update(doc(db, "tasks", taskId), {
    attachmentCount: increment(-1),
    updatedAt: serverTimestamp(),
  });
  await batch.commit();
}
