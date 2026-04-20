import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/firebase/session";
import AppShell from "@/layout/AppShell";

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  if (!user) redirect("/login");
  if (user.role === "pending") redirect("/pending-approval");
  if (user.role === "rejected") redirect("/");

  return <AppShell>{children}</AppShell>;
}
