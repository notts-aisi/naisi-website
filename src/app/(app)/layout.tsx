import { redirect } from "next/navigation";
import { getCurrentCollaborator, getCurrentUser } from "@/lib/firebase/session";
import { getImpersonator, markerIsLive } from "@/lib/firebase/impersonation";
import AppShell from "@/layout/AppShell";
import { SessionSanityGuard } from "@/auth/SessionSanityGuard";
import { LastRouteTracker } from "@/features/pwa/LastRouteTracker";
import { CURRENT_POLICY_VERSION } from "@/lib/legal/policies";

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  if (!user) redirect("/login");
  if (user.role === "pending") {
    // A signed-in account with no member role is either a uni applicant
    // awaiting approval or an external collaborator (who has no users doc and
    // so defaults to 'pending' here). Only collaborators have a collaborators
    // doc — send them to their own area instead of the member pending page.
    // The extra read only runs for pending sessions, never for members/admins.
    const collaborator = await getCurrentCollaborator();
    redirect(collaborator ? "/collaborator" : "/pending-approval");
  }
  if (user.role === "rejected") redirect("/");

  // View-as marker, read BEFORE the re-consent gate because the gate has to
  // know about it (see below). Only counts as a session when the marker's
  // actorUid differs from the live uid: a matching one is a stale cookie (the
  // admin re-signed in as themselves) and the banner would lie. `markerIsLive`
  // is that comparison, shared with the admin-tree gate and the write guard so
  // all three agree on what counts as a session.
  const marker = await getImpersonator();
  const viewingAs = markerIsLive(marker, user.uid);

  /*
    RE-CONSENT GATE. Lives here, on the shared authed layout, so that every
    signed-in account reaching any page of the member area is asked once when
    the policy version moves. It used to sit on (app)/dashboard/layout.tsx,
    which was true to a narrower claim than the one the policy page makes: a
    member who never opens /dashboard (a straight link to /tasks, an installed
    app relaunching onto its last route, an email link into a course week) was
    never asked at all, so "we will ask you to accept the updated policy" was
    not what the code did. The old placement's stated reason was not yanking
    somebody away mid-task; the answer to that is to move a policy version at
    a quiet moment, which is a scheduling decision, not a code one.

    Placed AFTER the role redirects on purpose, so it inherits them rather
    than competing with them: an account with no member role still goes to
    /pending-approval or /collaborator first, and /re-consent is never reached
    by a session that has no doc to stamp. Any future change that lets a
    role-pending account fall through into the shell (an applicant holding a
    course enrolment, say) must let it fall through to HERE as well, not
    return early above it, or that account is inside the product and has never
    been asked. /re-consent admits a pending account that has a users doc for
    exactly that reason.

    DEPLOYED BUILDS ONLY, kept verbatim from the dashboard gate. Under local
    `npm run dev` (NODE_ENV !== "production") the gate is skipped so it never
    interrupts local work, which also sidesteps the dev-auth bypass, whose
    synthetic session has no real doc or cookie to re-consent with. It does
    run on dev.naisi.uk, which builds in production mode, so verify it there
    and not on localhost.

    Per-request: getCurrentUser reads the live user doc, so accepting clears
    the gate on the very next navigation, and a member who never signs out is
    still caught the next time they open any authed page.

    NEVER DURING A VIEW-AS SESSION. Accepting a policy is a write recorded on
    the member's own document, and inside view-as Firestore records it as the
    member: an admin clicking through a member's view would stamp a consent
    that member never gave, which is the one write on this site whose whole
    value is that the person themselves made it. So the gate is skipped while
    a marker is live. The admin sees the member's pages as they are; the
    member is asked the next time they sign in themselves.
  */
  if (
    process.env.NODE_ENV === "production" &&
    !viewingAs &&
    user.policyVersion !== CURRENT_POLICY_VERSION
  ) {
    redirect("/re-consent");
  }

  // Banner input for the shell, from the marker read above.
  const impersonation =
    viewingAs && marker
      ? {
          actorName: marker.actorName,
          targetName: user.displayName ?? user.email ?? user.uid,
          targetRole: user.role,
        }
      : null;

  return (
    <>
      {/*
        Reaching this layout proves getCurrentUser() accepted the session
        cookie. The guard watches for the client half being absent anyway and
        repairs it. Mounted as a SIBLING of AppShell rather than a child so it
        still runs while the shell is showing its loading skeleton, which is
        exactly the state a stale session gets stuck in.
      */}
      <SessionSanityGuard />
      {/* Records the route for installed-app relaunch restoration. Mounted
          here rather than the root layout ON PURPOSE: only authed-area
          paths should ever be recorded. See lastRoute.ts. */}
      <LastRouteTracker />
      <AppShell impersonation={impersonation}>{children}</AppShell>
    </>
  );
}
