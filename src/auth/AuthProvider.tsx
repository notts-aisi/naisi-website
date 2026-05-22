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
import { instance, watchdog } from "@/lib/devMonitor";

type AuthState = {
  user: User | null;
  role: Role | null;
  permissions: UserPermissions;
  /** True only for committee members the SU formally recognises (admin-set). */
  suRecognised: boolean;
  loading: boolean;
};

const AuthContext = createContext<AuthState>({
  user: null,
  role: null,
  permissions: {},
  suRecognised: false,
  loading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [permissions, setPermissions] = useState<UserPermissions>({});
  const [suRecognised, setSuRecognised] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // [monitor] Per-instance log so a remount (e.g. React strict double-
    // invocation in dev, or a navigation that tears down + rebuilds the
    // provider) doesn't smear into the previous instance's log lines.
    const log = instance("authProvider");
    log.mark("mounted");

    // Hard ceiling on the loading state. Firebase Auth's init reads from
    // IndexedDB; a wedged IDB (lock contention, private-mode quirks,
    // corrupted db) can leave onAuthStateChanged unfired indefinitely,
    // which used to leave the header stuck on the loading branch forever.
    // 3s covers the happy path on cold cache; beyond that we assume the
    // SDK is wedged and render as signed-out.
    const failsafe = setTimeout(() => {
      log.warn("failsafe fired (onAuthStateChanged never ran in 3s)");
      setLoading(false);
    }, 3000);

    const clearAuthWatchdog = watchdog(`${log.id} onAuthStateChanged first fire`, 3000);
    const auth = getClientAuth();
    let fired = false;
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!fired) {
        fired = true;
        clearAuthWatchdog();
      }
      log.mark("onAuthStateChanged", { uid: u?.uid ?? null, email: u?.email ?? null });
      clearTimeout(failsafe);
      setUser(u);
      if (!u) {
        setRole(null);
        setPermissions({});
        setSuRecognised(false);
      }
      // Auth state is resolved — UI can render regardless of whether the
      // Firestore user-doc snapshot has arrived yet. Previously we waited
      // for onSnapshot to fire, which left the header stuck on "loading"
      // forever when a cached Firebase Auth user couldn't reach Firestore
      // (stale token, rules change, etc).
      setLoading(false);
    });

    return () => {
      log.mark("unmounted");
      clearTimeout(failsafe);
      clearAuthWatchdog();
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    const log = instance("userDocSnap");
    log.mark("attaching", { uid: user.uid });
    const clearSnapWatchdog = watchdog(`${log.id} first snapshot`, 5000);
    let firstSnapshot = true;
    const db = getClientDb();
    const ref = doc(db, "users", user.uid);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (firstSnapshot) {
          firstSnapshot = false;
          clearSnapWatchdog();
        }
        log.mark("snapshot", {
          exists: snap.exists(),
          fromCache: snap.metadata.fromCache,
          hasPendingWrites: snap.metadata.hasPendingWrites,
          role: snap.exists() ? (snap.data().role as Role | undefined) ?? null : null,
        });
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
        setSuRecognised(Boolean(data?.suRecognised));
      },
      (err) => {
        log.warn("snapshot error", err);
        // Snapshot errored (permission-denied, offline, etc). Clear role so
        // gated UI bails out to the sign-in path rather than trusting stale
        // state, and let AuthProvider's server-session-aware callers re-auth.
        setRole(null);
        setPermissions({});
        setSuRecognised(false);
      },
    );
    return () => {
      log.mark("detaching");
      clearSnapWatchdog();
      unsub();
    };
  }, [user]);

  const value = useMemo(
    () => ({ user, role, permissions, suRecognised, loading }),
    [user, role, permissions, suRecognised, loading],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
