import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import styles from "./landing.module.css";

const HIGHLIGHTS = [
  {
    title: "Courses",
    body: "A termly fellowship built on BlueDot Impact's AI Safety Fundamentals. Readings, weekly facilitated discussion, a final project.",
  },
  {
    title: "Weekly digest",
    body: "A short Sunday email on what actually moved in AI safety that week. The TL;DR, the things worth reading, and any opportunities you can act on.",
  },
  {
    title: "Projects",
    body: "Technical alignment, governance, and outreach work led by the committee. The kind of thing that earns you something real to point at.",
  },
];

export default function Landing() {
  return (
    <>
      <section className={styles.hero}>
        <div className={`container ${styles.heroInner}`}>
          <Badge tone="accent">University of Nottingham · AI Safety</Badge>
          <h1 className={styles.title}>
            Make AI go well.{" "}
            <span className={styles.titleAccent}>From Nottingham.</span>
          </h1>
          <p className={styles.lede}>
            NAISI is the AI safety student group at the University of
            Nottingham. We run a termly fellowship, ship technical and
            governance projects, and write about what&apos;s actually
            happening in the field.
          </p>
          <div className={styles.ctas}>
            <Link href="/register" className={styles.primaryCta}>
              Join us
            </Link>
            <Link href="/resources" className={styles.secondaryCta}>
              Explore resources →
            </Link>
          </div>
          <div className={styles.heroArt} aria-hidden="true">
            <BrandMark size={120} showWordmark={false} />
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className="container">
          <div className={styles.sectionHead}>
            <Badge>What we do</Badge>
            <h2>Three things, done seriously.</h2>
          </div>
          <div className={styles.grid}>
            {HIGHLIGHTS.map((h) => (
              <Card key={h.title} padding="lg">
                <h3 style={{ marginBottom: "var(--space-3)" }}>{h.title}</h3>
                <p style={{ color: "var(--color-text-muted)" }}>{h.body}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.sectionAlt}>
        <div className="container">
          <div className={styles.cta}>
            <div>
              <h2>Want in?</h2>
              <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-3)" }}>
                Sign up and we&apos;ll loop you into the next cohort.
              </p>
            </div>
            <Link href="/register" className={styles.primaryCta}>
              Join us →
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
