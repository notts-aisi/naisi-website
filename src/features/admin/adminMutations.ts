"use client";

import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import type { Role } from "@/lib/firebase/session";
import type { Track, UserPermissions } from "@/lib/firestore/users";

function actingAdminUid(): string {
  const uid = getClientAuth().currentUser?.uid;
  if (!uid) throw new Error("Not signed in");
  return uid;
}

export async function approveUser(uid: string) {
  const db = getClientDb();
  await updateDoc(doc(db, "users", uid), {
    role: "member" satisfies Role,
    approvedAt: serverTimestamp(),
    approvedBy: actingAdminUid(),
    rejectedAt: deleteField(),
    rejectedBy: deleteField(),
  });
}

export async function rejectUser(uid: string, rejectionReason?: string) {
  const db = getClientDb();
  const patch: Record<string, unknown> = {
    role: "rejected" satisfies Role,
    rejectedAt: serverTimestamp(),
    rejectedBy: actingAdminUid(),
  };
  if (rejectionReason) patch.rejectionReason = rejectionReason;
  await updateDoc(doc(db, "users", uid), patch);
}

export async function unrejectUser(uid: string) {
  const db = getClientDb();
  await updateDoc(doc(db, "users", uid), {
    role: "pending" satisfies Role,
    rejectedAt: deleteField(),
    rejectedBy: deleteField(),
  });
}

export async function setRole(uid: string, role: Role) {
  const db = getClientDb();
  await updateDoc(doc(db, "users", uid), { role });
}

/** Admin-only: assign technical/governance tracks (both/either/none). */
export async function setTracks(uid: string, tracks: Track[]) {
  const db = getClientDb();
  await updateDoc(doc(db, "users", uid), { tracks });
}

/** Admin-only: grant/revoke orthogonal permissions (draft/approve newsletter, draft/approve event). */
export async function setPermissions(uid: string, permissions: UserPermissions) {
  const db = getClientDb();
  const clean: Record<string, boolean> = {
    draftNewsletter: Boolean(permissions.draftNewsletter),
    approveNewsletter: Boolean(permissions.approveNewsletter),
    draftEvent: Boolean(permissions.draftEvent),
    approveEvent: Boolean(permissions.approveEvent),
  };
  await updateDoc(doc(db, "users", uid), { permissions: clean });
}

type MemberFields = {
  title?: string | null;
  bio?: string | null;
  showOnMembers?: boolean;
};

export async function updateMember(uid: string, fields: MemberFields) {
  const db = getClientDb();
  const patch: Record<string, unknown> = {};
  if (fields.title !== undefined) patch.title = fields.title ?? deleteField();
  if (fields.bio !== undefined) patch.bio = fields.bio ?? deleteField();
  if (fields.showOnMembers !== undefined) patch.showOnMembers = fields.showOnMembers;
  if (Object.keys(patch).length === 0) return;
  await updateDoc(doc(db, "users", uid), patch);
}

type FullProfileUpdate = {
  preferredName?: string;
  universityEmail?: string;
  status?: string;
  statusOther?: string;
  subject?: string;
  expectedGraduation?: string;
  motivation?: string;
  interests?: string;
};

/**
 * Admin edit of a user's profile subfields. Writes nested keys into profile.*
 * so we don't clobber fields we're not touching.
 */
export async function updateUserProfile(uid: string, fields: FullProfileUpdate) {
  const db = getClientDb();
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    patch[`profile.${k}`] = v;
  }
  if (Object.keys(patch).length === 0) return;
  await updateDoc(doc(db, "users", uid), patch);
}

/**
 * Admin-only manual unsubscribe / re-subscribe. The newsletter preference is
 * a profile subfield, so we use dot-path update to avoid clobbering sibling
 * prefs (deliverToGmail, deliverToUniEmail). Re-subscribing is allowed for
 * when an earlier opt-out was mistaken — GDPR only requires honouring an
 * unsubscribe request promptly, not forbidding reversal on user-facing ask.
 */
export async function setNewsletterSubscribed(uid: string, subscribed: boolean) {
  const db = getClientDb();
  await updateDoc(doc(db, "users", uid), {
    "profile.newsletter.subscribed": subscribed,
  });
}

// === Projects ===

export async function createProject(params: {
  name: string;
  leadUid: string;
  memberUids: string[];
}): Promise<string> {
  const db = getClientDb();
  const ref = await addDoc(collection(db, "projects"), {
    name: params.name.trim(),
    leadUid: params.leadUid,
    memberUids: params.memberUids,
    archived: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateProject(
  id: string,
  fields: Partial<{ name: string; leadUid: string; memberUids: string[] }>,
) {
  const db = getClientDb();
  await updateDoc(doc(db, "projects", id), {
    ...fields,
    updatedAt: serverTimestamp(),
  });
}

export async function setProjectArchived(id: string, archived: boolean) {
  const db = getClientDb();
  await updateDoc(doc(db, "projects", id), {
    archived,
    updatedAt: serverTimestamp(),
  });
}

/** Hard-delete a project doc. Tasks linked to it would need separate cleanup when task manager ships. */
export async function deleteProject(id: string) {
  const db = getClientDb();
  await deleteDoc(doc(db, "projects", id));
}

/**
 * Hard-delete a user (Firestore doc + Auth account).
 * Routes through a server handler because Auth deletion needs the Admin SDK.
 */
export async function deleteUser(uid: string): Promise<void> {
  const res = await fetch(`/api/admin/users/${uid}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Delete failed (${res.status})`);
  }
}
