"use client";

import { collection, getDocs } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { normalizeUser, type UserDoc } from "@/lib/firestore/users";
import {
  normaliseNotifications,
  wantsCategory,
} from "@/lib/firestore/notifications";
import { useOneShotList } from "./adminList";

export type Subscriber = {
  uid: string;
  displayName: string;
  gmailEmail: string | null;
  universityEmail: string | null;
  deliverToGmail: boolean;
  deliverToUniEmail: boolean;
  wantsEvents: boolean;
  role: UserDoc["role"];
};

function toSubscriber(u: UserDoc): Subscriber {
  const prefs = normaliseNotifications(u.profile ?? {});
  return {
    uid: u.uid,
    displayName: u.profile?.preferredName ?? u.displayName ?? u.email ?? "Unnamed",
    gmailEmail: u.email,
    universityEmail: u.profile?.universityEmail ?? null,
    deliverToGmail: prefs.channels.gmail,
    deliverToUniEmail: prefs.channels.uniEmail,
    wantsEvents: prefs.categories.events,
    role: u.role,
  };
}

/**
 * Live list of users subscribed to the newsletter category. We read all users
 * and filter in-memory via `normaliseNotifications()` because a Firestore
 * `where()` on either the legacy or the new shape would miss users on the
 * other during the migration window. Member-list sizes on NAISI are small;
 * if this ever gets expensive, dedicated indexes + `where()` on the new
 * shape become the answer (after all users migrate).
 */
export function useNewsletterSubscribers() {
  const { items, loading, refreshing, error, reload } = useOneShotList<Subscriber>(
    async () => {
      const db = getClientDb();
      const snap = await getDocs(collection(db, "users"));
      return snap.docs
        .map((d) => normalizeUser(d.id, d.data()))
        .filter((u) => wantsCategory(normaliseNotifications(u.profile ?? {}), "newsletter"))
        .map(toSubscriber)
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
    },
    "newsletter",
  );

  return { subs: items, loading, refreshing, error, reload };
}
