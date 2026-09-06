"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeCirculation, type CirculationDoc } from "@/lib/firestore/circulations";

/**
 * The circulations of ONE worksheet that the viewer is staff on, listed under
 * the editor so an author can see where their questions have gone.
 *
 * Both clauses are load-bearing: `worksheetId` narrows it to this worksheet,
 * and `staffUids array-contains` is what the circulations list rule is proved
 * from (see `useMyCirculations`). Equality plus array-contains with no
 * `orderBy` merges from the automatic single-field indexes, so this shape owes
 * no composite index; the sort is client-side for the same reason.
 *
 * An author who is not staff on a circulation of their own worksheet sees
 * nothing here, which cannot happen today (the circulate route puts the
 * worksheet's author in `staffUids`) but is the honest behaviour if it ever
 * does: the rule and the query would agree, rather than the page showing a row
 * it cannot open.
 */
export function useWorksheetCirculations(worksheetId: string | null, uid: string | null) {
  const [circulations, setCirculations] = useState<CirculationDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!worksheetId || !uid) return;
    const db = getClientDb();
    const q = query(
      collection(db, "circulations"),
      where("worksheetId", "==", worksheetId),
      where("staffUids", "array-contains", uid),
    );
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
  }, [worksheetId, uid]);

  const ready = Boolean(worksheetId && uid);
  return {
    circulations: ready ? circulations : [],
    loading: ready ? loading : false,
    error,
  };
}
