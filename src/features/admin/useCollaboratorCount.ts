"use client";

import { useEffect, useState } from "react";
import { collection, getCountFromServer, query, where } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { useAuth } from "@/auth/AuthProvider";

/**
 * Count of pending collaborator applications, for the admin tab badge. Mirrors
 * usePendingCount: a one-shot count() aggregation on mount (not an always-open
 * onSnapshot), only for admins; non-admins read 0. Not realtime by design.
 */
export function useCollaboratorCount() {
  const { role } = useAuth();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (role !== "admin") return;
    let cancelled = false;
    const db = getClientDb();
    const q = query(
      collection(db, "collaborators"),
      where("status", "==", "pending"),
    );
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

  return role === "admin" ? count : 0;
}
