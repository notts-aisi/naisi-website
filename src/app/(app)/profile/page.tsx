import Badge from "@/components/ui/Badge";
import { MaintenanceNotice } from "@/features/admin/AdminLockUI";
import ProfileForm from "@/features/profile/ProfileForm";
import { PushSettings, PushTopics } from "@/features/pwa/PushSettings";

export default function ProfilePage() {
  return (
    <div>
      <div style={{ marginBottom: "var(--space-8)" }}>
        <Badge tone="accent">Profile</Badge>
        <h1 style={{ marginTop: "var(--space-3)" }}>Your profile</h1>
        <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-2)" }}>
          Keep your details current, and control how we reach you by email.
        </p>
      </div>
      <ProfileForm />
      {/* Per-device push opt-in. Renders nothing until VAPID keys are
          provisioned (docs/pwa.md) and on browsers without push. */}
      <PushSettings />
      {/* The account-level topic switches. A SIBLING of the card above, never
          nested inside it: they are about the account, so they must survive
          every environment and browser where the per-device card renders
          nothing. */}
      <PushTopics />
      {/* Shows a notice while an admin is editing this member's details. */}
      <MaintenanceNotice />
    </div>
  );
}
