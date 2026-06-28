import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { bypass } from "@/lib/devBypass";
import { getCurrentCollaborator, getCurrentUser } from "@/lib/firebase/session";
import { CURRENT_POLICY_VERSION, currentPolicy } from "@/lib/legal/policies";
import ReConsentActions from "./ReConsentActions";

export const metadata: Metadata = {
  title: "Review our updated policies — NAISI",
  robots: { index: false, follow: false },
};

const SUPPORT_EMAIL = "ai-safety@uonsu.com";

/**
 * Re-consent gate landing. Reached from the dashboard layout (members) or the
 * collaborator layout (collaborators) when a user's stored policyVersion is
 * behind CURRENT_POLICY_VERSION. Lives OUTSIDE the (app) / collaborator shells so
 * those gates don't loop, and renders only the gate (no nav chrome to slip past).
 */
export default async function ReConsentPage() {
  // The local dev bypass has no real account to re-consent — never park it here.
  // No-op in deployed builds (committed stub has isActive: false).
  if (bypass.isActive) redirect("/dashboard");

  // Collaborators are detected first (they have no users doc; getCurrentUser
  // would still resolve a default member shape for them).
  const collaborator = await getCurrentCollaborator();
  const user = collaborator ? null : await getCurrentUser();
  if (!collaborator && !user) redirect("/login");

  // Only ACTIVE members and collaborators are the re-consent audience. A member
  // session whose role is pending/rejected — including an unfinished signup with
  // no profile doc, which resolves to a default role of "pending" — isn't, and
  // would otherwise land on a dead-end member gate (accept has no doc to stamp).
  // Send them where the normal layouts would, so /re-consent is never a trap.
  if (!collaborator && user) {
    if (user.role === "pending") redirect("/pending-approval");
    if (user.role === "rejected") redirect("/");
  }

  const isMember = !collaborator;
  const policyVersion = collaborator ? collaborator.policyVersion : user!.policyVersion;
  const homeHref = collaborator ? "/collaborator" : "/dashboard";

  // Already current (accepted in another tab, or navigated here directly) — don't
  // trap an up-to-date user on the gate.
  if (policyVersion === CURRENT_POLICY_VERSION) redirect(homeHref);

  const privacy = currentPolicy("privacy");

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-6) var(--space-4)",
      }}
    >
      <Card padding="lg" style={{ width: "100%", maxWidth: "38rem" }}>
        <Badge>Updated</Badge>
        <h1 style={{ fontSize: "var(--text-2xl)", margin: "var(--space-3) 0 var(--space-2)" }}>
          We&apos;ve updated our Privacy Policy
        </h1>
        <p style={{ color: "var(--color-text-muted)", margin: 0, lineHeight: 1.6 }}>
          To keep using your NAISI account, please review and accept our updated
          Privacy Policy (version {privacy.version}, {privacy.lastUpdated}).
        </p>
        <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-4)", lineHeight: 1.6 }}>
          <strong style={{ color: "var(--color-text)" }}>What changed:</strong> we&apos;ve
          clarified how long content you contributed — committee tasks, comments,
          file attachments, and event RSVPs — may be kept after your account is
          deleted before it is removed or anonymised.
        </p>
        <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-4)", lineHeight: 1.6 }}>
          Read the full{" "}
          <Link href="/privacy" target="_blank" style={{ color: "var(--color-accent)" }}>
            Privacy Policy
          </Link>{" "}
          ·{" "}
          <Link href="/privacy/versions" target="_blank" style={{ color: "var(--color-accent)" }}>
            version history
          </Link>{" "}
          ·{" "}
          <Link href="/terms" target="_blank" style={{ color: "var(--color-accent)" }}>
            Terms of Use
          </Link>
          .
        </p>

        <ReConsentActions
          isMember={isMember}
          homeHref={homeHref}
          supportEmail={SUPPORT_EMAIL}
        />
      </Card>
    </main>
  );
}
