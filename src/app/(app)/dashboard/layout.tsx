import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/firebase/session";
import { CURRENT_POLICY_VERSION } from "@/lib/legal/policies";

/**
 * Re-consent gate, scoped to the dashboard. When the Terms or Privacy Policy
 * change, CURRENT_POLICY_VERSION moves and every member's stored `policyVersion`
 * goes stale; we then require them to re-accept (or leave) before continuing.
 *
 * Deliberately placed on the DASHBOARD layout, not the shared (app) layout, so a
 * member who is mid-task on /tasks, /events, /newsletter etc. is NOT yanked away.
 * The check runs only when they land on /dashboard — which is where a fresh
 * sign-in lands and where the hero "Dashboard" button goes — so it catches them
 * at the natural entry point without interrupting active work. It is per-request
 * (getCurrentUser reads the live user doc), so it fires even for a member who
 * never signed out and simply navigated back to the dashboard.
 *
 * The role gate (login / pending / rejected redirects) already happened in the
 * parent (app)/layout.tsx, so by here the user is a member/committee/admin.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  // The re-consent gate runs only in DEPLOYED builds (dev.naisi.uk + prod, where
  // NODE_ENV === "production"). It is skipped under local `npm run dev` so it never
  // interrupts local development — which also sidesteps the dev-auth bypass (whose
  // synthetic session has no real doc/cookie to re-consent with). Verify the gate
  // on dev.naisi.uk, not on localhost.
  if (
    process.env.NODE_ENV === "production" &&
    user &&
    user.policyVersion !== CURRENT_POLICY_VERSION
  ) {
    redirect("/re-consent");
  }
  return <>{children}</>;
}
