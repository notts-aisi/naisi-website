import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/firebase/session";

export default async function EventsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // The events area is open to the whole committee, who plan and collaborate
  // here. Creating a new event still needs the draftEvent permission, and the
  // attendee list still needs SU recognition - both gated further in.
  const allowed =
    user.role === "admin" ||
    user.role === "committee" ||
    user.permissions.draftEvent ||
    user.permissions.approveEvent;
  if (!allowed) redirect("/dashboard");

  return (
    <div>
      <div style={{ marginBottom: "var(--space-8)" }}>
        <div
          style={{
            color: "var(--color-text-muted)",
            fontSize: "var(--text-sm)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: "var(--space-2)",
          }}
        >
          Events
        </div>
        <h1 style={{ fontSize: "var(--text-3xl)" }}>Drafts & publishing</h1>
      </div>
      {children}
    </div>
  );
}
