import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import SubscribeForm from "@/components/SubscribeForm";
import ReadingListAccordion from "@/components/ReadingListAccordion";
import { READING_LISTS } from "@/content/readingLists";
import styles from "./landing.module.css";

/**
 * Public landing page. Editorial-first: prose paragraphs and curated lists,
 * not Badge-eyebrow-h2-grid cards. Sections, top to bottom:
 *
 *  1. Hero. Brand statement + two CTAs.
 *  2. About. Brief framing + a reference to the three tiers below.
 *  3. "Three ways in." Socials, fellowships, research pathway. Each tier
 *     names its commitment level and links to the right next step.
 *  4. "Where to start" reading lists. Four curated lists, collapsible,
 *     closed by default. The page's substance for self-starters.
 *  5. "Stay in touch" signup. One form, name + email + checkboxes for the
 *     two lists (Sunday digest and event announcements).
 */

export default function Landing() {
  return (
    <>
      <section className={styles.hero}>
        <div className={`container ${styles.heroInner}`}>
          <p className={styles.eyebrow}>
            University of Nottingham · AI Safety
          </p>
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
              Apply to join
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

      <section className={styles.aboutSection}>
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
            before joining the community properly. There are three ways in,
            stacked by commitment: the socials, the fellowships, and the
            research pathway.
          </p>
        </div>
      </section>

      <section className={styles.tiersSection}>
        <div className={`container ${styles.tiersInner}`}>
          <header className={styles.tiersHead}>
            <h2 className={styles.tiersTitle}>Three ways in.</h2>
            <p className={styles.tiersBlurb}>
              Pick the level of commitment that matches where you are. Each
              tier builds on the one before it, but the entry-level ones
              stand on their own too.
            </p>
          </header>
          <ol className={styles.tiersList}>
            <li className={styles.tier}>
              <div className={styles.tierHead}>
                <span className={styles.tierIndex} aria-hidden="true">
                  01
                </span>
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
                you commit to anything else. Show up, eat something, leave.
              </p>
              <p className={styles.tierFooter}>
                <Link href="/events" className={styles.inlineLink}>
                  See what&apos;s on →
                </Link>
              </p>
            </li>

            <li className={styles.tier}>
              <div className={styles.tierHead}>
                <span className={styles.tierIndex} aria-hidden="true">
                  02
                </span>
                <h3 className={styles.tierName}>Fellowships</h3>
                <span className={styles.tierMeta}>
                  Six to seven weeks · ~5 hrs/week · certificate
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
              <p className={styles.tierFooter}>
                <Link href="/register" className={styles.inlineLink}>
                  Apply for the next cohort →
                </Link>
              </p>
            </li>

            <li className={styles.tier}>
              <div className={styles.tierHead}>
                <span className={styles.tierIndex} aria-hidden="true">
                  03
                </span>
                <h3 className={styles.tierName}>Research pathway</h3>
                <span className={styles.tierMeta}>
                  Upcoming · fellowship-completer level
                </span>
              </div>
              <p className={styles.tierBody}>
                For anyone who has finished a fellowship (ours or
                comparable self-study). A guided research pipeline:
                ideation, grouping, supervised research, writeup. The aim
                is to walk you from &ldquo;I have a question&rdquo; to a piece of work
                you could submit, present, or build on. We&apos;re standing
                this up; expressions of interest are welcome now.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section className={styles.readingSection}>
        <div className={`container ${styles.readingInner}`}>
          <header className={styles.readingHead}>
            <h2 className={styles.readingTitle}>Where to start.</h2>
            <p className={styles.readingBlurb}>
              Four short reading lists curated by the committee. The same
              things we hand a new fellow on day one. Tap a list to expand
              its contents. Pick the one that matches what you actually
              want to know.
            </p>
          </header>
          <div className={styles.readingStack}>
            {READING_LISTS.map((list, i) => (
              <ReadingListAccordion key={list.slug} list={list} index={i + 1} />
            ))}
          </div>
        </div>
      </section>

      <section id="digest" className={styles.digestSection}>
        <div className={`container ${styles.digestInner}`}>
          <div className={styles.digestPitch}>
            <h2 className={styles.digestTitle}>Stay in touch.</h2>
            <p className={styles.digestBody}>
              <strong>Sunday digest.</strong> One short email each Sunday
              morning. The TL;DR on AI safety this week, three to five
              things worth your time, and any opportunities you can act on.
              Funding, fellowships, calls for papers, jobs. Written by the
              committee.
            </p>
            <p className={styles.digestBody}>
              <strong>Event announcements.</strong> A heads-up when we run
              something on campus, separately from the digest. Tick the
              boxes for whichever you want.
            </p>
          </div>
          <div className={styles.digestForm}>
            <SubscribeForm
              source="homepage"
              channels={[
                {
                  id: "newsletter",
                  label: "The Sunday digest",
                  description:
                    "One email a week. Skim it on Sunday over coffee.",
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
      </section>
    </>
  );
}
