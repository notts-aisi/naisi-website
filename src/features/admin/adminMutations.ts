"use client";

import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import type { Role } from "@/lib/firebase/session";
import {
  ACADEMIC_YEAR_PATTERN,
  FIELD_LIMITS,
  type Track,
  type UserPermissions,
} from "@/lib/firestore/users";
import { normalizeTask } from "@/lib/firestore/tasks";

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
  const patch: Record<string, unknown> = { role };
  // SU recognition only applies while role === 'committee'. Clear it on any
  // move off committee so a later re-promotion starts non-SU (an explicit
  // admin decision), not silently SU again from a stale flag.
  if (role !== "committee") patch.suRecognised = false;
  await updateDoc(doc(db, "users", uid), patch);
}

/** Admin-only: assign technical/governance tracks (both/either/none). */
export async function setTracks(uid: string, tracks: Track[]) {
  const db = getClientDb();
  await updateDoc(doc(db, "users", uid), { tracks });
}

/**
 * Admin-only: tag/untag a user as a paid member for ONE academic year
 * ("2026/27"). The tag is a BADGE shown to admissions reviewers, never a gate —
 * nothing may branch access on it. Firestore rules pin the field against
 * self-edits exactly like `tracks`, so an admin writes it client-direct.
 *
 * The array is capped at `FIELD_LIMITS.maxPaidMembershipYears`: `normalizeUser`
 * truncates past that, so a doc that grew beyond the cap would silently stop
 * showing its newest tag. arrayUnion is a no-op on a year already present, so
 * only a genuinely new tag has to fit under the cap.
 */
export async function setPaidMembership(uid: string, year: string, paid: boolean) {
  if (!ACADEMIC_YEAR_PATTERN.test(year)) {
    throw new Error(`"${year}" isn't an academic year (expected e.g. 2026/27).`);
  }
  const db = getClientDb();
  if (!paid) {
    await updateDoc(doc(db, "users", uid), { paidMembershipYears: arrayRemove(year) });
    return;
  }
  const snap = await getDoc(doc(db, "users", uid));
  const raw = snap.data()?.paidMembershipYears;
  const existing = Array.isArray(raw) ? (raw as unknown[]) : [];
  if (
    !existing.includes(year) &&
    existing.length >= FIELD_LIMITS.maxPaidMembershipYears
  ) {
    throw new Error(
      `This user already has ${FIELD_LIMITS.maxPaidMembershipYears} paid-membership years. Remove an older one first.`,
    );
  }
  await updateDoc(doc(db, "users", uid), { paidMembershipYears: arrayUnion(year) });
}

/**
 * Admin-only: mark a committee member as recognised by the SU. SU-recognised
 * committee may read member PII (the users collection) and the committee task
 * board; non-SU committee are scoped to the tasks they are on. The Firestore
 * rules lock this field against self-service edits.
 */
export async function setSuRecognised(uid: string, suRecognised: boolean) {
  const db = getClientDb();
  await updateDoc(doc(db, "users", uid), { suRecognised });
}

/**
 * Every key `UserPermissions` models, in the order the admin UI shows them.
 * `setPermissions` writes a whole-object replacement, so this list has to stay
 * exhaustive: a key missing here is a permission the next permissions edit
 * silently revokes. Adding a permission to `UserPermissions` means adding it
 * here too (tests/admin-permissions-keys.test.mjs pins the two together).
 */
export const PERMISSION_KEYS = [
  "draftNewsletter",
  "approveNewsletter",
  "draftEvent",
  "approveEvent",
  "draftCourse",
  "approveCourse",
] as const satisfies readonly (keyof UserPermissions)[];

/**
 * Admin-only: grant/revoke orthogonal permissions (draft/approve newsletter,
 * event and course). Writes every known key as a real boolean, never
 * `undefined`, so an edit to one toggle cannot drop another permission.
 */
export async function setPermissions(uid: string, permissions: UserPermissions) {
  const db = getClientDb();
  const clean: Record<string, boolean> = {};
  for (const key of PERMISSION_KEYS) clean[key] = Boolean(permissions[key]);
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
  // Stage 3 (2026-04-24): if memberUids is being rewritten and the change
  // removes anyone, cascade-strip those uids from every task in the
  // project — roster arrays, lock-in consents, review-state arrays.
  // Sealed blocks and completed signoff rows stay as-is (history). The
  // user is rare enough that we don't unwind further; treat it as a
  // membership hygiene pass.
  let removedUids: string[] = [];
  if (fields.memberUids !== undefined) {
    const existing = await getDoc(doc(db, "projects", id));
    if (existing.exists()) {
      const oldMembers = (existing.data().memberUids as string[] | undefined) ?? [];
      const newMembers = fields.memberUids;
      removedUids = oldMembers.filter((u) => !newMembers.includes(u));
    }
  }

  if (removedUids.length === 0) {
    await updateDoc(doc(db, "projects", id), {
      ...fields,
      updatedAt: serverTimestamp(),
    });
    return;
  }

  // Cascade: fetch all tasks in this project, strip removed uids from
  // every roster/consent/review-state field.
  const tasksQuery = query(
    collection(db, "tasks"),
    where("projectId", "==", id),
  );
  const tasksSnap = await getDocs(tasksQuery);
  const removedSet = new Set(removedUids);
  const batch = writeBatch(db);
  batch.update(doc(db, "projects", id), {
    ...fields,
    updatedAt: serverTimestamp(),
  });
  for (const taskSnap of tasksSnap.docs) {
    const task = normalizeTask(taskSnap.id, taskSnap.data());
    const filterOut = (arr: string[]) => arr.filter((u) => !removedSet.has(u));
    const nextCompleters = filterOut(task.completerUids);
    const nextReviewers = filterOut(task.reviewerUids);
    const nextSubtasks = task.subtasks.map((s) => ({
      ...s,
      assigneeUids: filterOut(s.assigneeUids),
      reviewerUids: filterOut(s.reviewerUids),
      approvedByReviewerUids: filterOut(s.approvedByReviewerUids),
      questionedByReviewerUids: filterOut(s.questionedByReviewerUids),
      rejectedByReviewerUids: filterOut(s.rejectedByReviewerUids),
    }));
    const nextConsents: Record<string, { consentingCompleterUids: string[] }> = {};
    for (const [blockId, rec] of Object.entries(task.blockConsents)) {
      nextConsents[blockId] = {
        consentingCompleterUids: filterOut(rec.consentingCompleterUids),
      };
    }
    // Skip the write if nothing changed — avoids touching updatedAt on
    // tasks whose rosters didn't include any of the removed uids.
    const dirty =
      nextCompleters.length !== task.completerUids.length ||
      nextReviewers.length !== task.reviewerUids.length ||
      nextSubtasks.some((s, i) => {
        const orig = task.subtasks[i];
        return (
          s.assigneeUids.length !== orig.assigneeUids.length ||
          s.reviewerUids.length !== orig.reviewerUids.length ||
          s.approvedByReviewerUids.length !== orig.approvedByReviewerUids.length ||
          s.questionedByReviewerUids.length !== orig.questionedByReviewerUids.length ||
          s.rejectedByReviewerUids.length !== orig.rejectedByReviewerUids.length
        );
      }) ||
      Object.entries(nextConsents).some(
        ([k, v]) =>
          v.consentingCompleterUids.length !==
          (task.blockConsents[k]?.consentingCompleterUids.length ?? 0),
      );
    if (!dirty) continue;
    // Serialize subtasks inline (avoids importing the task-side helper,
    // which is client-scoped). We preserve every non-uid field intact.
    const serializedSubtasks = nextSubtasks.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      dueDate: s.dueDate, // Already a Date; Firestore will coerce.
      done: s.done,
      doneAt: s.doneAt,
      doneByUid: s.doneByUid,
      assigneeUids: s.assigneeUids,
      reviewerUids: s.reviewerUids,
      blockedBy: s.blockedBy,
      approvedByReviewerUids: s.approvedByReviewerUids,
      questionedByReviewerUids: s.questionedByReviewerUids,
      rejectedByReviewerUids: s.rejectedByReviewerUids,
      blockId: s.blockId,
      sealState: s.sealState,
      sealedAt: s.sealedAt,
      roleHint: s.roleHint,
    }));
    batch.update(doc(db, "tasks", taskSnap.id), {
      completerUids: nextCompleters,
      reviewerUids: nextReviewers,
      subtasks: serializedSubtasks,
      blockConsents: nextConsents,
      updatedAt: serverTimestamp(),
    });
  }
  await batch.commit();
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
