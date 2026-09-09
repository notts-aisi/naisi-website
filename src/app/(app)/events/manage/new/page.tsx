import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/firebase/session";
import { canDraftEvent } from "@/lib/firestore/users";
import NewEventForm from "@/features/events/NewEventForm";

export default async function NewEventPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const canDraft = canDraftEvent(user);
  if (!canDraft) redirect("/events/manage");
  return <NewEventForm />;
}
