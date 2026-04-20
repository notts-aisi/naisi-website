import type { Metadata } from "next";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { getPublicMembers, type PublicMember } from "@/features/members/fetchMembers";

export const metadata: Metadata = {
  title: "Members",
  description:
    "The committee running the Nottingham AI Safety Initiative — who we are, what we work on, and how to reach us.",
};

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const members = await getPublicMembers();

  return (
    <section style={{ padding: "var(--space-16) 0" }}>
      <div className="container">
        <div style={{ maxWidth: "40rem", marginBottom: "var(--space-10)" }}>
          <Badge>The team</Badge>
          <h1 style={{ marginTop: "var(--space-4)" }}>Committee & contributors</h1>
          <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-3)" }}>
            A group of Nottingham students running courses, projects, and outreach on AI safety.
            If you want to get involved, the easiest way is{" "}
            <a style={{ color: "var(--color-accent)", textDecoration: "underline" }} href="/register">
              joining the next cohort
            </a>
            .
          </p>
        </div>

        {members.length === 0 ? (
          <Card padding="lg">
            <p style={{ color: "var(--color-text-muted)" }}>
              We&apos;re not publishing the committee directory yet. If you want to reach us, the
              best way is through the{" "}
              <a style={{ color: "var(--color-accent)", textDecoration: "underline" }} href="/register">
                registration form
              </a>
              .
            </p>
          </Card>
        ) : (
          <div
            style={{
              display: "grid",
              gap: "var(--space-4)",
              gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))",
            }}
          >
            {members.map((m) => (
              <MemberCard key={m.uid} member={m} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function MemberCard({ member }: { member: PublicMember }) {
  return (
    <Card padding="lg">
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
        <div
          aria-hidden
          style={{
            width: 56,
            height: 56,
            borderRadius: "var(--radius-pill)",
            background: member.photoURL
              ? `center/cover no-repeat url(${member.photoURL})`
              : "var(--color-surface-hover)",
            border: "1px solid var(--color-border)",
            flexShrink: 0,
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{member.displayName}</div>
          <div style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
            {member.title ?? (member.role === "admin" ? "President" : "Committee")}
          </div>
        </div>
      </div>
      {member.bio && (
        <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-4)" }}>{member.bio}</p>
      )}
    </Card>
  );
}
