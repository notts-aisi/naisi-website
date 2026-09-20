"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import SubscribeForm from "@/components/SubscribeForm";
import { isOffsite } from "@/content/links";
import { LINK_INTERESTS, type LinkInterest } from "@/lib/campaign/attribution";
import styles from "./links.module.css";

/**
 * The mailing list form on /links, with the three application buttons.
 *
 * Fellowship, facilitator and research incubator applications are not open
 * yet, and the promise the society makes about them is an email when they
 * are. So each button leads to this form rather than to a page that does not
 * exist, and it says which one the person pressed by setting `interest`, which
 * the form appends to the subscription's `source`. That is how the committee
 * can tell forty people waiting on the fellowship from five.
 *
 * The buttons are real anchors to `#mailing-list`. Without JavaScript they
 * still carry the person to the form, which is the part that matters; only
 * the label of what they were waiting for is lost.
 *
 * The consent line above the form says what is being joined in so many words.
 * "Tell me when fellowship applications open" followed by a newsletter would
 * be consent to one thing and delivery of another.
 *
 * The form comes first because it is what most printed codes are for, and the
 * buttons sit lower down and jump back up to it. `children` is whatever the
 * page wants between the two (the upcoming events), rendered on the server.
 *
 * WHEN ONE OPENS, an admin marks it open at /admin/links and gives it an
 * address, and that button becomes a plain link to the application with no
 * "Opens soon" on it. The other two keep leading to the form.
 *
 * The one data prop is `applications`: three booleans and three addresses that
 * the page shows anyway. It takes nothing else on purpose, because everything
 * a Server Component hands a client component is serialised into the public
 * HTML, whether or not the component renders it.
 */

const COPY: Record<LinkInterest, { button: string; heading: string }> = {
  fellowship: {
    button: "Fellowship applications",
    heading: "We'll email you when fellowship applications open.",
  },
  facilitator: {
    button: "Facilitator applications",
    heading: "We'll email you when facilitator applications open.",
  },
  incubator: {
    button: "Research incubator",
    heading: "We'll email you when the research incubator opens.",
  },
};

type Applications = Record<LinkInterest, { open: boolean; href: string }>;

export default function LinksSignup({
  applications,
  children,
}: {
  applications: Applications;
  children?: ReactNode;
}) {
  const [interest, setInterest] = useState<LinkInterest | null>(null);
  const openCount = LINK_INTERESTS.filter((id) => applications[id].open).length;

  return (
    <>
      <section id="mailing-list" className={styles.section} aria-labelledby="links-mailing-list">
        <h2 id="links-mailing-list" className={styles.sectionHeading}>
          {interest ? COPY[interest].heading : "Join the mailing list"}
        </h2>
        <p className={styles.sectionNote}>
          You&apos;re joining our mailing list. It is where we announce when
          fellowship, facilitator and research incubator applications open,
          alongside a short round-up of what is moving in AI safety.
          Unsubscribe any time.
        </p>
        <div className={styles.form}>
          <SubscribeForm
            source="links"
            interest={interest}
            channels={[
              {
                id: "newsletter",
                label: "Our newsletter",
                description:
                  "A round-up of what's moving in AI safety, and when applications open. Low frequency.",
                defaultChecked: true,
              },
              {
                id: "events",
                label: "Event announcements",
                description: "We email when we publish a new event. Low frequency.",
                defaultChecked: false,
              },
            ]}
          />
        </div>
      </section>

      {children}

      <section className={styles.section} aria-labelledby="links-applications">
        <h2 id="links-applications" className={styles.sectionHeading}>
          Applications
        </h2>
        <p className={styles.sectionNote}>
          {openCount === 0
            ? "Not open yet. Pick one, join the mailing list at the top of this page, and we'll email you when it opens."
            : openCount === LINK_INTERESTS.length
              ? "Open now."
              : "For one that is not open yet, pick it, join the mailing list at the top of this page, and we'll email you when it opens."}
        </p>
        <ul className={styles.rows}>
          {LINK_INTERESTS.map((id) => {
            const application = applications[id];
            if (application.open) {
              const body = (
                <>
                  <span className={styles.rowLabel}>{COPY[id].button}</span>
                  <span className={styles.rowSub}>Open now. Apply here.</span>
                </>
              );
              return (
                <li key={id}>
                  {isOffsite(application.href) ? (
                    <a
                      href={application.href}
                      className={styles.row}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {body}
                    </a>
                  ) : (
                    <Link href={application.href} prefetch={false} className={styles.row}>
                      {body}
                    </Link>
                  )}
                </li>
              );
            }
            return (
              <li key={id}>
                <a
                  href="#mailing-list"
                  className={styles.row}
                  data-selected={interest === id ? "true" : undefined}
                  onClick={() => setInterest(id)}
                >
                  <span className={styles.rowLabel}>
                    {COPY[id].button}
                    <span className={styles.soon}>Opens soon</span>
                  </span>
                  <span className={styles.rowSub}>
                    {interest === id ? "Selected. The form is at the top of this page." : "Get an email when it opens."}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
