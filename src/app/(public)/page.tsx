import Link from "next/link";
import Script from "next/script";
import BrandMark from "@/components/BrandMark";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import SubscribeForm from "@/components/SubscribeForm";
import styles from "./landing.module.css";

/**
 * Public landing page for non-logged-in visitors. Sections, top to bottom:
 *  1. Hero (kept from prior design, lede tightened to set up streams).
 *  2. Two streams, one fellowship (replaces the "Three things, done seriously"
 *     3-up cards). Technical + Governance with concrete copy per stream.
 *  3. Events nod with inline events-mailing-list signup.
 *  4. Instagram strip via Behold (third-party widget). Static fallback when
 *     `NEXT_PUBLIC_BEHOLD_FEED_ID` is unset, so the section is honest about
 *     its degraded state during initial setup.
 *  5. Sunday digest section with the newsletter signup. The hero anchor
 *     `#digest` lands here.
 *
 * Atmosphere rhythm: hero (full radial gradients) → streams (light tint +
 * subtle radial) → events (plain background) → IG (plain) → digest
 * (alternating section + warm radial). Static gradients only — animation
 * here would lean into SaaS-template territory.
 */

const STREAMS = [
  {
    key: "technical" as const,
    badge: "Technical",
    badgeTone: "accent" as const,
    title: "Technical",
    subtitle: "Get hands-on with the open problems in alignment.",
    read: "AI Safety Fundamentals: Alignment. Anthropic, DeepMind, OpenAI safety publications. Recent interpretability and evals papers chosen weekly.",
    build:
      "A final project, scoped to your skill level. A small interpretability replication, an evals harness, a writeup making one paper accessible to non-experts. Whatever shape you want, the committee helps you scope it.",
    forWho:
      "Students comfortable with code or the maths, or willing to push themselves to get there. CS, maths, physics, engineering. No specific background is required.",
  },
  {
    key: "governance" as const,
    badge: "Governance",
    badgeTone: "neutral" as const,
    title: "Governance",
    subtitle: "Work through how AI gets regulated, deployed, and held accountable.",
    read: "AI Safety Fundamentals: Governance. UK AI Safety Institute publications. EU AI Act, US executive orders, frontier-model evaluations and red-teaming literature.",
    build:
      "A short policy memo, a stakeholder analysis, or a writeup of one open governance question for a non-expert audience. Final piece is yours to keep and point at.",
    forWho:
      "Students from law, politics, philosophy, economics, business. And anyone from a technical background who wants to understand the policy side.",
  },
];

export default function Landing() {
  const beholdFeedId = process.env.NEXT_PUBLIC_BEHOLD_FEED_ID;

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
            Nottingham. We run a termly fellowship in two streams, technical
            alignment and AI governance, and meet weekly to read, discuss,
            and build.
          </p>
          <div className={styles.ctas}>
            <Link href="/register" className={styles.primaryCta}>
              Join us
            </Link>
            <Link href="#digest" className={styles.secondaryCta}>
              Read the digest →
            </Link>
          </div>
          <div className={styles.heroArt} aria-hidden="true">
            <BrandMark size={120} showWordmark={false} />
          </div>
        </div>
      </section>

      <section className={styles.streamsSection}>
        <div className="container">
          <div className={styles.sectionHead}>
            <Badge>Fellowship</Badge>
            <h2>Two streams, one fellowship.</h2>
            <p className={styles.sectionSub}>
              Termly. Reading-group format. Built on BlueDot Impact&apos;s AI
              Safety Fundamentals curriculum.
            </p>
          </div>
          <div className={styles.streamsGrid}>
            {STREAMS.map((s) => (
              <Card key={s.key} padding="lg" className={styles.streamCard}>
                <div className={styles.streamHead}>
                  <Badge tone={s.badgeTone}>{s.badge}</Badge>
                  <h3 className={styles.streamTitle}>{s.title}</h3>
                  <p className={styles.streamSubtitle}>{s.subtitle}</p>
                </div>
                <div className={styles.streamGroup}>
                  <p className={styles.streamGroupLabel}>What you read</p>
                  <p className={styles.streamGroupBody}>{s.read}</p>
                </div>
                <div className={styles.streamGroup}>
                  <p className={styles.streamGroupLabel}>What you build</p>
                  <p className={styles.streamGroupBody}>{s.build}</p>
                </div>
                <div className={styles.streamGroup}>
                  <p className={styles.streamGroupLabel}>Who it&apos;s for</p>
                  <p className={styles.streamGroupBody}>{s.forWho}</p>
                </div>
              </Card>
            ))}
          </div>
          <p className={styles.streamsFooter}>
            Applications open at the start of each term.{" "}
            <Link href="/register" className={styles.inlineLink}>
              Apply for the next cohort →
            </Link>
          </p>
        </div>
      </section>

      <section className={styles.proseSection}>
        <div className="container">
          <div className={styles.sectionHead}>
            <Badge>On campus</Badge>
            <h2>We run things you can show up to.</h2>
          </div>
          <div className={styles.proseInner}>
            <p>
              Talks, socials, reading sessions, the occasional workshop. AI
              safety is a young field that mostly exists online. Events are
              how we make it real on campus, and how new people meet us
              without committing to the fellowship first.
            </p>
            <p>
              <Link href="/events" className={styles.inlineLink}>
                See what&apos;s on →
              </Link>
            </p>
            <div className={styles.proseSignup}>
              <p className={styles.proseSignupHeading}>
                Want a heads-up when we run something? Drop your email. We
                only message about events.
              </p>
              <SubscribeForm
                channel="events"
                hint="Different list from the Sunday digest. You can subscribe to either or both."
              />
            </div>
          </div>
        </div>
      </section>

      <section className={styles.igSection}>
        <div className="container">
          <div className={styles.sectionHead}>
            <Badge>Lately</Badge>
            <h2>What we&apos;ve been up to.</h2>
            <p className={styles.sectionSub}>
              Instagram,{" "}
              <a
                href="https://www.instagram.com/nottsaiai/"
                target="_blank"
                rel="noopener noreferrer"
                className={styles.inlineLink}
              >
                @nottsaiai
              </a>
              .
            </p>
          </div>
          <div className={styles.igWrap}>
            {beholdFeedId ? (
              // Behold replaces the inner contents on hydration. The
              // fallback inside is what renders if the script fails to
              // load (network blocked, ad-blocker, slow connection).
              <div data-feed-id={beholdFeedId}>
                <BeholdFallback />
              </div>
            ) : (
              <BeholdFallback />
            )}
          </div>
        </div>
        {beholdFeedId ? (
          <Script
            src="https://w.behold.so/widget.js"
            type="module"
            strategy="afterInteractive"
          />
        ) : null}
      </section>

      <section id="digest" className={styles.digestSection}>
        <div className={`container ${styles.digestInner}`}>
          <div className={styles.digestPitch}>
            <Badge tone="accent">Sunday digest</Badge>
            <h2>A short email on what actually moved this week.</h2>
            <p className={styles.digestBody}>
              One email, Sunday morning. The TL;DR on AI safety this week,
              three to five things worth your time, and any opportunities
              you can act on. Funding, fellowships, calls for papers, jobs.
              Written by the committee. No tracking pixels, no growth
              hacks.
            </p>
          </div>
          <div className={styles.digestForm}>
            <SubscribeForm
              channel="newsletter"
              layout="full"
              hint="Different list from event announcements. You can subscribe to either or both."
            />
          </div>
        </div>
      </section>
    </>
  );
}

function BeholdFallback() {
  return (
    <div className={styles.igFallback}>
      <p className={styles.igFallbackHeading}>
        Follow{" "}
        <a
          href="https://www.instagram.com/nottsaiai/"
          target="_blank"
          rel="noopener noreferrer"
          className={styles.inlineLink}
        >
          @nottsaiai
        </a>{" "}
        on Instagram →
      </p>
      <p className={styles.igFallbackBody}>
        Photos from talks, socials, and reading sessions land there first.
      </p>
    </div>
  );
}
