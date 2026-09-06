/**
 * ============================ OWNER TO CONFIRM ============================
 *
 * READ THIS BEFORE MERGING. The wording of a privacy policy is the owner's,
 * not an agent's, and publishing it moves CURRENT_POLICY_VERSION, which asks
 * every member on the site, the owner included, to re-accept the policy on
 * their next signed-in page. The ten items on v3's list were settled when
 * v3 was accepted and are NOT reopened here: v3 is frozen and its list stays
 * on that file. This version adds exactly one sentence, and it is the only
 * numbered item below.
 *
 * One further thing needs a decision and is not a sentence on the page: the
 * date on this version (see POLICIES in src/lib/legal/policies.ts) is a
 * PLACEHOLDER, one day after v3's planned live date, because neither version
 * has reached production yet. Set the real publish date before merging.
 *
 *  1. "When a worksheet is sent to you, we record when you first opened it,
 *     how many times you opened each page and roughly how long you were
 *     active on it, and show that to you and to the people reviewing it; we
 *     never record keystrokes or pasting." (Data we collect.) This one is
 *     BOTH: the first half describes what the code does and can be checked
 *     against `activity` on a worksheet response, but the second half is the
 *     policy, and it is a promise about every future version of the feature
 *     rather than about this one. Monitoring how long somebody spent on a
 *     page is the sort of thing people expect to be told about, so the
 *     sentence also names the audience: the recipient sees their own figures,
 *     not only the reviewers. If the committee would rather not measure
 *     active time at all, this sentence and the tracking come out together.
 *
 * =========================================================================
 *
 * Version 4 of the Privacy Policy. v1, v2 and v3 are FROZEN: they still
 * render unchanged at their archive URLs (/privacy/v/1, /privacy/v/2 and
 * /privacy/v/3), so this file is a copy-and-edit of v3 rather than a refactor
 * of it. Never reach into an older version to share markup with this one.
 * That is why the worksheet sentence is here and not in v3: v3 is the text
 * the owner accepted, and editing accepted text in place would change what
 * an archive URL shows without anyone having agreed to the change.
 *
 * What changed from v3: one bullet under "When you join the committee", in
 * "Data we collect", saying what a circulated worksheet records about the
 * person it was sent to. Nothing else moved.
 */
import type { ReactNode } from "react";
import Badge from "@/components/ui/Badge";
import styles from "../legal.module.css";

const TITLE = "Privacy policy";

const SECTIONS = [
  { id: "who-we-are", label: "Who we are" },
  { id: "data-we-collect", label: "Data we collect" },
  { id: "courses", label: "Courses and programmes" },
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

export default function PrivacyContentV4({
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
            This page explains what personal data we collect when you use the
            NAISI website, why we collect it, and what choices you have. We
            have tried to keep it plain. If you apply to one of our courses or
            take part in one, the{" "}
            <a href="#courses">Courses and programmes</a> section is the one
            to read.
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
                The categories below cover everything we hold. Course
                applications and course participation add several more, and
                they have <a href="#courses">a section of their own</a>.
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

              <h3>When you install the site as an app</h3>
              <ul>
                <li>
                  If you turn on push notifications, a push subscription from
                  your browser: an endpoint URL issued by your browser vendor
                  and two keys that let us encrypt a message to that device.
                  It is tied to one browser on one device, not to you, and we
                  hold one record per device you enable. Turning notifications
                  off in the site or in your browser deletes it.
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
                <li>
                  When a worksheet is sent to you, we record when you first
                  opened it, how many times you opened each page and roughly
                  how long you were active on it, and show that to you and to
                  the people reviewing it; we never record keystrokes or
                  pasting.
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
                  A record of the spreadsheet downloads the site generates
                  (registers, rosters, application tables, membership lists):
                  who asked for it, what it covered, how many people were in
                  it, and when. See{" "}
                  <a href="#courses">Courses and programmes</a> for what that
                  does and does not cover.
                </li>
                <li>
                  Standard request logs generated by our hosting provider
                  (Google Cloud), such as IP address, user-agent, and request
                  timestamps. We do not use these for analytics; they exist to
                  help debug errors and protect the service from abuse.
                </li>
              </ul>
            </section>

            <section id="courses" className={styles.section}>
              <h2>Courses and programmes</h2>
              <p>
                We run application-based programmes (the research incubator and
                the fellowships) and open-entry ones (the pre-course). Applying
                and taking part both create records about you, and some of them
                are written by other students. This section lists all of them,
                who can see each one, and how long we keep it.
              </p>

              <h3>When you apply</h3>
              <ul>
                <li>
                  <strong>Your answers.</strong> Everything you type into the
                  application form, including drafts. Drafts are saved on our
                  servers, not just in your browser, so that you can come back
                  to a part-written application on another device. A draft you
                  never submit is still an application record until you delete
                  it or your account.
                </li>
                <li>
                  <strong>Your availability.</strong> The grid where you mark
                  which times you could attend in person. We use it to build
                  groups and nothing else.
                </li>
                <li>
                  <strong>Your programme preferences.</strong> Which programme
                  and stream you applied for, and how you ranked your choices.
                </li>
                <li>
                  <strong>Access requirements.</strong> The optional box asking
                  whether there is anything we should know to make the
                  programme work for you. In practice people use it to tell us
                  about disability, health, caring responsibilities or similar,
                  so we treat whatever you write there as sensitive. It is
                  stored separately from the rest of your application, in a
                  different place in our database, so that it cannot be swept
                  into a scoring screen or a spreadsheet by accident. Your
                  access requirements are never scored and never shown to
                  reviewers. Only the person making the final decision and site
                  admins can open it, they have to open it deliberately, and
                  every time one of them does we record who read it and when.
                  Leaving it blank does not count against you. We do not ask
                  for your date of birth anywhere.
                </li>
                <li>
                  <strong>Whether you are a paid member,</strong> and where
                  that came from (see membership below). This is shown to the
                  person making the final decision and to admins. It is hidden
                  from reviewers and it does not affect whether you are
                  offered a place.
                </li>
              </ul>

              <h3>When we review your application</h3>
              <ul>
                <li>
                  <strong>Reviewer scores and notes.</strong> Each reviewer
                  scores your application against the round&apos;s criteria and
                  can write free-text notes about it. Reviewers are other
                  students: SU-recognised committee members and admins. They
                  review name-blind, meaning your name is hidden from them,
                  though a piece of writing can of course identify its author.
                  Scores and notes are personal data about you. If you ask us
                  what a reviewer wrote about your application, we will tell
                  you, and reviewers are told that before they write anything.
                </li>
                <li>
                  <strong>The decision,</strong> its date, who made it, and the
                  reason. Where we share a reason with you we send it by email;
                  an internal reason that we have not shared is still yours to
                  ask for.
                </li>
              </ul>

              <h3>While you are on a programme</h3>
              <ul>
                <li>
                  <strong>Attendance registers.</strong> Your facilitator marks
                  each session: present, arrived late, left early, absent, or
                  excused. You can see your own attendance once a session has
                  been submitted.
                </li>
                <li>
                  <strong>Participant notes.</strong> After a session your
                  facilitator can write a private note about a named
                  participant, for example about how someone is finding the
                  material or that they mentioned they would miss next week.
                  Facilitators are students. These notes are personal data
                  about you, and if you ask to see the notes written about you,
                  we will show you them.
                </li>
                <li>
                  <strong>Your written work.</strong> Answers to exercises,
                  your progress through each week&apos;s materials, and any
                  feedback a facilitator writes on your work. We do not publish
                  anything you write to the rest of your group unless you
                  choose to share it, and we will not use anything you write in
                  a course to make decisions about you outside the programme.
                </li>
                <li>
                  <strong>Feedback and surveys.</strong> Weekly feedback forms
                  and any before-and-after surveys we run. Where a form says it
                  is anonymous, we store the answers with no link to you: your
                  identity is not recorded on the response at all, and we keep
                  a separate note that you responded so we stop reminding you.
                  Where a form is not anonymous it says so, and the answers are
                  stored against your account.
                </li>
                <li>
                  <strong>Dropping out.</strong> If you leave a programme we
                  record that you left and, if you tell us, why.
                </li>
              </ul>

              <h3>Membership</h3>
              <ul>
                <li>
                  Your membership tier (paid, comped, alumni, staff) for a
                  given year, and where we learned it: a list the
                  Students&apos; Union gives us, or an admin adding you by
                  hand. You can see your own tier on your profile.
                </li>
              </ul>

              <h3>Conduct</h3>
              <ul>
                <li>
                  If there has been a conduct concern, an admin can flag an
                  account and must record a reason. Reviewers see only that a
                  flag exists, never the reason. The reason is visible to
                  admins alone. It is personal data about you and you can ask
                  us for it.
                </li>
              </ul>

              <h3>Certificates</h3>
              <ul>
                <li>
                  When you complete a programme we can issue a certificate with
                  a verification page anyone holding the link can open. That
                  page names you, the programme and the date, so that an
                  employer can check the certificate is real. The link is not
                  guessable and the page is not listed anywhere. A certificate
                  page stays online unless you ask us to withdraw it, which you
                  can do at any time by emailing us. That includes after you
                  delete your account: deleting the account does not take the
                  page down, because the page is there for the people you sent
                  the link to. Ask us and we will withdraw it, account or no
                  account.
                </li>
              </ul>

              <h3>Downloads</h3>
              <p>
                Staff sometimes need a spreadsheet: a register to take to a
                session, a roster, the applications for a round, a membership
                list. Downloads generated by the site are recorded, with who
                asked for it, what it covered, how many people were in it and
                when. We are being careful with that sentence: it means we log
                the files the site produces. It does not mean we can track a
                file once it has been downloaded, and it does not cover
                somebody copying what is on their screen.
              </p>

              <h3>Who can see what</h3>
              <ul>
                <li>
                  <strong>Reviewers</strong> (SU-recognised committee members
                  and admins, all of them students) see applications without
                  names, their own and other reviewers&apos; scores and notes,
                  and a conduct flag if there is one. They do not see access
                  requirements, membership tier, or the reason behind a conduct
                  flag.
                </li>
                <li>
                  <strong>The person making the final decision</strong> sees
                  everything a reviewer sees, with names, plus membership tier,
                  plus access requirements when they open them, which is
                  recorded.
                </li>
                <li>
                  <strong>Facilitators</strong> (students, in most cases only a
                  year or two ahead of you) see their own groups: who is in
                  them, contact details, attendance, written work, and the
                  participant notes their colleagues wrote about people in that
                  group. They do not see applications or review scores.
                </li>
                <li>
                  <strong>Other participants</strong> see the names of the
                  people in their group, and nothing else about them.
                </li>
                <li>
                  <strong>Admins</strong> can see all of the above. Admin
                  actions on this material are logged.
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
                  Run our courses: assess applications, place people into
                  groups that fit their availability, keep registers, give
                  feedback on work, ask how the sessions are going, and issue
                  certificates at the end.
                </li>
                <li>
                  Send you transactional emails you have asked for, such as
                  RSVP confirmations, application receipts and reminders, the
                  week&apos;s course materials, and account-related messages.
                </li>
                <li>
                  Send you the newsletter and event announcements where you
                  have opted in to those.
                </li>
                <li>
                  Send push notifications to a device where you have turned
                  them on, for the categories you chose.
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
                  any other marketing-style communication, and for push
                  notifications. You can withdraw consent at any time using the
                  unsubscribe link in any such email, the notification settings
                  on your profile, or by emailing us.
                </li>
                <li>
                  <strong>Performance of a contract</strong> (the membership
                  relationship with NAISI) for the parts of the service that
                  exist to deliver the membership itself, such as processing
                  your application, giving you access to member surfaces,
                  running a programme you have a place on, and handling your
                  RSVPs.
                </li>
                <li>
                  <strong>Legitimate interests</strong> for running the society
                  day to day, keeping the site secure, contacting members about
                  things they would reasonably expect, assessing course
                  applications fairly, and operating the committee tooling. We
                  have weighed our interests against yours and limited the data
                  we hold to what is needed.
                </li>
                <li>
                  <strong>Explicit consent</strong> for special category data.
                  Where an access-requirements answer includes health or
                  disability information, we treat it as special category data
                  and rely on your explicit consent, given when you choose to
                  fill that box in. You do not have to fill it in, and you can
                  ask us to delete what you wrote there without affecting your
                  application.
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
                <li>
                  <strong>Your browser vendor</strong> (for example Google,
                  Apple or Mozilla) delivers push notifications to a device
                  where you have turned them on. The message is encrypted to
                  that device before it leaves us.
                </li>
              </ul>
              <p>
                We may also share data with the University of Nottingham
                Students&apos; Union where we are required to as an affiliated
                society (for example, to confirm membership numbers or report
                on activities), and with law enforcement or regulators where we
                are legally obliged to do so. Where the Students&apos; Union
                gives us a membership list, we use it to mark who has paid and
                for nothing else.
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
                <strong>Course applications and course records.</strong>{" "}
                Applications are kept against your account for as long as it
                exists, so you can see what you sent us and so we can make
                sense of a later application from the same person. We do not
                strip them after a fixed period. The same goes for the rest of
                your course record: attendance, written work, feedback you gave
                us, and notes written about you. If you want any of it removed
                sooner, email us. Deleting your account deletes all of that,
                including your access-requirements answer, your applications
                and drafts, the review scores and notes written about you, your
                marks on registers and the notes about you on them.
              </p>
              <p>
                <strong>Certificates are the exception.</strong> A certificate
                and its verification page are not removed when your account is
                deleted. The page exists so that somebody you sent the link to
                can check the certificate is real, and that is the moment you
                are least likely to still have an account with us. It stays
                online until you ask us to withdraw it, which you can do at any
                time by emailing us, whether or not you still have an account.
              </p>
              <p>
                <strong>For up to 30 days after deletion.</strong> When your
                account is deleted, whether by you or by us, we may keep your
                account data, the content you contributed, and our logs for up
                to 30 days afterwards. We do this so we can meet our legal
                obligations and, where it is necessary, investigate abuse or
                misuse of the site, including activity that may break the law.
                Once that period has passed we permanently delete or anonymise
                this information, except for the limited records described in
                this section that we are required or permitted to keep for
                longer.
              </p>
              <p>
                <strong>Content you contributed.</strong> Some content you
                created while using the site is not always removed at the moment
                your account is deleted. In particular, tasks, comments, and
                file attachments you created or were added to in the committee
                tooling, and event RSVPs and the answers you gave, may be
                retained for a limited period so that ongoing committee work and
                event records are not disrupted. We then delete this content, or
                detach it from your identity, in line with the retention periods
                described here. If you need specific content removed sooner,
                email us and we will deal with it.
              </p>
              <p>
                Audit-style records are kept for as long as needed to
                investigate issues and meet our accountability obligations, and
                are not removed when an account is deleted. These are records
                of what staff did rather than of what you wrote: the email send
                log, the subscription event log, the impersonation log used for
                committee oversight, the log of course actions including who
                read an access-requirements answer, and the record of downloads
                the site generated. They name the person who took the action
                and what it concerned, and hold no course answers, marks or
                notes.
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
                A request for a copy of your data covers what other people have
                written about you as well as what you wrote yourself. For
                courses that means the scores and notes a reviewer recorded on
                your application, the notes a facilitator wrote about you, and
                the reason behind a conduct flag. Ask us and we will tell you.
                Where a record names somebody else as well as you we may need
                to redact their part of it.
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
                own record and the tasks they have been added to. Course
                material about a named person (applications, access
                requirements, registers, participant notes) is served only
                through checks on our servers, never handed to a browser that
                has no reason for it. Email is signed with DKIM and aligned
                with DMARC on the <code>naisi.uk</code> domain.
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
                your data, we will ask you to review and accept the updated
                policy the next time you open a signed-in page, and we will let
                active members know by email. Earlier versions stay readable at{" "}
                <a href="/privacy/versions">/privacy/versions</a>.
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
