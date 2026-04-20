import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import styles from "./landing.module.css";

const HIGHLIGHTS = [
  {
    title: "Courses",
    body: "Run termly, based on BlueDot Impact's AI Safety Fundamentals. Readings, facilitated discussion, and a final project.",
  },
  {
    title: "Weekly digest",
    body: "A short summary of what's happening in AI and AI safety — key developments, TL;DR, and opportunities for students.",
  },
  {
    title: "Projects",
    body: "Committee-led projects across technical alignment, governance, and outreach. Real work you can put on a CV.",
  },
];

export default function Landing() {
  return (
    <>
      <section className={styles.hero}>
        <div className={`container ${styles.heroInner}`}>
          <Badge tone="accent">University of Nottingham · AI Safety</Badge>
          <h1 className={styles.title}>
            Make AI go well —{" "}
            <span className={styles.titleAccent}>from Nottingham.</span>
          </h1>
          <p className={styles.lede}>
            NAISI is a student community building technical and governance
            understanding of how to make increasingly capable AI systems safe,
            beneficial, and trustworthy.
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
              <h2>Want to get involved?</h2>
              <p style={{ color: "var(--color-text-muted)", marginTop: "var(--space-3)" }}>
                Sign up for an account and we&apos;ll get you into the next cohort.
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
