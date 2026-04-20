"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeDraft, type NewsletterDraft } from "@/lib/firestore/newsletterDrafts";

/**
 * All drafts the current user is allowed to read (gated by Firestore rules:
 * drafter permission OR approver permission OR admin).
 * Sorted client-side by updatedAt desc to keep sparse-field rules in mind.
 */
export function useDrafts() {
  const [drafts, setDrafts] = useState<NewsletterDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const db = getClientDb();
    const q = query(collection(db, "newsletterDrafts"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs.map((d) => normalizeDraft(d.id, d.data()));
        rows.sort((a, b) => {
          const av = a.updatedAt?.getTime() ?? 0;
          const bv = b.updatedAt?.getTime() ?? 0;
          return bv - av;
        });
        setDrafts(rows);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, []);

  return { drafts, loading, error };
}
