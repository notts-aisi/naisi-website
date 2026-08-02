import { redirect } from "next/navigation";
import { getCurrentCollaborator } from "@/lib/firebase/session";
import { CURRENT_POLICY_VERSION } from "@/lib/legal/policies";
import CollaboratorTopBar from "./CollaboratorTopBar";

/**
 * Limited authed shell for external collaborators. NOT the member `AppShell`
 * (no sidebar / committee nav) — collaborators only see their own application.
 * Server-gated on `getCurrentCollaborator()`; a non-collaborator (member or no
 * session) is bounced to /login. The proxy already requires a session cookie on
 * `/collaborator/*`; this is the real gate.
 */
export default async function CollaboratorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const collaborator = await getCurrentCollaborator();
  if (!collaborator) redirect("/login");
  // Re-consent gate: collaborators have a single home, so gating here is their
  // natural entry point (the member equivalent lives on the dashboard layout).
  // Deployed builds only (skipped under local `npm run dev`), matching the member
  // gate — verify on dev.naisi.uk.
  if (
    process.env.NODE_ENV === "production" &&
    collaborator.policyVersion !== CURRENT_POLICY_VERSION
  ) {
    redirect("/re-consent");
  }

  return (
    <div style={{ minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
      <CollaboratorTopBar name={collaborator.fullName || collaborator.email || ""} />
      <main
        style={{
          flex: 1,
          display: "flex",
          justifyContent: "center",
          padding: "var(--space-6) var(--space-4)",
        }}
      >
        <div style={{ width: "100%", maxWidth: "44rem" }}>{children}</div>
      </main>
    </div>
  );
}
