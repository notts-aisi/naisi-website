"use client";

import { useEffect, useState } from "react";
import { collection, getCountFromServer, query, where } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { useAuth } from "@/auth/AuthProvider";

/**
 * Count of course applications still awaiting a decision, across every run —
 * the Courses tab badge in the admin console.
 *
 * Same shape as `usePendingCount` / `useCollaboratorCount`: a one-shot count()
 * aggregation on mount (~1 read per 1000 docs) rather than an always-open
 * onSnapshot over the matching rows. Not realtime by design — it reflects the
 * count at page load, which is the accepted trade for keeping the admin
 * console's standing read cost flat.
 *
 * Admin-only: `courseApplications` grants list/count to admins and otherwise
 * only own-row read, so a non-admin's query would be rejected outright. Callers
 * that aren't admins never issue it.
 *
 * Returns `null` — not 0 — while the count is unknown (before it lands, for a
 * non-admin, or after a failed read), so a caller can tell "nothing pending"
 * apart from "not read yet" instead of rendering a confident zero it never
 * measured.
 */
export function useCourseApplicationCount(): number | null {
  const { role } = useAuth();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (role !== "admin") return;
    let cancelled = false;
    const db = getClientDb();
    const q = query(
      collection(db, "courseApplications"),
      where("status", "==", "pending"),
    );
    getCountFromServer(q)
      .then((snap) => {
        if (!cancelled) setCount(snap.data().count);
      })
      .catch(() => {
        if (!cancelled) setCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [role]);

  // Non-admins never query; mask any count left over from a prior admin session
  // in this tab so they always read "unknown".
  return role === "admin" ? count : null;
}
