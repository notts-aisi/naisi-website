"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import {
  MEMBER_RECORDS_COLLECTION,
  MEMBER_RECORD_APPLICATIONS,
  normalizeApplicationRecord,
  type ApplicationRecordDoc,
} from "@/lib/firestore/memberRecords";

/**
 * What one snapshot said, and WHOSE record it said it about.
 */
type Snapshot = {
  uid: string;
  rows: ApplicationRecordDoc[];
  error: Error | null;
};

/**
 * One person's application history, as the committee keeps it:
 * `memberRecords/{uid}/applications`, one entry per round they applied to.
 *
 * ## One document, one reader
 *
 * The path segments and the coercion all come from
 * `src/lib/firestore/memberRecords.ts`, the module that also WRITES these
 * entries, and there is deliberately no second copy of any of it here. That
 * module is importable from a client component on purpose: its import of
 * `firebase-admin/firestore` is type-only (erased by the compiler, so nothing
 * of the Admin SDK reaches the bundle) and it carries no `import
 * "server-only"`, both of which its own header explains as being for the sake
 * of this file.
 *
 * Sharing the normaliser is not tidiness. `normalizeApplicationRecord` clamps
 * every field to `MEMBER_RECORD_LIMITS` and falls back to `UNNAMED_REVIEWER`
 * for a reviewer this build cannot name, and a private copy of that logic
 * would drift the day either changes: the surface that RENDERS an entry would
 * then disagree with the surface that wrote it, and the render is the one a
 * person reads.
 *
 * ## Why a listener on a record no browser writes
 *
 * Only routes write these entries (a round settling, or a round destroy
 * writing the record it is about to need). A listener still earns its place:
 * an admin who settles or destroys a round in another tab sees this panel fill
 * in without reloading the Members page, and a one-shot fetch would show a
 * stale empty state at exactly the moment the record matters most, which is
 * the minute before somebody presses delete on an account.
 *
 * ## No clauses, and sorted here
 *
 * The rule admits admins and SU-recognised committee to the whole
 * subcollection, so the shape is the plain collection and every entry comes
 * back. It is deliberately NOT `orderBy("appliedAt")`: Firestore drops a
 * document missing the ordered field, so an entry written from an application
 * whose `createdAt` never landed would vanish from the list entirely (the
 * repo's no-orderBy-on-sparse-fields rule). Sorting here costs nothing at the
 * scale of "rounds one person has applied to" and cannot hide a row. Newest
 * first, because the last thing somebody applied for is what an admin reading
 * their row is nearly always asking about, and an entry with no date sorts to
 * the bottom rather than jumping the queue.
 *
 * ## The uid is carried in the state, not reset by an effect
 *
 * The Members list mounts this per expanded row, and the same component
 * instance can be handed a new uid. Clearing the rows from inside the effect
 * would be a synchronous setState in an effect body (a cascading render, and
 * the lint rule that says so); stamping each snapshot with the uid it came
 * from answers the same question during render instead. A snapshot for the
 * previous member is simply not this member's, so the panel reads as loading
 * rather than briefly showing somebody else's history under their name.
 */
export function useMemberApplications(uid: string) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    const db = getClientDb();
    const q = query(
      collection(db, MEMBER_RECORDS_COLLECTION, uid, MEMBER_RECORD_APPLICATIONS),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => normalizeApplicationRecord(d.id, d.data()));
        rows.sort((a, b) => (b.appliedAt?.getTime() ?? 0) - (a.appliedAt?.getTime() ?? 0));
        setSnapshot({ uid, rows, error: null });
      },
      (err) => {
        console.error("useMemberApplications:", err);
        setSnapshot({ uid, rows: [], error: err });
      },
    );
    return unsub;
  }, [uid]);

  const current = snapshot !== null && snapshot.uid === uid ? snapshot : null;

  return {
    applications: current?.rows ?? [],
    loading: current === null,
    error: current?.error ?? null,
  };
}
