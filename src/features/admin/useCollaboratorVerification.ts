"use client";

import { useEffect, useState } from "react";

/**
 * Live email-verification status for the given collaborator uids, read from
 * Firebase Auth via an admin server route. The client can't read another user's
 * auth record, and `emailVerified` is Auth-owned (not mirrored onto the doc), so
 * this is the single source of truth for the admin Collaborators list. Costs
 * zero Firestore reads. Re-fetches only when the set of uids actually changes.
 *
 * Returns a uid→verified map. A uid absent from the map = not yet loaded
 * (callers should treat `=== false` as "unverified", `undefined` as "unknown").
 */
export function useCollaboratorVerification(uids: string[]): Record<string, boolean> {
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  // Primitive signature so the effect runs only when the uid set changes, not
  // on every render (collaborators.map() makes a fresh array each time).
  const key = [...uids].sort().join(",");

  useEffect(() => {
    // No uids (list empty or still loading) → nothing to fetch; the empty-state
    // renders no cards, so a leftover map is never read.
    if (!key) return;
    let cancelled = false;
    fetch("/api/admin/collaborators/verification", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uids: key.split(",") }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        setVerified((body.verified as Record<string, boolean>) ?? {});
      })
      .catch(() => {
        /* leave prior state; cards fall back to "unknown" (no tag) */
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return verified;
}
