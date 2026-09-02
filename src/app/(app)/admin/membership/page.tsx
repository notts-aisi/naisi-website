import { getCurrentUser } from "@/lib/firebase/session";
import MembershipConsole from "@/features/admin/MembershipConsole";

/**
 * The membership console. A thin server wrapper: like the admissions index,
 * every read here is a ROUTE call rather than client-direct Firestore, because
 * `membershipPeriods` is `allow read, write: if false`.
 *
 * `canSetCurrent` also comes back on the list payload, so the button and the
 * route that refuses it cannot drift apart; the role is read here only to
 * render the page's own explanation of that split before the first fetch
 * lands.
 */
export default async function MembershipAdminPage() {
  const user = await getCurrentUser();
  return <MembershipConsole isAdmin={user?.role === "admin"} />;
}
