"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import {
  normalizeWorksheet,
  sanitizeItems,
  type WorksheetDoc,
  type WorksheetItem,
} from "@/lib/firestore/worksheets";

type Snapshot = { worksheet: WorksheetDoc | null; rawItems: WorksheetItem[] };

/** One frozen empty pair, so "nothing here" is referentially stable. */
const EMPTY: Snapshot = { worksheet: null, rawItems: [] };

/**
 * One worksheet, live, for the editor page.
 *
 * A `get` rather than a list, so the rules' author branch applies and an
 * admin's private worksheet opens for its author even though the library list
 * cannot show it (see `useWorksheets` for why that split exists).
 *
 * The document is the editor's source of truth for everything EXCEPT the field
 * being typed into: the page holds its own draft of the title, the description
 * and the items while a save is in flight, because a snapshot echoing the
 * previous value back mid-keystroke would fight the cursor.
 *
 * `rawItems` IS THE SAME ITEMS WITH THE NUMBERS AS TYPED, and it exists for the
 * editor to hydrate its draft from. `normalizeWorksheet` clamps every authored
 * limit into range, which is right for every READ path (nothing out of range
 * ever reaches an answer validator) and wrong for the one path that writes the
 * array back: hydrating the editor from the clamped copy turns a rating scale
 * of 50 into 10 the next time the page is opened, reports no problem for it,
 * and persists the change on the following autosave, silently undoing what
 * `updateWorksheet`'s `clampLimits: false` was written to preserve.
 * `validateWorksheetItems` says the same thing from the other end: call it on
 * an unclamped list or its range branches are unreachable.
 */
export function useWorksheet(worksheetId: string | null) {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!worksheetId) return;
    const db = getClientDb();
    const unsub = onSnapshot(
      doc(db, "worksheets", worksheetId),
      (snap) => {
        if (!snap.exists()) {
          setSnapshot(EMPTY);
        } else {
          const data = snap.data();
          setSnapshot({
            worksheet: normalizeWorksheet(snap.id, data),
            rawItems: sanitizeItems(data.items, { clampLimits: false }),
          });
        }
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [worksheetId]);

  // Derived rather than reset in an effect, the `useTask` idiom: with no id
  // there is nothing to load and nothing to wait for.
  return {
    worksheet: worksheetId ? snapshot.worksheet : null,
    rawItems: worksheetId ? snapshot.rawItems : EMPTY.rawItems,
    loading: worksheetId ? loading : false,
    error,
  };
}
