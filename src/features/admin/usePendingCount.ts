"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { useAuth } from "@/auth/AuthProvider";

/**
 * Real-time count of users with role == 'pending'.
 * Only subscribes when the current user is an admin — non-admins get 0.
 */
export function usePendingCount() {
  const { role } = useAuth();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (role !== "admin") return;
    const db = getClientDb();
    const q = query(collection(db, "users"), where("role", "==", "pending"));
    const unsub = onSnapshot(
      q,
      (snap) => setCount(snap.size),
      () => setCount(0),
    );
    return unsub;
  }, [role]);

  // Non-admins never subscribe; mask any count left over from a prior admin
  // session so they always read 0.
  return role === "admin" ? count : 0;
}
