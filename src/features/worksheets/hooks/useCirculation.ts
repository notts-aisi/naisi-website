"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeCirculation, type CirculationDoc } from "@/lib/firestore/circulations";

/**
 * Live subscription to one circulation document.
 *
 * A GET, not a list, which matters because `circulations` splits the two in
 * `firestore.rules`: get admits admins, staff AND the recipient (proved by an
 * `exists()` on their own response), while list admits only admins and staff.
 * So this hook is the read every surface uses to reach a single circulation,
 * including the recipient's respond page, and nothing here has to know which
 * of the two is calling.
 *
 * `circulationId` is nullable so a caller can hold the hook while it works out
 * which circulation it wants (a route param that has not resolved, a picker
 * with nothing chosen). Passing null attaches no listener and reports
 * `loading: false` rather than a permanent spinner.
 */
export function useCirculation(circulationId: string | null) {
  const [circulation, setCirculation] = useState<CirculationDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!circulationId) return;
    const db = getClientDb();
    const unsub = onSnapshot(
      doc(db, "circulations", circulationId),
      (snap) => {
        setCirculation(snap.exists() ? normalizeCirculation(snap.id, snap.data()) : null);
        setLoading(false);
      },
      // Never swallowed. A permission-denied here is the difference between
      // "this circulation has no recipients" and "you are not staff on it",
      // and a silent empty page cannot tell anybody which.
      (err) => {
        console.error("useCirculation:", err);
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [circulationId]);

  // Derived rather than reset in an effect, the `useTask` shape: with no id
  // there is nothing to load and nothing to show, and saying so here keeps the
  // effect free of state resets.
  return {
    circulation: circulationId ? circulation : null,
    loading: circulationId ? loading : false,
    error,
  };
}
