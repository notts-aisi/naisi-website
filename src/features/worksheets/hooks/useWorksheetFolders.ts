"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import {
  normalizeWorksheetFolder,
  type WorksheetFolderDoc,
} from "@/lib/firestore/worksheets";

/**
 * The library's shelves.
 *
 * Unfiltered on purpose: `worksheetFolders` is readable by any committee member
 * or admin with no per-document condition, so there is no shape for a query to
 * discharge here and nothing to filter on. A folder is shared furniture, not an
 * owned document.
 *
 * Sorted by name, case-insensitively, so the chips read alphabetically however
 * they were capitalised.
 */
export function useWorksheetFolders() {
  const [folders, setFolders] = useState<WorksheetFolderDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const db = getClientDb();
    const unsub = onSnapshot(
      query(collection(db, "worksheetFolders")),
      (snap) => {
        const rows = snap.docs.map((d) => normalizeWorksheetFolder(d.id, d.data()));
        rows.sort((a, b) => a.name.localeCompare(b.name, "en-GB", { sensitivity: "base" }));
        setFolders(rows);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, []);

  return { folders, loading, error };
}
