"use client";

import { collection, getDocs, query, where } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeUser, type UserDoc } from "@/lib/firestore/users";
import { useOneShotList } from "./adminList";

export function useApprovals() {
  const { items, loading, refreshing, error, reload } = useOneShotList<UserDoc>(
    async () => {
      const db = getClientDb();
      // No orderBy on createdAt — Firestore would drop docs missing that field.
      // Sort client-side so legacy users still show up.
      const q = query(collection(db, "users"), where("role", "==", "pending"));
      const snap = await getDocs(q);
      const rows = snap.docs.map((d) => normalizeUser(d.id, d.data()));
      rows.sort((a, b) => {
        const ta = a.createdAt?.getTime() ?? 0;
        const tb = b.createdAt?.getTime() ?? 0;
        return tb - ta;
      });
      return rows;
    },
    "approvals",
  );

  return { users: items, loading, refreshing, error, reload };
}
