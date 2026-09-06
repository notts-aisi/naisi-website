/**
 * Version 4 of the Privacy Policy, checked sentence by sentence against the
 * code on 7 September 2026.
 *
 * What changed from v3: the worksheet activity sentence, and the corrections
 * that check turned up (certificates cut, deletion by email rather than a
 * button, what a deletion removes and what it keeps, no 30-day purge, only the
 * two exports that are logged, collaborator applications, email-and-password
 * signups, the SU membership file, reCAPTCHA, the full cookie and local
 * storage list, per-round blind settings, the star rating in place of
 * anonymous surveys, what other participants see, the push record, view-as,
 * and the worksheet recipient picker).
 *
 * v1, v2 and v3 are FROZEN: they still render unchanged at their archive URLs
 * (/privacy/v/1, /privacy/v/2 and /privacy/v/3), so this file is a
 * copy-and-edit of v3 rather than a refactor of it. Never reach into an older
 * version to share markup with this one. The date on this version (see
 * POLICIES in src/lib/legal/policies.ts) is the owner's to set.
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

              <h3>When you create an account with an email address</h3>
              <ul>
                <li>
                  If you create an account with an email address rather than
                  through Google, we hold that address, a password you set
                  yourself (stored by Firebase Auth, never by us in readable
                  form), and a record of the signup itself: when you started
                  it, whether you confirmed your address, whether you finished,
                  and how many verification emails we sent. That record stays
                  even if you never finish signing up, until you ask us to
                  remove it.
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

              <h3>When you apply as an external collaborator</h3>
              <ul>
                <li>
                  Your name and email address, the institution or company you
                  are at and your role there, the project you are proposing and
                  your background, any LinkedIn or portfolio link you give us,
                  the areas you are interested in, how you heard about us, and
                  whether you already know somebody on the committee (and who,
                  if you tell us).
                </li>
                <li>
                  The decision on your application and, where it is turned
                  down, the reason we recorded.
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
                  The record is tied to one browser on one device and carries
                  your account so we know where to send, together with your
                  browser&apos;s user-agent string and the last time that
                  device checked in. We hold one record per device you enable.
                  Turning notifications off deletes it; deleting your account
                  does not, so ask us if you want it gone.
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
                  opened it, how many times you moved between its pages, when
                  you were last active on it, and roughly how long you spent on
                  it, sampled in half-minute steps while the page is in front
                  of you. The person who sent it, the worksheet&apos;s author,
                  your reviewers and site admins can see those figures. We do
                  not record which page you were on, what you typed, or when
                  you pasted.
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
                  A record of two of the spreadsheet downloads the site
                  generates, the membership list and the answers to a
                  circulated worksheet: who asked for it, what it covered, how
                  many people were in it, and when. See{" "}
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
                  from reviewers by default and it does not affect whether you
                  are offered a place.
                </li>
              </ul>

              <h3>When we review your application</h3>
              <ul>
                <li>
                  <strong>Reviewer scores and notes.</strong> Each reviewer
                  scores your application against the round&apos;s criteria and
                  can write free-text notes about it. Reviewers are other
                  students: SU-recognised committee members and admins. Rounds
                  are set up name-blind by default, and your membership tier is
                  hidden from reviewers by default. If a round is run
                  differently we will say so on the application form. A piece
                  of writing can of course identify its author.
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
                  feedback a facilitator writes on your work. You can also keep
                  a private note against a piece of material: it is not shown
                  to the rest of your run, but your facilitator and site admins
                  can read it. We do not publish
                  anything you write to the rest of your group unless you
                  choose to share it, and we will not use anything you write in
                  a course to make decisions about you outside the programme.
                </li>
                <li>
                  <strong>Feedback on the material.</strong> You can give a
                  piece of course material a star rating and leave a comment on
                  it. Both are stored against your account and your name, and
                  the comment is shown to the rest of your run. We do not run
                  anonymous surveys on this site. If we ever ask for feedback
                  anonymously it will be through a form somewhere else, and it
                  will say so.
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
                <li>
                  When the Students&apos; Union gives us a membership list, we
                  keep the file as we received it: for each person on it, their
                  name, the email addresses on the list, and their membership
                  tier, together with a note of which NAISI account, if any, we
                  matched them to. We keep it so a membership can be checked or
                  corrected later. If you are on that list and have no account
                  with us, you can ask us to remove your row.
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
              <p>
                We may issue certificates in future. If we do, we will say here
                what a certificate shows and who can see it before we issue the
                first one.
              </p>

              <h3>Downloads</h3>
              <p>
                Staff sometimes need a spreadsheet: a register to take to a
                session, a roster, the applications for a round, a membership
                list. Two of those downloads are recorded, with who asked for
                it, what it covered, how many people were in it and when: the
                membership list, and the answers to a circulated worksheet.
                Both refuse to hand over the file if that record cannot be
                written. The event attendee list and the subscriber list are
                built in your browser and are not recorded. We are being
                careful with that sentence: it means we log two of the files
                the site produces. It does not mean we can track a file once it
                has been downloaded, and it does not cover somebody copying
                what is on their screen.
              </p>

              <h3>Who can see what</h3>
              <ul>
                <li>
                  <strong>Reviewers</strong> (SU-recognised committee members
                  and admins, all of them students) see applications with the
                  name hidden on a round left name-blind, which is the default,
                  their own and other reviewers&apos; scores and notes, and a
                  conduct flag if there is one. They do not see access
                  requirements, the membership tier, or the reason behind a
                  conduct flag.
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
                  <strong>Other participants</strong> on your run see your
                  name, and any comment or star rating you choose to leave on a
                  piece of course material. They see nothing else about you.
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
                  feedback on work, and ask how the sessions are going.
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
                  <strong>Google reCAPTCHA</strong> checks that the person
                  filling in our registration and course application forms is
                  not a bot. When one of those forms is on screen, Google
                  receives information about your browser and how you
                  interacted with the page, and sets its own cookie. We see
                  only Google&apos;s pass or fail verdict.
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
                one exception is Google reCAPTCHA, which sets a cookie of its
                own while our registration and course application forms are on
                screen (see <a href="#sharing">Sharing and processors</a>).
                Every cookie the site itself sets is strictly necessary:
              </p>
              <ul>
                <li>
                  <code>__session</code> keeps you signed in and routes you to
                  the right pages. Set when you sign in, it lasts one day for
                  committee members and admins and five days for everybody
                  else. Cleared when you sign out.
                </li>
                <li>
                  <code>__impersonator</code> marks a &quot;view as&quot;
                  session. It is set only on an admin&apos;s browser while they
                  are viewing the site as another member, and lasts five days
                  or until they leave the session, whichever comes first.
                </li>
                <li>
                  <code>__auth_next</code> remembers which page to send you to
                  once you have signed in. Ten minutes.
                </li>
                <li>
                  <code>__google_credential</code> hands the result of a Google
                  sign-in from the redirect back to the page. Sixty seconds.
                </li>
                <li>
                  <code>g_csrf_token</code> is set by Google during the Google
                  sign-in redirect. We compare it with the value Google sends
                  us so that the sign-in cannot be forged.
                </li>
              </ul>
              <p>
                In your browser&apos;s own local storage the site keeps four
                small preferences, none of which leave your device:{" "}
                <code>naisi.sidebar.collapsed</code> (whether you have
                collapsed the committee-area sidebar),{" "}
                <code>naisi.lastRoute</code> (the last page you had open, so
                the installed app can return you to it),{" "}
                <code>naisi.installCard.dismissed</code> (that you have
                dismissed the prompt to install the app), and{" "}
                <code>naisi.auth.loaderOpen</code> (whether the sign-in panel
                was open). Signing in also stores your session tokens in your
                browser&apos;s own storage, which Firebase Auth keeps in
                IndexedDB. You can clear all of it from your browser&apos;s
                site-data settings at any time.
              </p>
            </section>

            <section id="retention" className={styles.section}>
              <h2>Retention</h2>
              <p>
                We hold your account data while your account is active and for
                a reasonable period after it becomes inactive, so we can
                restore it if you come back and so we can answer any questions
                that come up afterwards.
              </p>
              <p>
                <strong>Course applications and course records.</strong>{" "}
                Applications are kept against your account for as long as it
                exists, so you can see what you sent us and so we can make
                sense of a later application from the same person. We do not
                strip them after a fixed period. The same goes for the rest of
                your course record: attendance, written work, feedback you gave
                us, and notes written about you. If you want any of it removed
                sooner, email us.
              </p>
              <p>
                <strong>Asking us to delete your account.</strong> Email us and
                we will delete it, without undue delay. There is no
                self-service delete button once you are a member or an approved
                collaborator, because taking somebody&apos;s work out of the
                committee tooling is done by hand: an admin runs the deletion.
              </p>
              <p>
                <strong>What a deletion removes.</strong> Your account record
                and profile, your newsletter subscriptions and their history,
                your collaborator application if you made one, any outstanding
                email-verification links, your course enrolments, applications
                and drafts, your progress and your answers to exercises, your
                admission applications together with the access-requirements
                answer stored separately beside them, the review scores and
                notes written about those applications and any you wrote about
                somebody else, a conduct flag if there is one, your membership
                records and the lines naming you on a Students&apos; Union
                membership file, and your sign-in record. Your marks and the
                notes about you are stripped out of attendance registers, which
                stay for the rest of the group.
              </p>
              <p>
                <strong>What a deletion leaves behind.</strong> These are not
                removed:
              </p>
              <ul>
                <li>
                  A short record of each application you made: what you applied
                  for, the decision, and the scores and notes the reviewers
                  wrote. We keep it deliberately, so that a later application
                  from the same person can be read in context. The reviewers&apos;
                  scores and notes about an application stay in that record
                  after the account is deleted.
                </li>
                <li>
                  Worksheets that were sent to you: your answers, and the
                  reviews written on them.
                </li>
                <li>
                  Tasks you were on, with their comments, activity and
                  attachments.
                </li>
                <li>
                  Event RSVPs, including the name, email address and any
                  dietary or accessibility answers you gave when you signed up.
                </li>
                <li>
                  Files you uploaded. Nothing in file storage is removed by an
                  account deletion.
                </li>
                <li>
                  The push notification record for any device you turned
                  notifications on for. Ask us and we will remove it.
                </li>
                <li>
                  The log of emails we sent you, and a suppression entry if
                  your address ever bounced or reported us as spam, kept so we
                  do not write to it again by mistake.
                </li>
                <li>The audit-style records described below.</li>
              </ul>
              <p>
                Some of what you contributed stays after your account goes,
                because removing it would break work other people are still
                doing. We remove it when we clear it out by hand, and you can
                ask us to remove specific items sooner.
              </p>
              <p>
                Audit-style records are kept for as long as needed to
                investigate issues and meet our accountability obligations, and
                are not removed when an account is deleted. These are records
                of what staff did rather than of what you wrote: the email send
                log, the subscription event log, the impersonation log used for
                committee oversight, the log of course actions including who
                read an access-requirements answer, and the record of the two
                downloads the site logs. They name the person who took the
                action and what it concerned, and hold no course answers, marks
                or notes.
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
                <a href="/profile">your profile page</a>, and unsubscribe from
                any email through the link in that email. Deleting your account
                is by request: email{" "}
                <a href="mailto:ai-safety@uonsu.com">ai-safety@uonsu.com</a>{" "}
                and we will delete it. There is no delete button on the site,
                because removing a member&apos;s work from the committee tooling
                is done by hand.
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
                recognised, and by admins, and by the small number of people we
                have given permission to circulate a worksheet, who can see
                members&apos; names and photos in order to choose recipients.
                Ordinary members can only see their own record and the tasks
                they have been added to. Course
                material about a named person (applications, access
                requirements, registers, participant notes) is served only
                through checks on our servers, never handed to a browser that
                has no reason for it. Email is signed with DKIM and aligned
                with DMARC on the <code>naisi.uk</code> domain.
              </p>
              <p>
                Site admins can open the site as you see it, to reproduce a
                problem you have reported. Doing so does not give them anything
                they could not already see, they cannot use it to make
                high-trust changes, and every session is logged with who did
                it, whose account, and when.
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
                active members know by email. If you decline, you are signed
                out, and you can then email us to have the account removed.
                Earlier versions stay readable at{" "}
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
