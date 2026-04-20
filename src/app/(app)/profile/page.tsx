import Badge from "@/components/ui/Badge";
import ProfileForm from "@/features/profile/ProfileForm";

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
    </div>
  );
}
