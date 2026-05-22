import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/firebase/session";
import { getImpersonator } from "@/lib/firebase/impersonation";
import AppShell from "@/layout/AppShell";

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  if (!user) redirect("/login");
  if (user.role === "pending") redirect("/pending-approval");
  if (user.role === "rejected") redirect("/");

  // View-as banner. Only render when the impersonator marker is BOTH present
  // AND really annotates a borrowed session: if the marker's actorUid matches
  // the live user.uid the cookie is stale (admin re-signed in as themselves
  // without the marker being cleared) and the banner would lie.
  const marker = await getImpersonator();
  const impersonation =
    marker && marker.actorUid !== user.uid
      ? {
          actorName: marker.actorName,
          targetName: user.displayName ?? user.email ?? user.uid,
          targetRole: user.role,
        }
      : null;

  return <AppShell impersonation={impersonation}>{children}</AppShell>;
}
