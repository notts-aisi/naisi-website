"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import type { Role } from "@/lib/firebase/session";

export type UniEmailHolder = {
  uid: string;
  displayName: string;
  role: Role;
  /** True iff this account has verified control of the address. */
  verified: boolean;
};

/**
 * Index of every account that has a university email on its profile, keyed
 * by the lowercased address. Admin-only — used on the approvals page to
 * flag when a pending applicant's uni email collides with an existing
 * account. A uni email belongs to at most one NAISI account, so any key
 * with more than one holder is a duplicate the admin should resolve.
 *
 * Scans the whole `users` collection (small at NAISI scale). Separate from
 * `useApprovals`, which only streams pending users — duplicate detection
 * needs every account, including approved ones.
 */
export function useUniEmailIndex(): Map<string, UniEmailHolder[]> {
  const [index, setIndex] = useState<Map<string, UniEmailHolder[]>>(new Map());

  useEffect(() => {
    const db = getClientDb();
    const unsub = onSnapshot(collection(db, "users"), (snap) => {
      const map = new Map<string, UniEmailHolder[]>();
      for (const d of snap.docs) {
        const data = d.data();
        const profile = (data.profile ?? {}) as Record<string, unknown>;
        const raw = profile.universityEmail;
        if (typeof raw !== "string" || !raw.trim()) continue;
        const key = raw.trim().toLowerCase();
        const list = map.get(key) ?? [];
        list.push({
          uid: d.id,
          displayName:
            typeof data.displayName === "string" ? data.displayName : "",
          role: (typeof data.role === "string" ? data.role : "pending") as Role,
          verified: Boolean(profile.uniEmailVerifiedAt),
        });
        map.set(key, list);
      }
      setIndex(map);
    });
    return unsub;
  }, []);

  return index;
}
