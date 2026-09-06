"use client";

import {
  Timestamp,
  addDoc,
  collection,
  deleteField,
  doc,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import type { Block } from "@/lib/firestore/newsletterBlocks";
import { sanitizeSignupForm } from "@/lib/firestore/events";
import type {
  CoverBranding,
  CoverLogoColor,
  CoverLogoPosition,
  EventVisibility,
  FoodProvenance,
  FoodTag,
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
    coverBranding: "corner" satisfies CoverBranding,
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
  foodText: string | null;
  dietaryTags: FoodTag[];
  posterUrl: string | null;
  coverBranding: CoverBranding;
  coverLogoColor: CoverLogoColor;
  coverStripSize: number;
  coverLogoPosition: CoverLogoPosition;
  coverLogoScale: number;
  coverLogoX: number;
  coverLogoY: number;
  coverLogoBackdrop: boolean;
  coverLogoShadow: boolean;
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
    // Clamp here too, not only in the published-event route. This is the
    // client-direct path every draft save takes, so without it a per-question
    // character limit could be stored unbounded simply by never publishing the
    // event. `cleanQuestion` still runs afterwards: the sanitiser only settles
    // the two limit keys, and Firestore refuses an undefined anywhere in the
    // array.
    patch.signupForm = sanitizeSignupForm(fields.signupForm).map(cleanQuestion);
  if (fields.foodProvenance !== undefined) patch.foodProvenance = fields.foodProvenance;
  if (fields.foodProvenanceNote !== undefined)
    patch.foodProvenanceNote =
      fields.foodProvenanceNote === null || fields.foodProvenanceNote.trim() === ""
        ? deleteField()
        : fields.foodProvenanceNote.trim();
  if (fields.foodText !== undefined)
    patch.foodText =
      fields.foodText === null || fields.foodText.trim() === ""
        ? deleteField()
        : fields.foodText.trim();
  if (fields.dietaryTags !== undefined) patch.dietaryTags = fields.dietaryTags;
  if (fields.posterUrl !== undefined)
    patch.posterUrl = fields.posterUrl === null ? deleteField() : fields.posterUrl;
  if (fields.coverBranding !== undefined) patch.coverBranding = fields.coverBranding;
  if (fields.coverLogoColor !== undefined) patch.coverLogoColor = fields.coverLogoColor;
  if (fields.coverStripSize !== undefined) patch.coverStripSize = fields.coverStripSize;
  if (fields.coverLogoPosition !== undefined)
    patch.coverLogoPosition = fields.coverLogoPosition;
  if (fields.coverLogoScale !== undefined)
    patch.coverLogoScale = fields.coverLogoScale;
  if (fields.coverLogoX !== undefined) patch.coverLogoX = fields.coverLogoX;
  if (fields.coverLogoY !== undefined) patch.coverLogoY = fields.coverLogoY;
  if (fields.coverLogoBackdrop !== undefined)
    patch.coverLogoBackdrop = fields.coverLogoBackdrop;
  if (fields.coverLogoShadow !== undefined)
    patch.coverLogoShadow = fields.coverLogoShadow;
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

/**
 * Delete an event and everything hanging off it.
 *
 * Routed through the server rather than a client `deleteDoc` because the
 * cascade cannot be done from the client at all: `eventRsvps` locks client
 * writes to `false`, so a client delete removed the event and left every
 * attendee's name, email and free-text answers behind with nothing pointing at
 * them. `events` no longer grants client delete either, so this is the only
 * path. See /api/events/[id]/delete.
 */
export async function deleteEvent(id: string) {
  const res = await fetch(`/api/events/${id}/delete`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Couldn't delete this event.");
  }
}
