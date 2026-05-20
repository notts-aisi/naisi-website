"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { getVerifiedEmails } from "@/lib/firestore/notifications";

/**
 * Live map of `uid -> set of that user's currently-verified email
 * addresses`, derived from the `users` collection via `getVerifiedEmails`.
 *
 * The Subscriptions admin tab uses this to spot STALE rows: a
 * member-audience subscription row whose email is no longer one the owning
 * user has verified (their uni email changed, was un-verified, or a guest
 * row was once claimed onto the account). No write path removes those
 * rows, so they linger and show up as ghost email columns. Cross-checking
 * each member row's email against this index is how the table flags them.
 *
 * Admin-only; Firestore rules enforce read access on `users`.
 */
export function useVerifiedEmails() {
  const [verifiedByUid, setVerifiedByUid] = useState<Map<string, Set<string>>>(
    new Map(),
  );
  const [verifiedLoaded, setVerifiedLoaded] = useState(false);

  useEffect(() => {
    const db = getClientDb();
    const unsub = onSnapshot(
      collection(db, "users"),
      (snap) => {
        const next = new Map<string, Set<string>>();
        for (const d of snap.docs) {
          const data = d.data();
          const emails = getVerifiedEmails({
            email: typeof data.email === "string" ? data.email : null,
            profile: (data.profile ?? {}) as {
              universityEmail?: unknown;
              uniEmailVerifiedAt?: unknown;
            },
          });
          next.set(d.id, new Set(emails.map((e) => e.email)));
        }
        setVerifiedByUid(next);
        setVerifiedLoaded(true);
      },
      // On error, leave verifiedLoaded false so stale detection stays
      // off. The table still renders (it doesn't gate on this hook).
      // Marking it loaded here would leave an empty index, which would
      // false-flag every member row as stale.
      (err) =>
        console.error("[useVerifiedEmails] users snapshot failed", err),
    );
    return unsub;
  }, []);

  return { verifiedByUid, verifiedLoaded };
}
