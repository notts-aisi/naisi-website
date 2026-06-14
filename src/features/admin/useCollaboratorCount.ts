"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { useAuth } from "@/auth/AuthProvider";

/**
 * Real-time count of pending collaborator applications, for the admin tab badge.
 * Mirrors usePendingCount: only subscribes for admins; non-admins read 0.
 */
export function useCollaboratorCount() {
  const { role } = useAuth();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (role !== "admin") return;
    const db = getClientDb();
    const q = query(
      collection(db, "collaborators"),
      where("status", "==", "pending"),
    );
    const unsub = onSnapshot(
      q,
      (snap) => setCount(snap.size),
      () => setCount(0),
    );
    return unsub;
  }, [role]);

  return role === "admin" ? count : 0;
}
