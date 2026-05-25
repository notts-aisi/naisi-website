import type { Metadata } from "next";
import Badge from "@/components/ui/Badge";
import styles from "./page.module.css";

const LAST_UPDATED = "25 May 2026";
const TITLE = "Privacy policy";
const DESCRIPTION =
  "How the Nottingham AI Safety Initiative collects, uses, and looks after your personal data.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "article",
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
  },
};

const SECTIONS = [
  { id: "who-we-are", label: "Who we are" },
  { id: "data-we-collect", label: "Data we collect" },
  { id: "how-we-use-it", label: "How we use it" },
  { id: "legal-bases", label: "Legal bases" },
  { id: "sharing", label: "Sharing and processors" },
  { id: "cookies", label: "Cookies and local storage" },
  { id: "retention", label: "Retention" },
  { id: "transfers", label: "International transfers" },
  { id: "your-rights", label: "Your rights" },
  { id: "security", label: "Security" },
  { id: "changes", label: "Changes to this policy" },
];

export default function PrivacyPage() {
  return (
    <section className={styles.page}>
      <div className="container">
        <div className={styles.inner}>
          <Badge>Legal</Badge>
          <h1 className={styles.heading}>{TITLE}</h1>
          <p className={styles.lede}>
            This page explains what personal data we collect when you use the
            NAISI website, why we collect it, and what choices you have. We
            have tried to keep it plain.
          </p>
          <p className={styles.meta}>Last updated: {LAST_UPDATED}</p>

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
            <section id="who-we-are" className={styles.section}>
              <h2>Who we are</h2>
              <p>
                The Nottingham AI Safety Initiative (NAISI) is a student
                society at the University of Nottingham, affiliated with the
                University of Nottingham Students&apos; Union. For the purposes
                of UK data protection law, NAISI is the data controller for
                personal data processed through this website.
              </p>
              <p>
                You can reach us at{" "}
                <a href="mailto:ai-safety@uonsu.com">ai-safety@uonsu.com</a>{" "}
                with any privacy question, including requests to exercise the
                rights described below.
              </p>
            </section>

            <section id="data-we-collect" className={styles.section}>
              <h2>Data we collect</h2>
              <p>
                We only collect what we need to run the society and the site.
                The categories below cover everything we hold.
              </p>

              <h3>When you sign in with Google</h3>
              <ul>
                <li>
                  Your Google account profile, namely your display name, email
                  address, and profile photo URL.
                </li>
                <li>
                  A Firebase Auth session record so we can keep you signed in
                  across visits.
                </li>
              </ul>

              <h3>When you register as a member</h3>
              <ul>
                <li>
                  A University of Nottingham email address that you verify
                  through a one-time magic-link sent to that address.
                </li>
                <li>
                  Profile fields you fill in, including preferred name,
                  affiliation status (for example undergraduate, master&apos;s,
                  PhD, staff), subject or area of work, expected graduation
                  month if relevant, why you want to join, and a free-text
                  interests field.
                </li>
                <li>
                  Your notification preferences, broken down by channel (Google
                  inbox, university inbox) and category (newsletter, events).
                </li>
              </ul>

              <h3>When you RSVP to an event</h3>
              <ul>
                <li>
                  Your name and email address, along with the answers you give
                  to that event&apos;s signup questions (for example dietary
                  notes, accessibility needs, or any custom fields the
                  organiser added).
                </li>
                <li>
                  The status of your RSVP (pending, confirmed, waitlisted,
                  cancelled), and any later change requests you submit.
                </li>
              </ul>

              <h3>When you subscribe to our newsletter</h3>
              <ul>
                <li>
                  Your email address, optional name, and a per-channel record
                  of whether you are currently subscribed, plus an audit trail
                  of subscribe and unsubscribe events.
                </li>
              </ul>

              <h3>When you join the committee</h3>
              <ul>
                <li>
                  Optional public-profile fields such as a title and short bio,
                  if you choose to appear on the Members page.
                </li>
                <li>
                  Tasks, comments, and file attachments you create or are added
                  to inside the committee tooling area of the site. These are
                  visible to other committee members under the access rules
                  described in our role model.
                </li>
              </ul>

              <h3>Operational logs</h3>
              <ul>
                <li>
                  A log of emails we have sent you (subject, recipient, status)
                  and a suppression list of addresses that have hard-bounced or
                  marked our mail as spam, so we can stop sending to them.
                </li>
                <li>
                  Standard request logs generated by our hosting provider
                  (Google Cloud), such as IP address, user-agent, and request
                  timestamps. We do not use these for analytics; they exist to
                  help debug errors and protect the service from abuse.
                </li>
              </ul>
            </section>

            <section id="how-we-use-it" className={styles.section}>
              <h2>How we use it</h2>
              <p>We use your data to:</p>
              <ul>
                <li>
                  Authenticate you and let you back into your account on
                  return visits.
                </li>
                <li>
                  Review your membership application and, if approved, give
                  you access to the relevant member or committee surfaces.
                </li>
                <li>Run events, including managing RSVPs and waitlists.</li>
                <li>
                  Send you transactional emails you have asked for, such as
                  RSVP confirmations and account-related messages.
                </li>
                <li>
                  Send you the newsletter and event announcements where you
                  have opted in to those.
                </li>
                <li>
                  Operate the committee tooling (tasks, projects, drafts) for
                  members who have been added to those features.
                </li>
                <li>
                  Keep the site and the email pipeline healthy, including
                  honouring bounces and abuse reports.
                </li>
              </ul>
            </section>

            <section id="legal-bases" className={styles.section}>
              <h2>Legal bases</h2>
              <p>
                We rely on the following lawful bases under the UK GDPR:
              </p>
              <ul>
                <li>
                  <strong>Consent</strong> for sending you the newsletter and
                  any other marketing-style communication. You can withdraw
                  consent at any time using the unsubscribe link in any such
                  email or by emailing us.
                </li>
                <li>
                  <strong>Performance of a contract</strong> (the membership
                  relationship with NAISI) for the parts of the service that
                  exist to deliver the membership itself, such as processing
                  your application, giving you access to member surfaces, and
                  handling your RSVPs.
                </li>
                <li>
                  <strong>Legitimate interests</strong> for running the society
                  day to day, keeping the site secure, contacting members about
                  things they would reasonably expect, and operating the
                  committee tooling. We have weighed our interests against
                  yours and limited the data we hold to what is needed.
                </li>
              </ul>
            </section>

            <section id="sharing" className={styles.section}>
              <h2>Sharing and processors</h2>
              <p>
                We do not sell your data and we do not share it for
                advertising. We use the following third-party processors to
                run the service:
              </p>
              <ul>
                <li>
                  <strong>Google (Firebase and Google Cloud)</strong> hosts the
                  site (Firebase App Hosting on Cloud Run), the database
                  (Firestore), file uploads (Cloud Storage), and authentication
                  (Firebase Auth). Google&apos;s privacy terms apply to their
                  processing. See{" "}
                  <a
                    href="https://firebase.google.com/support/privacy"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    firebase.google.com/support/privacy
                  </a>
                  .
                </li>
                <li>
                  <strong>Resend</strong> sends our transactional emails and
                  newsletter on our behalf. They process your email address,
                  name (if provided), and the message content for delivery,
                  bounce handling, and abuse reporting. See{" "}
                  <a
                    href="https://resend.com/legal/privacy-policy"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    resend.com/legal/privacy-policy
                  </a>
                  .
                </li>
              </ul>
              <p>
                We may also share data with the University of Nottingham
                Students&apos; Union where we are required to as an affiliated
                society (for example, to confirm membership numbers or report
                on activities), and with law enforcement or regulators where we
                are legally obliged to do so.
              </p>
            </section>

            <section id="cookies" className={styles.section}>
              <h2>Cookies and local storage</h2>
              <p>
                We do not use analytics, advertising, or tracking cookies. The
                site sets the following storage:
              </p>
              <ul>
                <li>
                  <strong>Firebase Auth session cookie</strong> (strictly
                  necessary). Set when you sign in so we can keep you signed
                  in and route you to the right pages. Cleared when you sign
                  out.
                </li>
                <li>
                  <strong>Sidebar preference</strong> stored in your browser&apos;s
                  local storage under the key{" "}
                  <code>naisi.sidebar.collapsed</code>. It only records
                  whether you have collapsed the committee-area sidebar. It
                  never leaves your device. You can clear it from your
                  browser&apos;s site-data settings at any time.
                </li>
              </ul>
            </section>

            <section id="retention" className={styles.section}>
              <h2>Retention</h2>
              <p>
                We hold your account data while your account is active and for
                a reasonable period after it becomes inactive, so we can
                restore it if you come back and so we can answer any questions
                that come up afterwards. Where you ask us to delete your
                account, we will do so without undue delay, subject to records
                we are required to keep (for example, suppression entries for
                addresses that have asked not to be contacted, kept so we do
                not re-contact them by mistake).
              </p>
              <p>
                Audit-style records (the email send log, subscription event
                log, and impersonation log used for committee oversight) are
                kept for as long as needed to investigate issues and meet our
                accountability obligations.
              </p>
            </section>

            <section id="transfers" className={styles.section}>
              <h2>International transfers</h2>
              <p>
                Our processors are global services. Your data is stored in
                Google Cloud regions and may be processed outside the United
                Kingdom. Where it is transferred outside the UK, we rely on
                appropriate safeguards (such as the UK International Data
                Transfer Addendum to the EU Standard Contractual Clauses, or
                the UK Extension to the EU-US Data Privacy Framework) as
                offered by each processor.
              </p>
            </section>

            <section id="your-rights" className={styles.section}>
              <h2>Your rights</h2>
              <p>
                Under UK data protection law you have the right to:
              </p>
              <ul>
                <li>Ask for a copy of the personal data we hold about you.</li>
                <li>Ask us to correct data that is wrong or incomplete.</li>
                <li>
                  Ask us to delete your data, where there is no overriding
                  reason for us to keep it.
                </li>
                <li>
                  Ask us to restrict or object to how we use your data.
                </li>
                <li>
                  Ask us to provide your data in a portable format, where the
                  basis for our processing is consent or contract.
                </li>
                <li>Withdraw consent at any time where we rely on consent.</li>
              </ul>
              <p>
                Most of these are self-serve. You can edit your profile and
                notification preferences from{" "}
                <a href="/profile">your profile page</a>, unsubscribe from any
                email through the link in that email, and ask us to delete
                your account by emailing{" "}
                <a href="mailto:ai-safety@uonsu.com">ai-safety@uonsu.com</a>.
              </p>
              <p>
                If you believe we have not handled your data properly, you can
                complain to the UK Information Commissioner&apos;s Office at{" "}
                <a
                  href="https://ico.org.uk"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  ico.org.uk
                </a>
                . We would, of course, prefer the chance to put things right
                first.
              </p>
            </section>

            <section id="security" className={styles.section}>
              <h2>Security</h2>
              <p>
                We rely on Google&apos;s infrastructure for at-rest and
                in-transit encryption, and on Firestore&apos;s rule engine to
                enforce access. Member personal data is readable only by
                committee members the Students&apos; Union has formally
                recognised, and by admins; ordinary members can only see their
                own record and the tasks they have been added to. Email is
                signed with DKIM and aligned with DMARC on the{" "}
                <code>naisi.uk</code> domain.
              </p>
              <p>
                No service is perfectly secure. If you spot a problem, please
                tell us at{" "}
                <a href="mailto:ai-safety@uonsu.com">ai-safety@uonsu.com</a>{" "}
                so we can fix it.
              </p>
            </section>

            <section id="changes" className={styles.section}>
              <h2>Changes to this policy</h2>
              <p>
                When we change this policy we will update the date at the top
                of the page. For changes that materially affect how we use
                your data, we will let active members know by email before the
                change takes effect.
              </p>
            </section>
          </div>

          <aside className={styles.contactCard}>
            <h2>Questions</h2>
            <p>
              Email{" "}
              <a href="mailto:ai-safety@uonsu.com">ai-safety@uonsu.com</a>{" "}
              with anything privacy-related, including requests to access,
              correct, or delete your data. We aim to respond within a few
              working days.
            </p>
          </aside>
        </div>
      </div>
    </section>
  );
}
