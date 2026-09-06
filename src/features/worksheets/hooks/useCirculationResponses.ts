"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeResponse, type ResponseDoc } from "@/lib/firestore/circulations";

/**
 * Every response on one circulation: the recipient table's data.
 *
 * A STAFF-ONLY READ, and the rule is what makes that true rather than any
 * check here. `circulations/{id}/responses/{uid}` admits the owner by document
 * id, which is not something a query can constrain, so a recipient's list of
 * the subcollection is refused outright while their get of their own response
 * is allowed. That is the intended shape (one recipient must never enumerate
 * what the others wrote), and it is why the circulation page passes `null`
 * until it knows the viewer is staff: attaching this listener for a recipient
 * would produce a permission error rather than an empty list.
 *
 * No clauses. Staff read the whole subcollection, and the rule discharges that
 * with ONE `get()` of the parent circulation however many responses come back.
 * Ordering is client-side, by `addedAt`: it is the order recipients were
 * added, which is the order the sender put them in and therefore the one they
 * expect to find them in. `orderBy` on the server would be worse than useless
 * here, because a document written without the field would be dropped from the
 * listen entirely (the no-orderBy-on-sparse-fields rule in the repo
 * conventions), and a recipient missing from the table is a person nobody
 * chases.
 */
export function useCirculationResponses(circulationId: string | null) {
  const [responses, setResponses] = useState<ResponseDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!circulationId) return;
    const db = getClientDb();
    const q = query(collection(db, "circulations", circulationId, "responses"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => normalizeResponse(d.id, d.data()));
        rows.sort((a, b) => (a.addedAt?.getTime() ?? 0) - (b.addedAt?.getTime() ?? 0));
        setResponses(rows);
        setLoading(false);
      },
      (err) => {
        console.error("useCirculationResponses:", err);
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [circulationId]);

  return {
    responses: circulationId ? responses : [],
    loading: circulationId ? loading : false,
    error,
  };
}
