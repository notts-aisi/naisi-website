import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/firebase/session";
import NewDraftForm from "@/features/newsletter/NewDraftForm";

export default async function NewDraftPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const canDraft = user.role === "admin" || user.permissions.draftNewsletter;
  if (!canDraft) redirect("/newsletter");
  return <NewDraftForm />;
}
