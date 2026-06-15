import type { ReactNode } from "react";
import Badge from "@/components/ui/Badge";
import styles from "../legal.module.css";

const TITLE = "Terms of service";

const SECTIONS = [
  { id: "who-this-is-for", label: "Who this is for" },
  { id: "accounts", label: "Accounts and approval" },
  { id: "acceptable-use", label: "Acceptable use" },
  { id: "events", label: "Events and RSVPs" },
  { id: "content", label: "Content you submit" },
  { id: "suspension", label: "Suspension and removal" },
  { id: "no-warranties", label: "No warranties" },
  { id: "liability", label: "Limitation of liability" },
  { id: "changes", label: "Changes to these terms" },
  { id: "law", label: "Governing law" },
];

export default function TermsContentV1({
  meta,
  banner,
}: {
  meta?: ReactNode;
  banner?: ReactNode;
}) {
  return (
    <section className={styles.page}>
      <div className="container">
        <div className={styles.inner}>
          <Badge>Legal</Badge>
          <h1 className={styles.heading}>{TITLE}</h1>
          {banner}
          <p className={styles.lede}>
            These terms cover your use of the NAISI website at{" "}
            <a href="https://naisi.uk">naisi.uk</a>. By signing in, registering,
            or RSVPing to an event you agree to them. If you only browse the
            public pages, the acceptable-use section still applies to anything
            you submit (for example, an event RSVP).
          </p>
          {meta}

          <nav className={styles.tocCard} aria-label="On this page">
            <div className={styles.tocTitle}>On this page</div>
            <ul className={styles.tocList}>
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>{s.label}</a>
                </li>
              ))}
            </ul>
          </nav>

          <div className={styles.sections}>
            <section id="who-this-is-for" className={styles.section}>
              <h2>Who this is for</h2>
              <p>
                The public parts of the site (the homepage, news, resources,
                public events) are open to anyone. The member and committee
                areas are for people the NAISI committee has approved as
                members, and for committee members the Students&apos; Union
                formally recognises.
              </p>
              <p>
                Membership is open to current students, staff, and other
                people affiliated with the University of Nottingham. We ask
                you to verify a University of Nottingham email address before
                we review your application.
              </p>
            </section>

            <section id="accounts" className={styles.section}>
              <h2>Accounts and approval</h2>
              <p>
                You sign in with a Google account. You are responsible for
                keeping that account secure; we treat anyone who signs in with
                your Google account as you.
              </p>
              <p>
                When you register you are asked for some profile information
                so we can assess your application. You agree to give accurate
                information and to keep it reasonably up to date from your
                profile page. Misrepresenting who you are is grounds for
                rejecting or removing your account.
              </p>
              <p>
                Approval is at the committee&apos;s discretion. We may approve,
                place on hold, or reject an application. If we reject your
                application we will say so by email and you can ask us why.
              </p>
            </section>

            <section id="acceptable-use" className={styles.section}>
              <h2>Acceptable use</h2>
              <p>When you use the site, you agree not to:</p>
              <ul>
                <li>
                  Harass, threaten, or abuse other members, committee members,
                  event attendees, or staff, on the site or in any space the
                  site connects to.
                </li>
                <li>
                  Post content that is unlawful, defamatory, discriminatory,
                  sexually explicit, or otherwise inappropriate for a student
                  society space.
                </li>
                <li>
                  Submit content that infringes copyright, trade marks, or
                  other rights you do not hold.
                </li>
                <li>
                  Impersonate anyone else, or misrepresent your affiliation
                  with the University, NAISI, or the Students&apos; Union.
                </li>
                <li>
                  Use the site, or any data you can see through it, to send
                  unsolicited marketing or to build a separate contact list.
                </li>
                <li>
                  Attempt to break, scrape, overload, or probe the site or its
                  infrastructure, beyond ordinary use of the features as
                  presented.
                </li>
                <li>
                  Upload malware, or use the file-upload features for any
                  purpose other than the task or event they are attached to.
                </li>
              </ul>
              <p>
                If you see behaviour that breaks these rules, please tell us
                at{" "}
                <a href="mailto:ai-safety@uonsu.com">ai-safety@uonsu.com</a>.
                The Students&apos; Union code of conduct also applies to NAISI
                activities, including online ones.
              </p>
            </section>

            <section id="events" className={styles.section}>
              <h2>Events and RSVPs</h2>
              <p>
                Event capacity, waitlists, and signup questions are set by the
                organiser. RSVPs may be confirmed, waitlisted, or declined.
                Where an event has limited capacity we may rely on your
                RSVP to plan numbers (for example, food orders), so please
                cancel through your confirmation email if you cannot make it.
              </p>
              <p>
                We may need to change the date, time, location, or other
                details of an event. We will email confirmed attendees when
                that happens. We may also have to cancel an event; if we do,
                we will let confirmed attendees know.
              </p>
            </section>

            <section id="content" className={styles.section}>
              <h2>Content you submit</h2>
              <p>
                When you submit content to the site (an RSVP answer, a profile
                bio, a comment on a committee task, a file attachment, and so
                on), you keep ownership of it. You give NAISI a non-exclusive
                licence to store, display, and use that content for the
                purpose of running the society and the site, including
                showing it to the audience it was intended for.
              </p>
              <p>
                You can edit or remove your own content from the relevant
                screens, or ask us to remove it by emailing us. We may remove
                content that breaks these terms or that we are required to
                remove for legal reasons.
              </p>
            </section>

            <section id="suspension" className={styles.section}>
              <h2>Suspension and removal</h2>
              <p>
                We can suspend or remove your access if you break these terms,
                if your behaviour is harmful to other members or to the
                running of the society, or if we are required to by the
                Students&apos; Union, the University, or the law.
              </p>
              <p>
                Where it is reasonable to do so we will tell you why and give
                you a chance to respond. Decisions about committee roles and
                administrative access are made by NAISI&apos;s admins. You can
                ask us to delete your account at any time by emailing{" "}
                <a href="mailto:ai-safety@uonsu.com">ai-safety@uonsu.com</a>.
              </p>
            </section>

            <section id="no-warranties" className={styles.section}>
              <h2>No warranties</h2>
              <p>
                The site, the events we run, and any educational material we
                publish or signpost are provided as is. We try to keep
                everything accurate and the site available, but we do not
                promise that it will be free of errors, available without
                interruption, or fit for any specific purpose you have in
                mind.
              </p>
              <p>
                Resources we link to (papers, courses, articles, third-party
                fellowships) are not under our control. We share them because
                we find them useful; we do not endorse everything in them.
              </p>
            </section>

            <section id="liability" className={styles.section}>
              <h2>Limitation of liability</h2>
              <p>
                To the extent permitted by law, NAISI, its committee, and
                its members are not liable for any indirect, incidental, or
                consequential loss arising from your use of the site or from
                any decision you make based on something you read here.
              </p>
              <p>
                Nothing in these terms limits any liability that cannot be
                limited under UK law, including liability for death or
                personal injury caused by negligence, or for fraud.
              </p>
            </section>

            <section id="changes" className={styles.section}>
              <h2>Changes to these terms</h2>
              <p>
                When we update these terms we will change the date at the top
                of the page. For changes that materially affect your rights or
                obligations, we will let active members know by email before
                the change takes effect. Continued use of the site after a
                change means you accept the updated terms.
              </p>
            </section>

            <section id="law" className={styles.section}>
              <h2>Governing law</h2>
              <p>
                These terms are governed by the law of England and Wales, and
                any dispute is subject to the exclusive jurisdiction of the
                courts of England and Wales.
              </p>
            </section>
          </div>

          <aside className={styles.contactCard}>
            <h2>Questions</h2>
            <p>
              Email{" "}
              <a href="mailto:ai-safety@uonsu.com">ai-safety@uonsu.com</a>{" "}
              if anything in here is unclear or if you want to report a
              problem with the site or with how someone else is using it.
            </p>
          </aside>
        </div>
      </div>
    </section>
  );
}
