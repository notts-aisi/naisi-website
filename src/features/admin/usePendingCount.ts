"use client";

import { useEffect, useState } from "react";
import { collection, getCountFromServer, query, where } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { useAuth } from "@/auth/AuthProvider";

/**
 * Count of users with role == 'pending', for the admin tab badge.
 *
 * One-shot count() aggregation on mount (~1 read per 1000 docs) instead of an
 * always-open onSnapshot over the matching docs (N reads + a live listener for
 * every admin session). The badge is no longer realtime — it reflects the count
 * at load — which is an accepted trade for the read-cost win on the admin
 * console. Only runs for admins; non-admins read 0.
 */
export function usePendingCount() {
  const { role } = useAuth();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (role !== "admin") return;
    let cancelled = false;
    const db = getClientDb();
    const q = query(collection(db, "users"), where("role", "==", "pending"));
    getCountFromServer(q)
      .then((snap) => {
        if (!cancelled) setCount(snap.data().count);
      })
      .catch(() => {
        if (!cancelled) setCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [role]);

  // Non-admins never query; mask any count left over from a prior admin session
  // so they always read 0.
  return role === "admin" ? count : 0;
}
