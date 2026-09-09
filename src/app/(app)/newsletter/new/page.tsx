import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/firebase/session";
import { canDraftNewsletter } from "@/lib/firestore/users";
import NewDraftForm from "@/features/newsletter/NewDraftForm";

export default async function NewDraftPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const canDraft = canDraftNewsletter(user);
  if (!canDraft) redirect("/newsletter");
  return <NewDraftForm />;
}
