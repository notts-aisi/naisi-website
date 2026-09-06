"use client";

import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  where,
  type DocumentData,
  type FirestoreError,
  type QuerySnapshot,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeWorksheet, type WorksheetDoc } from "@/lib/firestore/worksheets";

/**
 * The library list, live.
 *
 * TWO LITERAL QUERIES, AND THE BRANCH IS NOT AN OPTIMISATION. `firestore.rules`
 * grants a committee member `read` on a worksheet only where
 * `resource.data.private == false`, and Firestore judges a LISTEN ON THE
 * QUERY'S SHAPE rather than on the rows it would return: it discharges that
 * clause from a matching `where("private", "==", false)` in the query itself,
 * and refuses the whole listen when the clause is absent. Not "returns fewer
 * rows": refuses, with an empty grid and a permission-denied nobody sees. That
 * is #261 exactly. An admin takes the resource-independent branch of the same
 * rule, so they list unfiltered and see private worksheets too.
 *
 * Written as two literal `onSnapshot` call sites, each with its whole query
 * spelled out inside it, because the guard that runs every client SDK read
 * against the emulator as every persona reads the SHAPES out of this file
 * statically. A shape assembled at runtime is a shape it cannot check, and a
 * reference the branch picks between is one it will not guess at: this hook
 * first put the two literal queries either side of a ternary and assigned the
 * result to a `const`, which the scanner reported as "reference chosen by a
 * ternary" and refused to read, so the admin branch and the committee branch
 * would both have gone to the emulator unproven under a paragraph claiming
 * they were legible. Both shapes are now registered in
 * scripts/rules-tests/tests/client-queries.registry.mjs as
 * `worksheets-library-unfiltered` and `worksheets-library-not-private`.
 *
 * A NON-ADMIN AUTHOR DOES NOT SEE THEIR OWN PRIVATE WORKSHEETS HERE, and that
 * is a non-gap rather than a bug: `private` is admin-only to set, in both
 * directions and at both create and update, so a non-admin can never own a
 * private worksheet in the first place. The rules' author branch reaches one by
 * `get`, which is what the editor page does.
 *
 * Sorted client-side. `updatedAt` is written on every save, so an `orderBy`
 * would be safe on sparseness grounds, but it would owe an index for no gain at
 * library scale and the list is already in memory.
 */
export function useWorksheets({ isAdmin }: { isAdmin: boolean }) {
  const [worksheets, setWorksheets] = useState<WorksheetDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const db = getClientDb();
    // The two handlers are shared; only the QUERY differs between the branches,
    // and it is the query the guard has to be able to read.
    const receive = (snap: QuerySnapshot<DocumentData>) => {
      const rows = snap.docs.map((d) => normalizeWorksheet(d.id, d.data()));
      rows.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
      setWorksheets(rows);
      setLoading(false);
    };
    const fail = (err: FirestoreError) => {
      // Surfaced, never swallowed: a refused listen is invisible otherwise,
      // and "the library is empty" is the wrong thing to tell somebody whose
      // read was denied.
      setError(err);
      setLoading(false);
    };
    const unsub = isAdmin
      ? onSnapshot(query(collection(db, "worksheets")), receive, fail)
      : onSnapshot(
          query(collection(db, "worksheets"), where("private", "==", false)),
          receive,
          fail,
        );
    return unsub;
  }, [isAdmin]);

  return { worksheets, loading, error };
}
