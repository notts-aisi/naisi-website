"use client";

import { useEffect, useState } from "react";
import type { Role } from "@/lib/firebase/session";
import type { UserDoc } from "@/lib/firestore/users";

type RosterMember = {
  uid: string;
  displayName: string;
  photoURL: string | null;
  role: string;
};

/**
 * Member-facing replacement for `useMembers()` on /tasks and /dashboard.
 *
 * Plain members and non-SU committee cannot read the `users` collection, so
 * they fetch /api/members/roster: names of the people on tasks they are
 * already on. Returns the same `{ users, loading, error }` shape as
 * `useMembers()` so the task components consume it unchanged.
 *
 * One fetch on mount. If someone is added to one of the viewer's tasks
 * mid-session, their name resolves after a reload; the task UI degrades
 * gracefully to the UID until then.
 */
export function useTaskRoster() {
  const [users, setUsers] = useState<UserDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/members/roster");
        if (!res.ok) throw new Error(`Roster fetch failed (${res.status})`);
        const body = (await res.json()) as { members?: RosterMember[] };
        if (cancelled) return;
        setUsers(
          (body.members ?? []).map((m) => ({
            uid: m.uid,
            email: null,
            displayName: m.displayName,
            photoURL: m.photoURL,
            role: (m.role as Role) ?? "member",
          })),
        );
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { users, loading, error };
}
