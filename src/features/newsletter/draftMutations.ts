"use client";

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import type { Block } from "@/lib/firestore/newsletterBlocks";

function actingUid(): string {
  const uid = getClientAuth().currentUser?.uid;
  if (!uid) throw new Error("Not signed in");
  return uid;
}

export async function createDraft(params: {
  subject: string;
  authorDisplayName: string | null;
}): Promise<string> {
  const db = getClientDb();
  const ref = await addDoc(collection(db, "newsletterDrafts"), {
    subject: params.subject.trim(),
    bodyMarkdown: "",
    blocks: [],
    status: "draft",
    authorUid: actingUid(),
    authorDisplayName: params.authorDisplayName,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * Strip undefined fields — Firestore rejects them outright. Block types have
 * optional fields (caption, storagePath) that are often undefined for empty
 * or freshly-added blocks, so we clean them here before every write.
 */
function cleanBlock(block: Block): Block {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned as Block;
}

export async function updateDraft(
  id: string,
  fields: Partial<{ subject: string; blocks: Block[] }>,
) {
  const db = getClientDb();
  const patch: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (fields.subject !== undefined) patch.subject = fields.subject.trim();
  if (fields.blocks !== undefined) patch.blocks = fields.blocks.map(cleanBlock);
  await updateDoc(doc(db, "newsletterDrafts", id), patch);
}

export async function submitDraftForReview(id: string) {
  const db = getClientDb();
  await updateDoc(doc(db, "newsletterDrafts", id), {
    status: "pending",
    reviewerNotes: null,
    updatedAt: serverTimestamp(),
  });
}

export async function approveDraft(id: string) {
  const db = getClientDb();
  await updateDoc(doc(db, "newsletterDrafts", id), {
    status: "approved",
    approvedBy: actingUid(),
    approvedAt: serverTimestamp(),
    reviewerNotes: null,
    updatedAt: serverTimestamp(),
  });
}

export async function rejectDraft(id: string, notes: string) {
  const db = getClientDb();
  await updateDoc(doc(db, "newsletterDrafts", id), {
    status: "rejected",
    reviewerNotes: notes.trim(),
    updatedAt: serverTimestamp(),
  });
}

/** Move a rejected/approved draft back to draft so the author can keep editing. */
export async function revertToDraft(id: string) {
  const db = getClientDb();
  await updateDoc(doc(db, "newsletterDrafts", id), {
    status: "draft",
    updatedAt: serverTimestamp(),
  });
}

export async function deleteDraft(id: string) {
  const db = getClientDb();
  await deleteDoc(doc(db, "newsletterDrafts", id));
}
