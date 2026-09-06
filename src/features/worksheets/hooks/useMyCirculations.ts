"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeCirculation, type CirculationDoc } from "@/lib/firestore/circulations";

/**
 * Every circulation the viewer is STAFF on: the ones they sent, the ones whose
 * worksheet they wrote, and the ones they were named a reviewer of. That is the
 * "Sent" tab, and it is deliberately wider than "sent by me": a reviewer with
 * no `circulateWorksheet` key still needs the door to the circulations they are
 * expected to read.
 *
 * `where("staffUids", "array-contains", uid)` is not a filter the caller could
 * drop. The circulations list rule is `isAdmin() || isStaff()`, and Firestore
 * discharges the staff half from this clause and refuses the listen without it.
 * An admin would be allowed to list unfiltered, but this page is "circulations
 * I am on" rather than "every circulation on the site", so the clause stays for
 * everybody.
 *
 * Sorted client-side by `createdAt`, newest first, so no index is owed.
 */
export function useMyCirculations(uid: string | null) {
  const [circulations, setCirculations] = useState<CirculationDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!uid) return;
    const db = getClientDb();
    const q = query(collection(db, "circulations"), where("staffUids", "array-contains", uid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => normalizeCirculation(d.id, d.data()));
        rows.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
        setCirculations(rows);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [uid]);

  return {
    circulations: uid ? circulations : [],
    loading: uid ? loading : false,
    error,
  };
}
