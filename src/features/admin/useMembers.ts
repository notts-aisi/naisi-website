"use client";

import { collection, getDocs, query, where } from "firebase/firestore";
import { bypass } from "@/lib/devBypass";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeUser, type UserDoc } from "@/lib/firestore/users";
import { useOneShotList } from "./adminList";

export function useMembers({ includeRejected = false }: { includeRejected?: boolean } = {}) {
  const { items, loading, refreshing, error, reload } = useOneShotList<UserDoc>(
    async () => {
      const fixture = bypass.getUsers();
      if (fixture !== null) return fixture;
      const db = getClientDb();
      const roles = includeRejected
        ? ["member", "committee", "admin", "rejected"]
        : ["member", "committee", "admin"];
      // No orderBy here — Firestore excludes docs missing the ordered field,
      // which hid legacy/malformed users. Sort client-side instead.
      const q = query(collection(db, "users"), where("role", "in", roles));
      const snap = await getDocs(q);
      const rows = snap.docs.map((d) => normalizeUser(d.id, d.data()));
      rows.sort((a, b) =>
        (a.displayName ?? a.email ?? "").localeCompare(b.displayName ?? b.email ?? ""),
      );
      return rows;
    },
    `members:${includeRejected}`,
  );

  return { users: items, loading, refreshing, error, reload };
}
