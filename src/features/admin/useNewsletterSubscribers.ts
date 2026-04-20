"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeUser, type UserDoc } from "@/lib/firestore/users";

export type Subscriber = {
  uid: string;
  displayName: string;
  gmailEmail: string | null;
  universityEmail: string | null;
  deliverToGmail: boolean;
  deliverToUniEmail: boolean;
  role: UserDoc["role"];
};

function toSubscriber(u: UserDoc): Subscriber {
  const nl = u.profile?.newsletter;
  return {
    uid: u.uid,
    displayName: u.profile?.preferredName ?? u.displayName ?? u.email ?? "Unnamed",
    gmailEmail: u.email,
    universityEmail: u.profile?.universityEmail ?? null,
    deliverToGmail: Boolean(nl?.deliverToGmail),
    deliverToUniEmail: Boolean(nl?.deliverToUniEmail),
    role: u.role,
  };
}

/**
 * Live list of users with `profile.newsletter.subscribed == true`.
 * Read is scoped by Firestore rules (admin-only pages already gate access).
 */
export function useNewsletterSubscribers() {
  const [subs, setSubs] = useState<Subscriber[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const db = getClientDb();
    const q = query(
      collection(db, "users"),
      where("profile.newsletter.subscribed", "==", true),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs
          .map((d) => toSubscriber(normalizeUser(d.id, d.data())))
          .sort((a, b) => a.displayName.localeCompare(b.displayName));
        setSubs(rows);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, []);

  return { subs, loading, error };
}
