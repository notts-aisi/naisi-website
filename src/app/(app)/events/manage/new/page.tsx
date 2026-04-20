import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/firebase/session";
import NewEventForm from "@/features/events/NewEventForm";

export default async function NewEventPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const canDraft = user.role === "admin" || user.permissions.draftEvent;
  if (!canDraft) redirect("/events/manage");
  return <NewEventForm />;
}
