"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { bypass } from "@/lib/devBypass";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeUser, type UserDoc } from "@/lib/firestore/users";

export function useMembers({ includeRejected = false }: { includeRejected?: boolean } = {}) {
  const [users, setUsers] = useState<UserDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const fixture = bypass.getUsers();
    if (fixture !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUsers(fixture);
      setLoading(false);
      return;
    }
    const db = getClientDb();
    const roles = includeRejected
      ? ["member", "committee", "admin", "rejected"]
      : ["member", "committee", "admin"];
    // No orderBy here — Firestore excludes docs missing the ordered field,
    // which hid legacy/malformed users. Sort client-side instead.
    const q = query(collection(db, "users"), where("role", "in", roles));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => normalizeUser(d.id, d.data()));
        rows.sort((a, b) =>
          (a.displayName ?? a.email ?? "").localeCompare(b.displayName ?? b.email ?? ""),
        );
        setUsers(rows);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [includeRejected]);

  return { users, loading, error };
}
