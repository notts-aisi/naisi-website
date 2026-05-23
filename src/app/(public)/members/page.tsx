import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { getPublicMembers, type PublicMember } from "@/features/members/fetchMembers";
import styles from "./members.module.css";

export const metadata: Metadata = {
  title: "Members",
  description:
    "The committee running the Nottingham AI Safety Initiative. Who we are, what we work on, and how to reach us.",
};

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const members = await getPublicMembers();

  return (
    <section className={styles.page}>
      <div className="container">
        <div className={styles.intro}>
          <Badge>The team</Badge>
          <h1 className={styles.heading}>Committee & contributors</h1>
          <p className={styles.lede}>
            A group of Nottingham students running courses, projects, and outreach on AI safety.
            If you want to get involved, the easiest way is{" "}
            <a className={styles.inlineLink} href="/register">
              joining the next cohort
            </a>
            .
          </p>
        </div>

        {members.length === 0 ? (
          <Card padding="lg">
            <p className={styles.empty}>
              We&apos;re not publishing the committee directory yet. If you want to reach us, the
              best way is through the{" "}
              <a className={styles.inlineLink} href="/register">
                registration form
              </a>
              .
            </p>
          </Card>
        ) : (
          <div className={styles.grid}>
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
  const photoStyle = member.photoURL
    ? ({ "--member-photo": `url(${member.photoURL})` } as CSSProperties)
    : undefined;

  return (
    <Card padding="lg">
      <div className={styles.cardHead}>
        <div aria-hidden className={styles.photo} style={photoStyle} />
        <div className={styles.identity}>
          <div className={styles.name}>{member.displayName}</div>
          <div className={styles.role}>
            {member.title ?? (member.role === "admin" ? "President" : "Committee")}
          </div>
        </div>
      </div>
      {member.bio && <p className={styles.bio}>{member.bio}</p>}
    </Card>
  );
}
