import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/firebase/session";

export default async function CommitteeLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // The committee task board shows every committee-visibility task and the
  // full member roster (assignee picker), so it is limited to SU-recognised
  // committee + admins. Non-SU committee work from My Work, where they see
  // only the tasks they have been added to.
  const isSuCommittee = user.role === "committee" && user.suRecognised;
  if (user.role !== "admin" && !isSuCommittee) {
    redirect("/dashboard");
  }
  return <>{children}</>;
}
