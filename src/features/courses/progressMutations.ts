"use client";

import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  type DocumentReference,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import {
  buildProgressWrite,
  courseProgressId,
  type CourseProgressDoc,
  type ProgressItemKind,
} from "@/lib/firestore/courseProgress";

/**
 * The member write path for `courseProgress` — check-off, rating, comments.
 *
 * This is THE one client-direct write in the courses feature (see the
 * `courseProgress.ts` header and the matching firestore.rules block): the
 * deterministic doc id `runId + '__' + uid + '__' + itemId` makes own-row-only
 * writes structural, so the rules express the whole invariant and no route has
 * to stand in front of the check-off hot path. Everything else
 * member-state-shaped (applications, enrolments, exercise responses,
 * attendance) is routes-only.
 *
 * Two properties both mutations below share, and neither is optional:
 *
 *  - **`buildProgressWrite` builds the payload, always.** It is the one place
 *    `hasPublicComment` is derived from the trimmed comment, and the rules pin
 *    the mirror to the comment — hand-rolling a payload here is how the two
 *    drift and the cohort comments lane starts lying.
 *  - **`setDoc` WITHOUT merge.** The rules validate `request.resource.data` as
 *    a whole (closed key set, absent-not-null optionals, the mirror pin), so a
 *    partial merge would be checked against a document the client never
 *    assembled. Full-document writes are what make the shape check meaningful
 *    — and are why every field the caller wants to keep must be passed in.
 */

/** The row a mutation addresses, plus what is already stored there. */
type ProgressTarget = {
  runId: string;
  uid: string;
  weekNumber: number;
  itemKind: ProgressItemKind;
  itemId: string;
  /**
   * The row as last read (`null` before the member has ever touched the item).
   * Load-bearing: these are full-document writes, so anything absent from
   * `current` and not passed explicitly is GONE after the write.
   */
  current: CourseProgressDoc | null;
};

export type ToggleProgressArgs = ProgressTarget & {
  /** The state being moved to, not the state it is in. */
  next: boolean;
};

export type SaveReflectionArgs = ProgressTarget & {
  /**
   * Integer 1–5. OMITTING IT CLEARS THE RATING — a full-document write has no
   * way to say "leave this one alone", so a panel that only edits the comment
   * must pass `current.rating` back. Same for the two text fields below.
   */
  rating?: number;
  /** Visible to everyone on the run. Plain text; rendered as text nodes only. */
  publicComment?: string;
  /** Visible to facilitators + admins only. Plain text. */
  privateNote?: string;
};

/** What `buildProgressWrite` needs beyond the address. */
type ProgressFields = {
  completed: boolean;
  completedAt?: unknown;
  rating?: number;
  publicComment?: string;
  privateNote?: string;
};

type ModerationCarry = { moderatedByUid?: string; moderatedAt?: unknown };

/**
 * The moderation stamp, carried through VERBATIM — the rules pin both fields
 * to their prior values, so dropping or rounding either fails the write.
 *
 * Read back off the live document rather than taken from the normalised row:
 * `normalizeCourseProgress` hands back a JS `Date`, which is millisecond
 * precision, while a server timestamp carries microseconds. Re-writing the
 * normalised value would round it and be DENIED. The extra read only fires on
 * a row that has actually been moderated, which is rare by construction.
 */
async function moderationCarry(
  ref: DocumentReference,
  current: CourseProgressDoc | null,
): Promise<ModerationCarry> {
  if (!current?.moderatedByUid) return {};
  const data = (await getDoc(ref)).data();
  const moderatedByUid = data?.moderatedByUid;
  if (typeof moderatedByUid !== "string" || !moderatedByUid) return {};
  return data?.moderatedAt === undefined
    ? { moderatedByUid }
    : { moderatedByUid, moderatedAt: data.moderatedAt };
}

async function commitProgress(
  target: ProgressTarget,
  fields: ProgressFields,
): Promise<void> {
  const ref = doc(
    getClientDb(),
    "courseProgress",
    courseProgressId(target.runId, target.uid, target.itemId),
  );
  const moderation = await moderationCarry(ref, target.current);
  await setDoc(
    ref,
    buildProgressWrite({
      runId: target.runId,
      uid: target.uid,
      weekNumber: target.weekNumber,
      itemKind: target.itemKind,
      itemId: target.itemId,
      ...fields,
      ...moderation,
    }),
  );
}

/**
 * Check an item off, or un-check it. The rating and both comment fields are
 * carried across from `current` — a check-off must never cost someone the
 * reflection they wrote last week.
 *
 * `completedAt` is the client SDK's `serverTimestamp()` sentinel and only ever
 * accompanies a completed row; `buildProgressWrite` drops it on the way back
 * down, so un-checking removes the instant rather than leaving a stale one.
 * Un-checking then re-checking therefore re-stamps, which is correct: it is a
 * new completion.
 *
 * Rejects on a denied or failed write — the row is the caller's to revert
 * (`MaterialRow` flips optimistically and reverts on the rejection).
 */
export async function toggleProgressItem(args: ToggleProgressArgs): Promise<void> {
  await commitProgress(args, {
    completed: args.next,
    completedAt: args.next ? serverTimestamp() : undefined,
    rating: args.current?.rating,
    publicComment: args.current?.publicComment,
    privateNote: args.current?.privateNote,
  });
}

/**
 * Save the reflection panel: star rating, cohort-visible comment, private note.
 *
 * Completion is preserved exactly as stored — `completedAt` is passed back as
 * the Date it already is rather than re-stamped, so editing a comment three
 * weeks later doesn't rewrite when the material was finished. (The rules only
 * require `completedAt is timestamp`; they don't pin it, so the round-trip
 * through `Date` is safe here in a way the moderation stamp is not.)
 *
 * THE PENDING-SENTINEL WINDOW is the exception. The check-off writes
 * `completedAt` as a `serverTimestamp()` sentinel, and until the server's value
 * comes back down the listener's row reads `completed: true` with NO
 * `completedAt` (the local snapshot has no value to normalise yet). That window
 * is exactly when the panel is open — the choreography opens it on check-off —
 * so passing the gap straight through would make `buildProgressWrite` omit the
 * field and this full-document write would DROP the completion instant. A fresh
 * sentinel re-stamps it instead: the same instant to within the round trip, and
 * the only alternative is losing it.
 */
export async function saveProgressReflection(
  args: SaveReflectionArgs,
): Promise<void> {
  const completed = args.current?.completed === true;
  await commitProgress(args, {
    completed,
    completedAt: completed
      ? (args.current?.completedAt ?? serverTimestamp())
      : undefined,
    rating: args.rating,
    publicComment: args.publicComment,
    privateNote: args.privateNote,
  });
}
