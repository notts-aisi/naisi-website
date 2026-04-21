"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase/client";
import type { Role } from "@/lib/firebase/session";
import type { UserPermissions } from "@/lib/firestore/users";

type AuthState = {
  user: User | null;
  role: Role | null;
  permissions: UserPermissions;
  loading: boolean;
};

const AuthContext = createContext<AuthState>({
  user: null,
  role: null,
  permissions: {},
  loading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [permissions, setPermissions] = useState<UserPermissions>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const auth = getClientAuth();
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (!u) {
        setRole(null);
        setPermissions({});
      }
      // Auth state is resolved — UI can render regardless of whether the
      // Firestore user-doc snapshot has arrived yet. Previously we waited
      // for onSnapshot to fire, which left the header stuck on "loading"
      // forever when a cached Firebase Auth user couldn't reach Firestore
      // (stale token, rules change, etc).
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    const db = getClientDb();
    const ref = doc(db, "users", user.uid);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        // No doc at all = user signed in but hasn't completed /register.
        // Leave role as null so pages can distinguish "needs to register"
        // from "registered and pending approval".
        const data = snap.exists() ? snap.data() : null;
        setRole(data ? ((data.role as Role) ?? "pending") : null);
        const raw = (data?.permissions as Record<string, unknown> | undefined) ?? {};
        setPermissions({
          draftNewsletter: Boolean(raw.draftNewsletter),
          approveNewsletter: Boolean(raw.approveNewsletter),
          draftEvent: Boolean(raw.draftEvent),
          approveEvent: Boolean(raw.approveEvent),
        });
      },
      () => {
        // Snapshot errored (permission-denied, offline, etc). Clear role so
        // gated UI bails out to the sign-in path rather than trusting stale
        // state, and let AuthProvider's server-session-aware callers re-auth.
        setRole(null);
        setPermissions({});
      },
    );
    return unsub;
  }, [user]);

  const value = useMemo(
    () => ({ user, role, permissions, loading }),
    [user, role, permissions, loading],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
