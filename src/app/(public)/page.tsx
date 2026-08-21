import Link from "next/link";
import SubscribeForm from "@/components/SubscribeForm";
import ReadingListAccordion from "@/components/ReadingListAccordion";
import { READING_LISTS } from "@/content/readingLists";
import HeroAtmosphere from "./HeroAtmosphere";
import HeroScrollChevron from "./HeroScrollChevron";
import HeroEyebrow from "./HeroEyebrow";
import HeroLede from "./HeroLede";
import MobileTagline from "./MobileTagline";
import TypedHeadline from "./TypedHeadline";
import HeroCTAs from "./HeroCTAs";
import AwardBadge from "./AwardBadge";
import CredentialsBar from "./CredentialsBar";
import StatsRow from "./StatsRow";
import UpcomingEvents from "./UpcomingEvents";
import InstagramCarousel from "./InstagramCarousel";
import ElsewhereRow from "./ElsewhereRow";
import CommitteePreview from "./CommitteePreview";
import FellowQuotes from "./FellowQuotes";
import Reveal from "./Reveal";
import styles from "./landing.module.css";

/**
 * Public landing page. Sections, top to bottom:
 *
 *  1. Hero — full-viewport (100vh). Layered neural-network atmosphere
 *     (HeroFieldZeroBase: Big Bang layer entry, 2 inference rounds, cool
 *     pink palette, breathing, subtle cursor attractor) under the NAISI
 *     lockup + typed headline + UONSU Activities Awards 2026 "Newcomer
 *     of the Year" badge. Nothing else lives in the hero — lede + CTAs
 *     are the next beat.
 *  2. Intro — lede paragraph + magnetic 3D CTAs (revealed via blur-rise
 *     on scroll). This used to sit inside the hero.
 *  3. By the numbers — stats strip with rolodex digit-roll.
 *  4. About. Brief framing + a reference to the three tiers below.
 *  5. "Three ways in." Socials (with £6 SU link inline), fellowships
 *     (with BlueDot logo inline), research incubator.
 *  6. Upcoming. Next 2-3 public events pulled from Firestore. Hides if empty.
 *  7. Where to start — curated reading lists.
 *  8. From the gram — Instagram carousel (hides if empty content file).
 *  9. Elsewhere — Substack / Linktree / SU membership link cards.
 * 10. Run by students — committee preview (dev-only via env flag).
 * 11. Stay in touch — subscribe form.
 */

// Re-render at most every 10 min so event deletes / edits propagate without
// a redeploy. UpcomingEvents reads from Firestore at render time; without
// this, the homepage is statically built at deploy time and goes stale.
export const revalidate = 600;

export default function Landing() {
  return (
    <>
      <section className={styles.hero} data-hero="true">
        <HeroAtmosphere />
        <div className={`container ${styles.heroInner}`}>
          <HeroEyebrow />
          <MobileTagline />
          <TypedHeadline prefix="Make AI go well." accent="From Nottingham." startDelayMs={500} />
          <div className={styles.heroBadge}>
            <div className={styles.heroAwardDesktop}>
              <AwardBadge />
            </div>
            <HeroScrollChevron />
          </div>
        </div>
      </section>

      <Reveal variant="blur-rise" as="section" className={styles.introSection}>
        <div className={`container ${styles.introInner}`}>
          <HeroLede>
            NAISI is the AI safety student group at the University of
            Nottingham. We run a termly fellowship in two streams, technical
            alignment and AI governance, and meet weekly to read, discuss,
            and build.
          </HeroLede>
          <HeroCTAs />
        </div>
      </Reveal>

      <StatsRow />

      <CredentialsBar />

      <Reveal variant="blur-rise" as="section" className={styles.aboutSection}>
        <div className={`container ${styles.aboutInner}`}>
          <p className={styles.aboutLead}>
            AI Safety is one of the biggest challenges and opportunities of
            the next decade. The field benefits from people of all
            backgrounds, and there are no strict prerequisites to join.
          </p>
          <p className={styles.aboutBody}>
            New members are{" "}
            <Link href="/register" className={styles.inlineLink}>
              approved by the committee
            </Link>{" "}
            before joining the community properly. There are three ways to
            take part, stacked by commitment: the socials, the fellowships,
            and the research incubator.
          </p>
        </div>
      </Reveal>

      <section className={styles.tiersSection}>
        <div className={`container ${styles.tiersInner}`}>
          <header className={styles.tiersHead}>
            <Reveal variant="mask-wipe" as="h2" className={styles.tiersTitle}>
              Three ways to get involved.
            </Reveal>
            <p className={styles.tiersBlurb}>
              Pick the level of commitment that matches where you are.
              You&apos;re welcome wherever you feel you fit best.{" "}
              <a
                href="https://www.instagram.com/notts.ai.safety/"
                target="_blank"
                rel="noreferrer noopener"
                className={styles.inlineLink}
              >
                Message us
              </a>{" "}
              if you want to come to an event but you&apos;re unsure.
            </p>
          </header>
          <Reveal variant="tilt-in" staggerChildren staggerMs={110} as="ol" className={styles.tiersList}>
            <li className={styles.tier}>
              <div className={styles.tierHead}>
                <h3 className={styles.tierName}>Socials</h3>
                <span className={styles.tierMeta}>
                  No experience needed
                </span>
              </div>
              <p className={styles.tierBody}>
                Game nights, movie nights with AI-safety-flavoured
                discussion built around the films, basic jailbreaking
                demonstrations, the occasional themed quiz. The point is
                to meet the people in this fast-growing community before
                you commit to anything else.
              </p>
              <p className={styles.tierBody}>
                Your first social is on us. Come once before you decide
                whether to{" "}
                <a
                  href="https://su.nottingham.ac.uk/activities/view/NottsAISafety"
                  target="_blank"
                  rel="noreferrer noopener"
                  className={styles.inlineLink}
                >
                  become an SU member (£6/year)
                </a>{" "}
                — that&apos;s what gets you onto the official roster.
              </p>
              <p className={styles.tierFooter}>
                <Link href="/events" className={styles.inlineLink}>
                  See what&apos;s on →
                </Link>
              </p>
            </li>

            <li className={styles.tier}>
              <div className={styles.tierHead}>
                <h3 className={styles.tierName}>Fellowships</h3>
                <span className={styles.tierMeta}>
                  ~7 weeks · ~5 hrs/week · certificate
                </span>
              </div>
              <p className={styles.tierBody}>
                Two parallel cohorts, technical and governance, built on{" "}
                <a
                  href="https://aisafetyfundamentals.com/"
                  target="_blank"
                  rel="noreferrer noopener"
                  className={styles.inlineLink}
                >
                  BlueDot Impact&apos;s curriculum
                </a>{" "}
                and our own additions. Small groups, AI-safety-trained
                facilitators, new content each week, around three hours of
                reading and two hours in person. No prior experience
                required. You leave with a certificate and a finished
                project to point at.
              </p>
              <FellowQuotes />
              <p className={styles.tierFooter}>
                <Link href="/courses" className={styles.inlineLink}>
                  Apply for the next cohort →
                </Link>
              </p>
            </li>

            <li className={styles.tier}>
              <div className={styles.tierHead}>
                <h3 className={styles.tierName}>Research incubator</h3>
                <span className={styles.tierMeta}>
                  Upcoming · fellowship-completer level
                </span>
              </div>
              <p className={styles.tierBody}>
                For anyone who has finished a fellowship (ours or
                comparable self-study). A guided research incubator:
                ideation, grouping, supervised research, writeup. The aim
                is to walk you from &ldquo;I have a question&rdquo; to a piece of work
                you could submit, present, or build on. We&apos;re standing
                this up; expressions of interest are welcome now.
              </p>
            </li>
          </Reveal>
        </div>
      </section>

      <UpcomingEvents />

      <section className={styles.readingSection}>
        <div className={`container ${styles.readingInner}`}>
          <header className={styles.readingHead}>
            <Reveal variant="mask-wipe" as="h2" className={styles.readingTitle}>
              Where to start.
            </Reveal>
            <p className={styles.readingBlurb}>
              Four short reading lists curated by the committee. The same
              things we hand a new fellow on day one. Tap a list to expand
              its contents. Pick the one that matches what you actually
              want to know.
            </p>
          </header>
          <Reveal variant="fade-rise" staggerChildren staggerMs={80} as="div" className={styles.readingStack}>
            {READING_LISTS.map((list) => (
              <ReadingListAccordion key={list.slug} list={list} />
            ))}
          </Reveal>
        </div>
      </section>

      <InstagramCarousel />

      <ElsewhereRow />

      <CommitteePreview />

      <Reveal variant="blur-rise" as="section" id="stay-in-touch" className={styles.digestSection}>
        <div className={`container ${styles.digestInner}`}>
          <div className={styles.digestPitch}>
            <h2 className={styles.digestTitle}>Stay in touch.</h2>
            <p className={styles.digestBody}>
              <strong>Our newsletter.</strong> A short round-up of what&apos;s
              moving in AI safety. Three to five things worth your time
              and any opportunities you can act on. Funding, fellowships,
              calls for papers, jobs. Written by the committee.
            </p>
            <p className={styles.digestBody}>
              <strong>Event announcements.</strong> A heads-up when we run
              something on campus, separately from the newsletter. Tick
              the boxes for whichever you want.
            </p>
          </div>
          <div className={styles.digestForm}>
            <SubscribeForm
              source="homepage"
              channels={[
                {
                  id: "newsletter",
                  label: "Our newsletter",
                  description:
                    "A round-up of what's moving in AI safety. Low frequency.",
                  defaultChecked: true,
                },
                {
                  id: "events",
                  label: "Event announcements",
                  description:
                    "We email when we publish a new event. Low frequency.",
                  defaultChecked: false,
                },
              ]}
            />
          </div>
        </div>
      </Reveal>
    </>
  );
}
