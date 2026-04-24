"use client";

import {
  collection,
  doc,
  serverTimestamp,
  type WriteBatch,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { slugId } from "@/lib/firestore/slugId";
import type {
  ActivityKind,
  ActivityPayload,
} from "@/lib/firestore/taskActivity";

/**
 * Queue an activity entry inside a given writeBatch. Caller is responsible
 * for `.commit()` — keeps the activity write atomic with whatever task-level
 * update it accompanies.
 *
 * actorUid must match request.auth.uid at commit time (enforced by rules at
 * firestore.rules:158). `sent_for_review` is server-written via Admin SDK in
 * the /send-for-review route; don't queue it from the client.
 */
export function queueActivity(
  batch: WriteBatch,
  taskId: string,
  kind: ActivityKind,
  actorUid: string,
  payload: ActivityPayload = {},
): void {
  const db = getClientDb();
  // Slug by kind — `subtask_approved__a7f3k2m1` in the Console tells you what
  // happened without opening the doc. Underscore→hyphen conversion is handled
  // by slugify so the `_` in activity kinds comes through cleanly as `-`.
  const ref = doc(collection(db, "tasks", taskId, "activity"), slugId(kind));
  batch.set(ref, {
    kind,
    actorUid,
    createdAt: serverTimestamp(),
    payload,
  });
}
