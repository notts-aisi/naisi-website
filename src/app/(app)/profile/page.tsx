import Badge from "@/components/ui/Badge";
import { MaintenanceNotice } from "@/features/admin/AdminLockUI";
import ProfileForm from "@/features/profile/ProfileForm";
import { PushSettings } from "@/features/pwa/PushSettings";
import { PushDeviceProvider } from "@/features/pwa/pushDevice";

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
      {/* One probe of this browser's push state, read by both children: the
          form's Push column (disabled with a hint when this device cannot
          receive anything) and the per-device card below it. */}
      <PushDeviceProvider>
        <ProfileForm />
        {/* Per-device push opt-in. Renders nothing until VAPID keys are
            provisioned (docs/pwa.md) and on browsers without push. The
            account-level answers are the grid's Push column, inside the form
            above, so nothing here is unreachable for want of the right
            hardware. */}
        <PushSettings />
      </PushDeviceProvider>
      {/* Shows a notice while an admin is editing this member's details. */}
      <MaintenanceNotice />
    </div>
  );
}
