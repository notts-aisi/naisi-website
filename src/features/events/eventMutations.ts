"use client";

import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import type {
  EventVisibility,
  FoodProvenance,
  FormQuestion,
} from "@/lib/firestore/events";

function actingUid(): string {
  const uid = getClientAuth().currentUser?.uid;
  if (!uid) throw new Error("Not signed in");
  return uid;
}

export async function createEvent(params: {
  title: string;
  authorDisplayName: string | null;
}): Promise<string> {
  const db = getClientDb();
  const ref = await addDoc(collection(db, "events"), {
    title: params.title.trim(),
    blocks: [],
    location: "",
    visibility: "public" satisfies EventVisibility,
    capacity: null,
    waitlistEnabled: false,
    signupForm: [],
    foodProvenance: "none" satisfies FoodProvenance,
    status: "draft",
    authorUid: actingUid(),
    authorDisplayName: params.authorDisplayName,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

/** Firestore rejects undefined in setDoc/updateDoc. Strip it out before writes. */
function cleanBlock(block: Block): Block {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(block)) if (v !== undefined) cleaned[k] = v;
  return cleaned as Block;
}

function cleanQuestion(q: FormQuestion): FormQuestion {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) if (v !== undefined) cleaned[k] = v;
  return cleaned as FormQuestion;
}

type EditableEventFields = Partial<{
  title: string;
  blocks: Block[];
  startAt: Date | null;
  endAt: Date | null;
  location: string;
  locationHidden: boolean;
  locationPublicText: string | null;
  visibility: EventVisibility;
  capacity: number | null;
  waitlistEnabled: boolean;
  signupForm: FormQuestion[];
  foodProvenance: FoodProvenance;
  foodProvenanceNote: string | null;
  posterUrl: string | null;
}>;

export async function updateEvent(id: string, fields: EditableEventFields) {
  const db = getClientDb();
  const patch: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (fields.title !== undefined) patch.title = fields.title.trim();
  if (fields.blocks !== undefined) patch.blocks = fields.blocks.map(cleanBlock);
  if (fields.startAt !== undefined)
    patch.startAt = fields.startAt ? Timestamp.fromDate(fields.startAt) : deleteField();
  if (fields.endAt !== undefined)
    patch.endAt = fields.endAt ? Timestamp.fromDate(fields.endAt) : deleteField();
  if (fields.location !== undefined) patch.location = fields.location.trim();
  if (fields.locationHidden !== undefined) patch.locationHidden = fields.locationHidden;
  if (fields.locationPublicText !== undefined)
    patch.locationPublicText =
      fields.locationPublicText === null || fields.locationPublicText.trim() === ""
        ? deleteField()
        : fields.locationPublicText.trim();
  if (fields.visibility !== undefined) patch.visibility = fields.visibility;
  if (fields.capacity !== undefined) patch.capacity = fields.capacity;
  if (fields.waitlistEnabled !== undefined) patch.waitlistEnabled = fields.waitlistEnabled;
  if (fields.signupForm !== undefined)
    patch.signupForm = fields.signupForm.map(cleanQuestion);
  if (fields.foodProvenance !== undefined) patch.foodProvenance = fields.foodProvenance;
  if (fields.foodProvenanceNote !== undefined)
    patch.foodProvenanceNote =
      fields.foodProvenanceNote === null || fields.foodProvenanceNote.trim() === ""
        ? deleteField()
        : fields.foodProvenanceNote.trim();
  if (fields.posterUrl !== undefined)
    patch.posterUrl = fields.posterUrl === null ? deleteField() : fields.posterUrl;
  await updateDoc(doc(db, "events", id), patch);
}

export async function submitEventForReview(id: string) {
  const db = getClientDb();
  await updateDoc(doc(db, "events", id), {
    status: "pending",
    reviewerNotes: null,
    updatedAt: serverTimestamp(),
  });
}

export async function approveEvent(id: string) {
  const db = getClientDb();
  await updateDoc(doc(db, "events", id), {
    status: "approved",
    approvedBy: actingUid(),
    approvedAt: serverTimestamp(),
    reviewerNotes: null,
    updatedAt: serverTimestamp(),
  });
}

export async function rejectEvent(id: string, notes: string) {
  const db = getClientDb();
  await updateDoc(doc(db, "events", id), {
    status: "rejected",
    reviewerNotes: notes.trim(),
    updatedAt: serverTimestamp(),
  });
}

export async function revertEventToDraft(id: string) {
  const db = getClientDb();
  await updateDoc(doc(db, "events", id), {
    status: "draft",
    updatedAt: serverTimestamp(),
  });
}

export async function cancelEvent(id: string) {
  const db = getClientDb();
  await updateDoc(doc(db, "events", id), {
    status: "cancelled",
    updatedAt: serverTimestamp(),
  });
}

export async function deleteEvent(id: string) {
  const db = getClientDb();
  await deleteDoc(doc(db, "events", id));
}
