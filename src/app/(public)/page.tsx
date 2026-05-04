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
 *  1. Hero. Brand statement, lede tightened to set up the rest of the page.
 *     Layered radial gradients kept (atmosphere, no animation).
 *  2. What NAISI is. One paragraph of plain prose, no card frame, two
 *     inline links.
 *  3. "Where to start" reading lists. Four curated lists, collapsible,
 *     closed by default. The page's substance.
 *  4. Events nod. Editorial paragraph + link to /events. No inline form
 *     here — the single subscribe form below covers both newsletter
 *     and event announcements via checkboxes.
 *  5. "Stay in touch" signup. One form, name + email + checkboxes for the
 *     two lists (Sunday digest and event announcements). Single
 *     confirmation email lists everything they ticked.
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
            We run two parallel reading-group fellowships, one technical, one
            governance, both built on{" "}
            <a
              href="https://aisafetyfundamentals.com/"
              target="_blank"
              rel="noreferrer noopener"
              className={styles.inlineLink}
            >
              BlueDot Impact&apos;s curriculum
            </a>{" "}
            and our own additions. Around them sit weekly meetings, projects,
            and the occasional talk. New members are{" "}
            <Link href="/register" className={styles.inlineLink}>
              approved by the committee
            </Link>{" "}
            before joining the community properly. If you want a slower
            on-ramp, the reading lists below and the Sunday digest are where
            most people start.
          </p>
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

      <section className={styles.eventsSection}>
        <div className={`container ${styles.eventsInner}`}>
          <h2 className={styles.eventsTitle}>On campus.</h2>
          <p className={styles.eventsBody}>
            Talks, socials, reading sessions, the occasional workshop. Events
            are how we make a mostly-online field feel real on campus, and
            how new people meet us before they commit to the fellowship.{" "}
            <Link href="/events" className={styles.inlineLink}>
              See what&apos;s on →
            </Link>
          </p>
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
