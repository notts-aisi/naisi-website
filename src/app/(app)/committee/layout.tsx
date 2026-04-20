import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/firebase/session";

export default async function CommitteeLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "committee" && user.role !== "admin") {
    redirect("/dashboard");
  }
  return <>{children}</>;
}
