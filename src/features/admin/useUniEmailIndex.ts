"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
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
 * For the given university emails (the ones on the pending applications being
 * shown), find every account that holds each address, keyed by the lowercased
 * address. A uni email belongs to at most one NAISI account, so any key with
 * more than one holder is a duplicate the admin should resolve.
 *
 * Targeted by design: it queries only `where('profile.universityEmail','in', …)`
 * for the handful of addresses on screen (batched in groups of 30, the Firestore
 * `in` limit) with a one-shot getDocs — NOT an onSnapshot over the whole `users`
 * collection. The old full-scan made *opening* the approvals page O(all users)
 * and shipped every member's PII to the client; this reads only the matching
 * docs.
 *
 * Caveat: the match is exact on the stored value (lowercased here), so a
 * duplicate stored with different casing won't be caught. Stored uni emails are
 * effectively always lowercase, and a full case-fold would need a normalised
 * field (out of scope); the exact match covers the real cases.
 */
const EMPTY_INDEX: Map<string, UniEmailHolder[]> = new Map();

export function useUniEmailIndex(emails: string[]): Map<string, UniEmailHolder[]> {
  const [index, setIndex] = useState<Map<string, UniEmailHolder[]>>(EMPTY_INDEX);

  // Stable, deduped, lowercased list — and a primitive key so the effect only
  // re-runs when the actual set of addresses changes, not on every render.
  const wanted = useMemo(() => {
    const set = new Set(
      emails.map((e) => e.trim().toLowerCase()).filter(Boolean),
    );
    return Array.from(set).sort();
  }, [emails]);
  const key = wanted.join("|");

  useEffect(() => {
    if (wanted.length === 0) return; // nothing to query; return falls back to EMPTY_INDEX
    let cancelled = false;
    const db = getClientDb();
    (async () => {
      const map = new Map<string, UniEmailHolder[]>();
      for (let i = 0; i < wanted.length; i += 30) {
        const batch = wanted.slice(i, i + 30);
        const q = query(
          collection(db, "users"),
          where("profile.universityEmail", "in", batch),
        );
        const snap = await getDocs(q);
        for (const d of snap.docs) {
          const data = d.data();
          const profile = (data.profile ?? {}) as Record<string, unknown>;
          const raw = profile.universityEmail;
          if (typeof raw !== "string" || !raw.trim()) continue;
          const k = raw.trim().toLowerCase();
          const list = map.get(k) ?? [];
          list.push({
            uid: d.id,
            displayName: typeof data.displayName === "string" ? data.displayName : "",
            role: (typeof data.role === "string" ? data.role : "pending") as Role,
            verified: Boolean(profile.uniEmailVerifiedAt),
          });
          map.set(k, list);
        }
      }
      if (!cancelled) setIndex(map);
    })().catch(() => {
      if (!cancelled) setIndex(new Map());
    });
    return () => {
      cancelled = true;
    };
    // `key` is the stable primitive derived from `wanted`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // When there are no addresses to check, return the stable empty map rather
  // than whatever the last query left in state.
  return wanted.length === 0 ? EMPTY_INDEX : index;
}
