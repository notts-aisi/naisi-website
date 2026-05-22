"use client";

import { signInWithCustomToken, signOut as fbSignOut } from "firebase/auth";
import { getClientAuth } from "@/lib/firebase/client";

/**
 * Admin "view as" client flow (full impersonation).
 *
 * Start: server mints a Firebase custom token for the target, we sign in
 * client-side as the target, then provision a target session cookie via
 * /api/auth/session — the same endpoint normal Google sign-in uses. A full
 * page navigation forces (app)/layout.tsx to re-evaluate getCurrentUser()
 * with the new __session cookie, so the sidebar and any server-rendered
 * gating repaint as the target.
 *
 * Why full nav and not router.push: AuthProvider's Firebase Auth listener
 * + Firestore user-doc snapshot are torn down and rebuilt by the
 * signInWithCustomToken swap. router.push leaves the React tree in a
 * half-mutated state where useAuth() can lag. window.location is the only
 * reliably-clean reset.
 */
export async function startImpersonation(targetUid: string): Promise<void> {
  const res = await fetch("/api/admin/impersonate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: targetUid }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `View-as failed (${res.status})`);
  }
  const { customToken } = (await res.json()) as { customToken: string };

  const auth = getClientAuth();
  const cred = await signInWithCustomToken(auth, customToken);
  const idToken = await cred.user.getIdToken();

  const sessionRes = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!sessionRes.ok) {
    throw new Error("Failed to provision impersonation session");
  }

  window.location.href = "/dashboard";
}

/**
 * End the current view-as session.
 *
 * Server closes the audit doc and clears both cookies. The admin's own
 * Firebase Auth client state was replaced by signInWithCustomToken on
 * start — there is no way to "restore" the previous SDK session — so we
 * sign out of Firebase Auth client-side and redirect to /login. The
 * `from=impersonation-exit` flag is informational for any login-page
 * messaging that wants to explain the re-auth.
 */
export async function exitImpersonation(): Promise<void> {
  const res = await fetch("/api/admin/impersonate/exit", { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Exit failed (${res.status})`);
  }
  await fbSignOut(getClientAuth());
  window.location.href = "/login?from=impersonation-exit";
}
