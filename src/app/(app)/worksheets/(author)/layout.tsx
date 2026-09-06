import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/firebase/session";

/**
 * The authoring half of /worksheets: the library, the editor and a
 * circulation's staff view.
 *
 * EVERY COMMITTEE MEMBER DRAFTS, SU-RECOGNISED OR NOT, which is why this is not
 * the committee task board's gate one directory over. That board shows every
 * committee task and the full member roster, so it is limited to the people the
 * Students' Union recognises; a worksheet is a document somebody writes, and
 * nothing on these pages reads member PII (the recipient picker is a route that
 * answers with uids, names and photos, and names elsewhere come from the task
 * roster). Sending one IS the act worth naming somebody for, and that is
 * `permissions.circulateWorksheet`, checked at the Circulate button and enforced
 * by the route behind it, not here.
 *
 * The respond page deliberately sits OUTSIDE this group: a recipient may be any
 * member, and gating their own worksheet behind a committee role would lock them
 * out of the thing they were sent.
 */
export default async function WorksheetsAuthorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin" && user.role !== "committee") {
    redirect("/dashboard");
  }
  return <>{children}</>;
}
