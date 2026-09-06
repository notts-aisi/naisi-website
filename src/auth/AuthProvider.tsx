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
import { bypass } from "@/lib/devBypass";
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
  /** Server-owned: true while this member reviews or decides at least one
   *  admission round. Written only by the round roles route. It draws the
   *  Admissions nav entry; the round's own arrays remain the authority on
   *  what may actually be read. */
  admissionsReviewer: boolean;
  loading: boolean;
  /**
   * True only once Firebase Auth's onAuthStateChanged has ACTUALLY fired.
   *
   * `loading` is not a substitute. It also flips false when the 3s failsafe
   * below gives up on a wedged SDK, and in that case `user` is null because
   * we could not find out, not because the visitor is signed out. Anything
   * that would take a destructive action on "signed out" (clearing a session
   * cookie, redirecting to /login) has to gate on this instead, or it will
   * act on a slow client as though it were a signed-out one.
   */
  authResolved: boolean;
};

const AuthContext = createContext<AuthState>({
  user: null,
  role: null,
  permissions: {},
  suRecognised: false,
  admissionsReviewer: false,
  loading: true,
  authResolved: false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [permissions, setPermissions] = useState<UserPermissions>({});
  const [suRecognised, setSuRecognised] = useState(false);
  const [admissionsReviewer, setAdmissionsReviewer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [authResolved, setAuthResolved] = useState(false);

  useEffect(() => {
    // [monitor] Per-instance log so a remount (e.g. React strict double-
    // invocation in dev, or a navigation that tears down + rebuilds the
    // provider) doesn't smear into the previous instance's log lines.
    const log = instance("authProvider");
    log.mark("mounted");

    // Apply either the dev-bypass admin (if active locally) or signed-out
    // state. Used both as the no-real-user branch of the Firebase Auth
    // listener and as the failsafe fallback when the SDK wedges.
    function applyBypassOrSignedOut() {
      const bypassUser = bypass.getAuthUser();
      const snapshot = bypass.getAuthSnapshot();
      if (bypassUser && snapshot) {
        setUser(bypassUser);
        setRole(snapshot.role);
        setPermissions(snapshot.permissions);
        setSuRecognised(snapshot.suRecognised);
        // The bypass fixture has no admissions role of its own: a bypass
        // admin already sees the Admissions entry through `role`, and a
        // bypass member is not on any round.
        setAdmissionsReviewer(false);
      } else {
        setUser(null);
        setRole(null);
        setPermissions({});
        setSuRecognised(false);
        setAdmissionsReviewer(false);
      }
    }

    // Hard ceiling on the loading state. Firebase Auth's init reads from
    // IndexedDB; a wedged IDB (lock contention, private-mode quirks,
    // corrupted db) can leave onAuthStateChanged unfired indefinitely,
    // which used to leave the header stuck on the loading branch forever.
    // 3s covers the happy path on cold cache; beyond that we assume the
    // SDK is wedged and render with whatever the bypass tells us (or
    // signed-out if the bypass is off).
    const failsafe = setTimeout(() => {
      log.warn("failsafe fired (onAuthStateChanged never ran in 3s)");
      applyBypassOrSignedOut();
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
      // The listener really ran, so a null `u` from here is a trustworthy
      // "signed out" rather than the failsafe's "could not tell".
      setAuthResolved(true);
      if (u) {
        // Real signed-in user; bypass cedes. The user-doc snapshot effect
        // below will fill in role/permissions/suRecognised from Firestore.
        setUser(u);
      } else {
        // No real user. Fall back to the dev bypass if active, otherwise
        // render as signed-out.
        applyBypassOrSignedOut();
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
    // The dev-bypass admin doesn't exist in Firestore, so a snapshot would
    // just hit permission-denied. Skip it; the bypass already supplied
    // role/permissions/suRecognised in applyBypassOrSignedOut above.
    const bypassUser = bypass.getAuthUser();
    if (bypassUser && user.uid === bypassUser.uid) return;
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
          draftCourse: Boolean(raw.draftCourse),
          approveCourse: Boolean(raw.approveCourse),
          manageMembership: Boolean(raw.manageMembership),
          circulateWorksheet: Boolean(raw.circulateWorksheet),
        });
        setSuRecognised(Boolean(data?.suRecognised));
        setAdmissionsReviewer(Boolean(data?.admissionsReviewer));
      },
      (err) => {
        log.warn("snapshot error", err);
        // Snapshot errored (permission-denied, offline, etc). Clear role so
        // gated UI bails out to the sign-in path rather than trusting stale
        // state, and let AuthProvider's server-session-aware callers re-auth.
        setRole(null);
        setPermissions({});
        setSuRecognised(false);
        setAdmissionsReviewer(false);
      },
    );
    return () => {
      log.mark("detaching");
      clearSnapWatchdog();
      unsub();
    };
  }, [user]);

  const value = useMemo(
    () => ({
      user,
      role,
      permissions,
      suRecognised,
      admissionsReviewer,
      loading,
      authResolved,
    }),
    [user, role, permissions, suRecognised, admissionsReviewer, loading, authResolved],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
